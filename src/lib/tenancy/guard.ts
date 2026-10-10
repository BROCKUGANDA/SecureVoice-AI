import "server-only";
/**
 * Tenancy guard (WP-12) — org isolation enforced in ONE place.
 *
 * The problem this exists to kill: tenancy expressed as `where: { orgId }` typed
 * at every call site. Scattered predicates fail the only way scattered code can
 * fail — silently. A new read path simply omits the clause, returns every
 * tenant's rows, and no type, lint rule or test notices until a bank's customer
 * sees another bank's case.
 *
 * So the scope stops being a clause and becomes a capability:
 *
 *   1. `TENANTED_MODELS` / `PLATFORM_MODELS` — every model in the schema is
 *      declared exactly once. A model in neither is an ERROR, not a silent
 *      pass: adding a table to schema.prisma forces a tenancy decision here
 *      before any code can read it.
 *   2. `scopedDb(scope)` — a client whose delegate methods inject the org
 *      predicate into `where` (and `orgId` into `data` on a write). A caller
 *      cannot forget the scope because they never type it.
 *   3. `assertScoped(model, where)` — the same check as a free function, for
 *      auditing a predicate that already exists (raw SQL, an existing
 *      `db.case.findMany({ where })`, the isolation matrix).
 *   4. Every failure is a `TenancyScopeError` that NAMES THE MODEL. "An error
 *      happened" is not actionable at 3am; `TenancyScopeError: Case.findMany
 *      has no org predicate` is.
 *
 * ── Fail-closed, by construction ────────────────────────────────────────────
 *   · No scope              → throws (`invalid_scope`); there is no "default
 *                             everything" mode.
 *   · Unregistered model    → throws (`unregistered_model`).
 *   · Cross-org in `where`  → throws (`cross_org_request`) rather than quietly
 *                             returning nothing, because "I asked for the wrong
 *                             tenant" is a bug, not a permission denial.
 *   · `$queryRaw`           → OUTSIDE the guard. Prisma's model layer cannot see
 *                             a hand-written predicate. Every raw read must be
 *                             declared in the isolation matrix
 *                             (`src/lib/tenancy/isolation-matrix.ts`).
 *   · `$transaction`        → the callback client is guarded too: the extension
 *                             re-applies itself to the transaction client, so
 *                             `scopedDb(org).$transaction(cb)` cannot walk out
 *                             of the tenant. `inScopeTransaction()` is the
 *                             form that makes the scope explicit at the call
 *                             site.
 *
 * ── The shared namespace ────────────────────────────────────────────────────
 * A session with no active organization is the default state of the reference
 * deployment. It is NOT "sees everything": it shares the un-namespaced rows
 * (`orgId IS NULL`, e.g. seeded demo data) plus the literal `"default"`
 * namespace. Passing `null` to `scopedDb()` throws — you must say "shared" out
 * loud, because the difference between "no org" and "all orgs" is the whole
 * point.
 *
 * ── TENANCY_BYPASS ──────────────────────────────────────────────────────────
 * The escape hatch, for genuinely GLOBAL models only (`PilotRequest` — a public
 * website lead has no organization until it is onboarded). It is a frozen
 * object, it records every use in memory, and it REFUSES any model in
 * `TENANTED_MODELS`: there is no reason string that unlocks a tenant model.
 * `tenancyBypassLog()` is asserted by the isolation gate, so "someone bypassed
 * the guard" is a test failure, not a code review question.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { db } from "@/lib/db";

// ── Registries ───────────────────────────────────────────────────────────────

/** The column every tenant model is partitioned by. */
export const ORG_FIELD = "orgId";

/** The literal namespace an org-less session shares with seeded demo rows. */
export const DEFAULT_ORG_ID = "default";

/**
 * Models that carry `orgId` and MUST be read through a scope. Adding a model
 * here is a promise; the isolation gate requires a matrix entry for each one.
 */
