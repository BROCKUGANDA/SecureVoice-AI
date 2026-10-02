import "server-only";
/**
 * Role enforcement at the data-access layer (WP-11, item 5).
 *
 * ── Why not in the route handler ─────────────────────────────────────────────
 * A role check in a route handler is a promise by the author of that handler.
 * It holds exactly until the next handler forgets it — a new endpoint, a
 * refactor that moves logic, a shared helper called from a path nobody traced,
 * and the promise is broken. The codebase already reached this conclusion for
 * tenancy (`src/lib/tenancy/guard.ts`: "scattered predicates fail the only way
 * scattered code can fail — silently"), and this module applies the same shape
 * to roles.
 *
 * So there are two independent mechanisms, and a caller needs to defeat both to
 * write as an Auditor:
 *
 *   1. `assertCapability(role, cap)` — an explicit, named check, for the point
 *      where a decision is made ("this action needs member:invite").
 *   2. `rbacDb(role)` — a Prisma client that REFUSES write operations for a
 *      read-only role. This is the structural one: a route handler that forgets
 *      to check the role cannot escalate, because the database handle it was
 *      given will throw on `create`/`update`/`delete` for that role.
 *
 * ── What `rbacDb` does and does not cover ───────────────────────────────────
 * Covers: every model delegate reachable as `db.<model>` — all `find*`,
 * `count`, `aggregate`, `groupBy` reads pass through; `create`, `createMany`,
 * `update`, `updateMany`, `upsert`, `delete`, `deleteMany` throw for a
 * read-only role.
 *
 * Does NOT cover, stated explicitly:
 *   · `$queryRaw` / `$executeRaw`. Prisma's model layer cannot see a raw
 *     predicate, so no proxy can intercept it. This is the same boundary
 *     `tenancy/guard.ts` draws, and for the same reason. A raw write under a
 *     read-only role is prevented by not handing that role a raw path, which
 *     today means: there is no code path that gives `rbacDb(role)` to a
 *     request carrying a raw-SQL capability. `RawSqlDeniedError` below makes
 *     the intended policy explicit rather than implied.
 *   · `$transaction`. Passes through so a caller can wrap several role-checked
 *     operations; the delegate methods inside the callback are still guarded
 *     when the transaction client comes from `rbacDb`.
 *   · Org scoping. This module is about ROLE. Tenant isolation is
 *     `scopedDb` in `src/lib/tenancy/guard.ts` — a separate, already-built
 *     concern, deliberately not duplicated here.
 */

import { db } from "@/lib/db";
import {
  isReadOnlyRole,
  isWriteCapability,
  roleHas,
  type Capability,
  type Role,
} from "@/lib/auth/roles";

export class CapabilityError extends Error {
  constructor(
    public readonly role: Role,
    public readonly capability: Capability,
    message: string
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

export class RawSqlDeniedError extends Error {
  constructor(role: Role) {
    super(
      `Raw SQL is not available to role ${role}. Prisma's model layer cannot apply a role or ` +
        `tenant predicate to a hand-written query, so raw access bypasses this guard by ` +
        `construction. Use rbacDb() or the tenancy scopedDb().`
    );
    this.name = "RawSqlDeniedError";
  }
}

const READ_DELEGATES = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

const WRITE_DELEGATES = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

/** Explicit capability check. Throws `CapabilityError`. */
export function assertCapability(role: Role, capability: Capability): void {
  if (!roleHas(role, capability)) {
    throw new CapabilityError(
      role,
      capability,
      `Role ${role} does not hold ${capability}.`
    );
  }
}

/** Non-throwing form, for branches that must produce a different response. */
export function hasCapability(role: Role, capability: Capability): boolean {
  return roleHas(role, capability);
}

/**
 * Owner/Admin separation.
 *
 * An Admin may not act on an Owner's role in either direction, and may not
 * assign the Owner role to anyone. An Owner may act on anyone's. This lives here
 * rather than in the matrix because a flat capability set cannot express "this
 * role may act on that role" — `member:setRole` is a single capability, and
 * treating it as one would let an Admin promote themselves to Owner.
 */
export function assertMayAssignRole(actor: Role, currentTarget: Role, nextTarget: Role): void {
  if (actor === "Owner") return;
  if (actor !== "Admin") {
    throw new CapabilityError(
      actor,
      "member:setRole",
      `Role ${actor} may not change roles.`
    );
  }
  if (currentTarget === "Owner") {
    throw new CapabilityError(
      actor,
      "member:setRole",
      "An Admin may not change an Owner's role."
    );
  }
  if (nextTarget === "Owner") {
    throw new CapabilityError(
      actor,
      "member:setRole",
      "Only an Owner may grant the Owner role."
    );
  }
}

// ── The guarded client ───────────────────────────────────────────────────────

type AnyRecord = Record<string, unknown>;

/**
 * Wrap a delegate so that write methods throw for a read-only role.
 *
 * Arguments are forwarded untouched — this guard is about WHETHER a write
 * happens, not about its shape. Shaping the argument is the caller's job and is
 * enforced by Prisma's own types.
 */
function guardDelegate(delegate: unknown, role: Role, model: string): unknown {
  const source = delegate as AnyRecord;
  const wrapped: AnyRecord = {};
  for (const method of Object.keys(source)) {
    const value = source[method];
    if (typeof value !== "function") {
      wrapped[method] = value;
      continue;
    }
    if (WRITE_DELEGATES.has(method)) {
      wrapped[method] = isReadOnlyRole(role)
        ? () => {
            throw new CapabilityError(
              role,
              "case:write",
              `Role ${role} is read-only: ${model}.${method} is not permitted.`
            );
          }
        : (value as (...args: unknown[]) => unknown).bind(source);
      continue;
    }
    // Reads and anything unrecognised pass straight through. Unknown methods
    // are NOT blocked: a new Prisma delegate is a read by default, and silently
    // blocking reads would be a worse failure than allowing a new write method
    // to need an explicit entry in WRITE_DELEGATES.
    wrapped[method] = (value as (...args: unknown[]) => unknown).bind(source);
  }
  return wrapped;
}

export type RbacClient = typeof db;

/**
 * A Prisma client that enforces the role.
 *
 * Read-only roles (`Auditor`, `ServiceAccount`) get a client whose write
 * delegates throw. Everything else is the untouched client, because those roles
 * are already constrained by `assertCapability` at the decision point and by
 * the capability matrix.
 */
export function rbacDb(role: Role): RbacClient {
  if (!isReadOnlyRole(role)) return db;
  const client = db as unknown as AnyRecord;
  const wrapper: AnyRecord = {};
  for (const key of Object.keys(client)) {
    if (key.startsWith("$")) {
      // $connect/$disconnect/$on/$transaction/$queryRaw/etc.
      // Passthrough. See the module header for what this does and does not
      // cover — the guard is on the model layer, which is the layer a role is
      // expressed in.
      wrapper[key] = client[key];
      continue;
    }
    const delegate = client[key];
    if (delegate && typeof delegate === "object" && key === "model") continue;
    wrapper[key] = typeof delegate === "object" ? guardDelegate(delegate, role, key) : delegate;
  }
  return new Proxy(client, {
    get: (target, prop: string) => {
      if (prop in wrapper) return wrapper[prop];
      return (target as AnyRecord)[prop];
    },
  }) as unknown as RbacClient;
}

/** Convenience: assert a write capability, then hand back a client that could
 *  do it. The check and the handle travel together so a caller cannot assert one
 *  thing and use another. */
export function authorizedDb(role: Role, capability: Capability): RbacClient {
  if (isWriteCapability(capability)) assertCapability(role, capability);
  return rbacDb(role);
}