export const TENANTED_MODELS = [
  "Case",
  "AuditLog",
  "Customer",
  "ProducerKey",
  "UserProfile",
  "Notification",
  "OutboxEvent",
  "UsageLedger",
  "PaymentRecord",
  // Paddle billing mirror. Same rule as PaymentRecord: a payment or subscription
  // row belonging to another org is the worst possible leak, and `reference` /
  // `customerId` being globally UNIQUE means an unscoped read resolves anyone's.
  "PaddleCustomer",
  "PaddleSubscription",
] as const;

export type TenantedModel = (typeof TENANTED_MODELS)[number];

export type PlatformModelDeclaration = {
  /** Why this model carries no `orgId`. Read this before "fixing" it. */
  readonly reason: string;
};

/**
 * Models that are structurally global. Every one of them is a DELIBERATE
 * decision with a stated reason — that reason is the tenancy review.
 *
 * A model in neither registry is unreachable through `scopedDb()`: the guard
 * throws `unregistered_model` rather than guessing.
 */
export const PLATFORM_MODELS: Readonly<Record<string, PlatformModelDeclaration>> = Object.freeze({
  PilotRequest: {
    reason:
      "Public-site lead captured before an organization exists. Scoping it by org would be a guess; the ops-only triage read goes through TENANCY_BYPASS.",
  },
  IdempotencyKey: {
    reason:
      "Dedupe store keyed by (scope, sha256(payload), callerId) — the caller IS the partition, and a replay must resolve identically for the same caller.",
  },
  Voice: {
    reason:
      "Platform voice catalogue shared by every tenant (BYOK keys select from it); the per-tenant secret is UserProfile.elevenKeyEnc, not the voice row.",
  },
  Account: {
    reason:
      "Legacy local platform accounts (operator/demo) superseded by Better Auth + UserProfile; no tenant data on the row.",
  },
  User: {
    reason:
      "Legacy pre-Better-Auth identity table, unreferenced by the request path; retained for migration only.",
  },
  WebhookEvent: {
    reason:
      "Inbound provider delivery registry, deduped on (provider, eventType, conversationId, eventTimestamp) — a provider event belongs to no org until correlated to a Case.",
  },
  WebhookQuarantine: {
    reason:
      "Uncorrelatable inbound events by definition: quarantined precisely BECAUSE no Case (and therefore no org) could be established.",
  },
  DeadLetter: {
    reason:
      "Replay queue keyed by OutboxEvent.id. The org lives on the OutboxEvent row; DeadLetter stores only the failed payload for operator replay.",
  },
  DialJob: {
    reason:
      "The dial queue. It carries NO orgId column: prisma/schema.prisma declares no DialJob model at all, the generated client's DialJobSelect has no orgId, and information_schema confirms the `\"DialJob\"` table has none. (`dial_job`, snake_case, is a different table carrying org_id; src/lib/scale/queue.ts drives it with raw SQL and never goes through Prisma.) Registering it as a TENANT model would make the guard inject an orgId predicate that Prisma rejects at query time, and the model's absence from schema.prisma means the $extends hook would never even fire for it. The org is recoverable by joining caseRef to the Case row, and a worker legitimately claims across ALL orgs — exactly like lib.outbox.claim-batch — so a request-scoped scope is the wrong abstraction.",
  },
  InboundBankEvent: {
    reason:
      "Operator-facing delivery inspector (the /inspector surface); shows a bank what we sent them, scoped by deployment access, not by tenant.",
  },
});

// ── Typed failure ────────────────────────────────────────────────────────────

export type TenancyFailureReason =
  /** The scope argument was not one of the two legal shapes. */
  | "invalid_scope"
  /** The model is in neither TENANTED_MODELS nor PLATFORM_MODELS. */
  | "unregistered_model"
  /** A `where` predicate reached a tenant model with no org clause. */
  | "missing_org_predicate"
  /** The caller asked for a different org than the one it is scoped to. */
  | "cross_org_request"
  /** The operation cannot be tenant-scoped by construction. */
  | "untenanted_operation"
  /** A write tried to set `orgId` to an org other than the scope's. */
  | "org_mismatch_on_write"
  /** A TENANCY_BYPASS was attempted against a tenant model. */
  | "bypass_refused";

/**
 * The only error this module throws. It names the model and the operation
 * because the person who has to fix it is looking at a stack trace, not at
 * this file.
 */
export class TenancyScopeError extends Error {
  readonly reason: TenancyFailureReason;
  readonly model: string;
  readonly operation: string | null;

  constructor(
    reason: TenancyFailureReason,
    model: string,
    message: string,
    operation: string | null = null,
  ) {
    super(`[tenancy:${reason}] ${model}${operation ? `.${operation}` : ""} — ${message}`);
    this.name = "TenancyScopeError";
    this.reason = reason;
    this.model = model;
    this.operation = operation;
  }
}

export function isTenancyScopeError(value: unknown): value is TenancyScopeError {
  return value instanceof TenancyScopeError;
}

// ── Scope ────────────────────────────────────────────────────────────────────

/**
 * A scope is one of exactly two things, and the caller has to say which:
 *   `{ orgId }`     — this tenant, and nothing else.
 *   `{ shared: true }` — the un-namespaced/default namespace ONLY.
 */
export type OrgScope = { orgId: string } | { shared: true };

/**
 * The one place a session's org becomes a scope. An absent org maps to the
 * shared namespace — never to "all orgs" — mirroring the console routes.
 */
export function orgScopeFor(orgId: string | null | undefined): OrgScope {
  return orgId ? { orgId } : { shared: true };
}

/** Normalise + validate a scope at runtime (the type system is not enough). */
export function assertScope(scope: unknown, model = "scope"): OrgScope {
  if (scope && typeof scope === "object") {
    if ("shared" in scope && (scope as { shared?: unknown }).shared === true)
      return { shared: true };
    const orgId = (scope as { orgId?: unknown }).orgId;
    if (typeof orgId === "string" && orgId.trim().length > 0) return { orgId };
  }
  throw new TenancyScopeError(
    "invalid_scope",
    model,
    "expected { orgId: string } or { shared: true }. Build one with orgScopeFor(orgId) — a bare null/undefined is refused so 'no org' can never mean 'all orgs'.",
  );
}

export function scopeKey(scope: OrgScope): string {
  return "orgId" in scope ? `org:${scope.orgId}` : "shared";
}

/**
 * Strict entry-point coercion: a bare string is an ORG ID and nothing else.
 *
 * `orgScopeFor("")` deliberately means the shared namespace (it takes a raw
 * session value), but a guard that treated `""` as "shared" would fail OPEN on
 * a missing org — exactly the confusion this module exists to remove. A string
 * reaching the guard must name an org.
 */
function scopeFromArg(scope: OrgScope | string): OrgScope {
  if (typeof scope === "string") return assertScope({ orgId: scope }, "scope");
  return assertScope(scope);
}

/** The injected Prisma predicate for a scope. */
export function scopeWhere(scope: OrgScope): Record<string, unknown> {
  // Prisma's `in` filter rejects null members, so the shared namespace is an OR
  // — identical to the rule the console routes already apply by hand.
  return "orgId" in scope
    ? { orgId: scope.orgId }
    : { OR: [{ orgId: null }, { orgId: DEFAULT_ORG_ID }] };
}

// ── Predicate inspection ─────────────────────────────────────────────────────

/**
 * True when a `where` clause constrains the org column at all — at any depth,
 * through AND/OR/NOT. A predicate that mentions `orgId` only inside a nested
 * relation's filter does NOT count: that filters a child row, not the tenant.
 */
export function hasOrgPredicate(where: unknown, depth = 0): boolean {
  if (!where || typeof where !== "object" || Array.isArray(where) || depth > 8) return false;
  const obj = where as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, ORG_FIELD)) return true;
  for (const key of ["AND", "OR", "NOT"] as const) {
    const branch = obj[key];
    if (Array.isArray(branch)) {
      if (branch.some((b) => hasOrgPredicate(b, depth + 1))) return true;
    } else if (hasOrgPredicate(branch, depth + 1)) {
      return true;
    }
  }
  return false;
}

/** The org a predicate pins, when it pins exactly one. */
function pinnedOrgId(where: unknown): string | null | undefined {
  if (!where || typeof where !== "object" || Array.isArray(where)) return undefined;
  const raw = (where as Record<string, unknown>)[ORG_FIELD];
  if (raw === null) return null;
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Free-function form of the guard: throw unless `where` is org-constrained.
 * Use it to audit a predicate that already exists — including one you are about
 * to migrate onto `scopedDb`.
 *
 * @throws TenancyScopeError naming `model` and the failing `operation`.
 */
export function assertScoped(
  model: string,
  where: unknown,
  opts: { operation?: string; scope?: OrgScope } = {},
): void {
  if (!isTenantedModel(model)) {
    throw new TenancyScopeError(
      "unregistered_model",
      model,
      isPlatformModel(model)
        ? "carries no orgId by design — read it through TENANCY_BYPASS, not an org scope"
        : "declare it in TENANTED_MODELS or PLATFORM_MODELS before reading it",
      opts.operation ?? null,
    );
  }
  if (!hasOrgPredicate(where)) {
    throw new TenancyScopeError(
      "missing_org_predicate",
      model,
      `no \`${ORG_FIELD}\` predicate in \`where\`. Use scopedDb(scope).${lowerFirst(model)}.*, which injects it.`,
      opts.operation ?? null,
    );
  }
  if (opts.scope) {
    const scope = assertScope(opts.scope, model);
    const pinned = pinnedOrgId(where);
    if (pinned !== undefined) {
      const allowed = "orgId" in scope ? [scope.orgId] : [null, DEFAULT_ORG_ID];
      if (!allowed.includes(pinned)) {
        throw new TenancyScopeError(
          "cross_org_request",
          model,
          `\`where.${ORG_FIELD} = ${JSON.stringify(pinned)}\` is outside the active scope (${scopeKey(scope)})`,
          opts.operation ?? null,
        );
      }
    }
  }
}

export function isTenantedModel(model: string): model is TenantedModel {
  return (TENANTED_MODELS as readonly string[]).includes(model);
}

export function isPlatformModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLATFORM_MODELS, model);
}

function lowerFirst(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

// ── The scoped client ────────────────────────────────────────────────────────

/** Operations whose `args` carries a `where` the guard must extend. */
const WHERE_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "upsert",
  "count",
  "aggregate",
  "groupBy",
]);

/** Operations whose `args` carries `data`/`create` the guard must stamp. */
const CREATE_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn"]);

const TENANCY_EXTENSION = "sv-tenancy";

/**
 * Apply the guard to a client. Exported for `inScopeTransaction` (a transaction
 * client is a fresh client and must be re-armed) and for tests.
 */
export function applyTenancy(client: PrismaClient, scopeInput: OrgScope | string): PrismaClient {
  const scope = scopeFromArg(scopeInput);
  const predicate = scopeWhere(scope);
  const legalOrgs = "orgId" in scope ? [scope.orgId] : [null, DEFAULT_ORG_ID];

  const guardWhere = (
    model: string,
    operation: string,
    where: unknown,
  ): Record<string, unknown> => {
    const caller = (
      where && typeof where === "object" && !Array.isArray(where)
        ? (where as Record<string, unknown>)
        : {}
    ) as Record<string, unknown>;
    if (where !== undefined && (!where || typeof where !== "object" || Array.isArray(where))) {
      throw new TenancyScopeError(
        "missing_org_predicate",
        model,
        "`where` must be an object so the org predicate can be combined with it",
        operation,
      );
    }
    // Asking for a different org than the one you are scoped to is a bug, and a
    // silent empty result would hide it for a quarter.
    const pinned = pinnedOrgId(caller);
    if (pinned !== undefined && !legalOrgs.includes(pinned)) {
      throw new TenancyScopeError(
        "cross_org_request",
        model,
        `requested ${ORG_FIELD}=${JSON.stringify(pinned)} while scoped to ${scopeKey(scope)}`,
        operation,
      );
    }
    // `AND` rather than a top-level key: it composes with any caller predicate
    // and is accepted by both XWhereInput and XWhereUniqueInput.
    return { AND: [caller, predicate] };
  };

  const stampOrg = (
    model: string,
    operation: string,
    data: Record<string, unknown> | undefined,
  ): Record<string, unknown> => {
    const payload = { ...(data ?? {}) };
    const explicit = payload[ORG_FIELD];
    if (explicit !== undefined && !legalOrgs.includes(explicit as string | null)) {
      throw new TenancyScopeError(
        "org_mismatch_on_write",
        model,
        `\`${ORG_FIELD}\`=${JSON.stringify(explicit)} contradicts the active scope (${scopeKey(scope)})`,
        operation,
      );
    }
    return { ...payload, [ORG_FIELD]: "orgId" in scope ? scope.orgId : null };
  };

  return client.$extends({
    name: TENANCY_EXTENSION,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          if (isPlatformModel(model)) return query(args);
          if (!isTenantedModel(model)) {
            throw new TenancyScopeError(
              "unregistered_model",
              model,
              "declare it in TENANTED_MODELS or PLATFORM_MODELS before reading it",
              operation,
            );
          }

          if (WHERE_OPERATIONS.has(operation)) {
            const where = guardWhere(model, operation, args?.where);
            if (operation === "upsert") {
              // A cross-tenant upsert must not even reach the write half.
              return query({
                ...args,
                where,
                create: { ...args.create, ...stampOrg(model, operation, args.create) },
                update: assertScopedUpdate(model, operation, args.update, legalOrgs),
              });
            }
            return query({ ...args, where });
          }

          if (CREATE_OPERATIONS.has(operation)) {
            if (Array.isArray(args?.data)) {
              return query({
                ...args,
                data: args.data.map((d: any) => stampOrg(model, operation, d)),
              });
            }
            return query({ ...args, data: stampOrg(model, operation, args?.data) });
          }

          throw new TenancyScopeError(
            "untenanted_operation",
            model,
            `operation \`${operation}\` has no org-scoped form; add one to the guard or declare the model platform`,
            operation,
          );
        },
      },
    },
    // An identity `client` extension is what makes the query guard apply to
    // transaction clients too: Prisma runs this for the `tx` handed to a
    // `$transaction` callback, and the query extension above is re-applied to
    // it. Without it, `scopedDb(org).$transaction(cb)` would hand `cb` an
    // UNSCOPED client — a hole big enough to walk straight out of the tenant.
    client: ((tx: unknown) => tx) as never,
  }) as unknown as PrismaClient;
}

/** An update may touch its own org's row; it may not re-point it at another. */
function assertScopedUpdate(
  model: string,
  operation: string,
  update: unknown,
  legalOrgs: readonly (string | null)[],
): Record<string, unknown> {
  const data = (
    update && typeof update === "object" ? (update as Record<string, unknown>) : {}
  ) as Record<string, unknown>;
  const next = data[ORG_FIELD];
  if (next !== undefined && !legalOrgs.includes(next as string | null)) {
    throw new TenancyScopeError(
      "org_mismatch_on_write",
      model,
      `update re-points ${ORG_FIELD} to ${JSON.stringify(next)}, outside the active scope`,
      operation,
    );
  }
  return data;
}

// Extended clients are structurally Prisma clients; the injection is a runtime
// guarantee, not a type-level one, so the declared type stays PrismaClient.
const SCOPED_CACHE_MAX = 64;
const scopedCache = new Map<string, PrismaClient>();

/**
 * The sanctioned way to read or write tenant data.
 *
 *   const sdb = scopedDb(orgScopeFor(profile.orgId));
 *   const mine = await sdb.case.findMany({ where: { state: "DIALING" } }); // org predicate injected
 *
 * `orgScopeFor()` is the normal constructor; a bare non-empty org-id string also
 * works. A bare `null`, `undefined` or `""` throws — say `{ shared: true }`
 * instead, out loud. (Note `orgScopeFor("")` maps to the shared namespace
 * because it takes a raw session value; the guard entry point does not, so a
 * missing org can never fail open here.)
 *
 * `scopedDb(scope).$transaction(cb)` hands `cb` a guarded client; prefer
 * `inScopeTransaction(scope, cb)` where the scope should be visible at the call
 * site.
 */
export function scopedDb(scope: OrgScope | string, base: PrismaClient = db): PrismaClient {
  const resolved = scopeFromArg(scope);
  const key = scopeKey(resolved);
  // Cache per (base, scope): a server process would otherwise rebuild an
  // extension per request. Bounded, oldest-evicted, because org count is
  // unbounded in the general case.
  const cacheKey = `${TENANCY_EXTENSION}:${key}`;
  const hit = scopedCache.get(cacheKey);
  if (hit) return hit;
  if (scopedCache.size >= SCOPED_CACHE_MAX) {
    const oldest = scopedCache.keys().next();
    if (!oldest.done) scopedCache.delete(oldest.value);
  }
  const client = applyTenancy(base, resolved);
  scopedCache.set(cacheKey, client);
  return client;
}

/**
 * A transaction whose callback client is guarded.
 *
 * `scopedDb(scope).$transaction(cb)` is already safe — the extension's identity
 * `client` hook re-applies the query guard to the transaction client. This
 * helper exists for the type: it takes the scope as a required argument, so the
 * scope is visible at the call site rather than inherited from a variable
 * someone might rebind.
 */
export function inScopeTransaction<T>(
  scope: OrgScope | string,
  fn: (tx: PrismaClient) => Promise<T>,
  base: PrismaClient = db,
): Promise<T> {
  return scopedDb(scope, base).$transaction((tx) => fn(tx as unknown as PrismaClient));
}

// ── TENANCY_BYPASS ───────────────────────────────────────────────────────────

export type BypassRecord = {
  readonly model: string;
  readonly reason: string;
  readonly at: string;
};

const bypassLog: BypassRecord[] = [];
const BYPASS_LOG_MAX = 500;

function recordBypass(model: string, reason: string): void {
  if (bypassLog.length >= BYPASS_LOG_MAX) bypassLog.shift();
  bypassLog.push({ model, reason, at: new Date().toISOString() });
}

/**
 * The escape hatch — PLATFORM MODELS ONLY.
 *
 * It cannot reach a tenant model, whatever reason you give: a fraud case is
 * never a "global" read, and a reason string is not a security boundary. Every
 * use is recorded so the isolation gate can assert that nothing in
 * `TENANTED_MODELS` was ever bypassed.
 */
export const TENANCY_BYPASS = Object.freeze({
  /** The models that may be read without a scope, and why. */
  globalModels: PLATFORM_MODELS,

  /**
   * The raw client, for a declared global model.
   * @throws TenancyScopeError `bypass_refused` for any tenant model.
   */
  client<K extends string>(model: K, reason: string): PrismaClient {
    if (!isPlatformModel(model)) {
      throw new TenancyScopeError(
        "bypass_refused",
        model,
        isTenantedModel(model)
          ? "tenant models are never bypassable — use scopedDb(scope) and scope the predicate"
          : "declare the model in PLATFORM_MODELS (with a reason) before bypassing",
      );
    }
    if (!reason || reason.trim().length < 8) {
      throw new TenancyScopeError(
        "bypass_refused",
        model,
        "a bypass needs a written reason of at least 8 characters; it is stored in the bypass log",
      );
    }
    recordBypass(model, reason);
    return db;
  },

  /** Run a function against the raw client for a declared global model. */
  async run<T>(model: string, reason: string, fn: (raw: PrismaClient) => Promise<T>): Promise<T> {
    const raw = TENANCY_BYPASS.client(model, reason);
    return fn(raw);
  },

  /** Every bypass taken in this process, oldest first. */
  log(): readonly BypassRecord[] {
    return [...bypassLog];
  },

  /** Test hook. */
  reset(): void {
    bypassLog.length = 0;
  },
});
