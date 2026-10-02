import "server-only";
/**
 * Auth state store (WP-11) — persistence WITHOUT a schema migration.
 *
 * ── Why this file exists in this shape ──────────────────────────────────────
 * WP-11 is not permitted to touch `prisma/schema.prisma` or run
 * `prisma db push`. Sessions, invites, magic links, step-up grants and
 * revocation epochs all need durable, TTL'd, atomically-consumable rows, and
 * there is no table for them.
 *
 * Rather than invent an in-process `Map` — which would make every control in
 * this package evaporate on restart, on deploy, and on any second replica, and
 * would make "two concurrent uses of the same invite produce exactly one
 * winner" a claim about one process's event loop instead of about the system —
 * this reuses `IdempotencyKey` as the generic key/value store it already is:
 *
 *     scope      + key       + callerId   unique  → namespaced key
 *     response               (String)      → JSON payload
 *     expiresAt                            → TTL
 *
 * `IdempotencyKey` is already declared as a PLATFORM_MODEL in
 * `src/lib/tenancy/guard.ts` (the caller IS the partition, and a replay must
 * resolve identically for the same caller) — the same property auth state
 * needs. Auth state lands in its own reserved scope namespaces
 * (`sv.auth.*`), so it can never collide with a payload-dedupe key.
 *
 * ── What this costs, stated plainly ──────────────────────────────────────────
 *   1. `IdempotencyKey` rows are evicted at boot when `expiresAt <= now` (see
 *      src/lib/db.ts). Auth rows expire by design, so that is aligned — but it
 *      means a long-dead session's row is indistinguishable from one that never
 *      existed. Acceptable: the audit chain holds the history.
 *   2. Sessions are read-modify-write on `lastSeenAt`. Two concurrent requests
 *      on one session can interleave; the loser's write is a stale timestamp.
 *      It is bounded by a single request's duration, so it can move
 *      `lastSeenAt` BACKWARDS by at most that. Mitigation below: a write is
 *      only issued when it would move `lastSeenAt` forward, so the value is
 *      monotonically non-decreasing in practice.
 *   3. When a migration IS permitted, `Session` / `Invite` / `StepUpGrant`
 *      tables are the right answer and this file should be deleted, not
 *      wrapped in more layers. The interface below is deliberately small so
 *      that swap is mechanical.
 *
 * ── Atomicity ───────────────────────────────────────────────────────────────
 * `take()` is the primitive that makes "exactly one winner" true. It INSERTs,
 * relying on the `@@unique([scope, key, callerId])` index to arbitrate: the
 * database, not this process, decides the winner. That is a real guarantee
 * across processes and replicas, which a check-then-write in JavaScript is not.
 */

import { db } from "@/lib/db";

/** Reserved scope namespaces. Auth state never shares a namespace with a
 *  payload-dedupe key, so no code path outside src/lib/auth can collide. */
export const AUTH_SCOPES = {
  session: "sv.auth.session",
  invite: "sv.auth.invite",
  /** The atomic consumption marker. One row per invite, ever. */
  inviteConsumed: "sv.auth.invite.consumed",
  identity: "sv.auth.identity",
  magicLink: "sv.auth.magiclink",
  /** The atomic consumption marker for a magic link. Separate from the token
   *  row itself: the token row records expiry and the bound address, the marker
   *  records that it was spent. Conflating them would mean redeeming is a
   *  no-op, because the token row is already there from issuance. */
  magicLinkConsumed: "sv.auth.magiclink.consumed",
  stepUp: "sv.auth.stepup",
} as const;

export type AuthScope = (typeof AUTH_SCOPES)[keyof typeof AUTH_SCOPES];

/**
 * Expiry for PERMANENT records — the member list, not a session.
 *
 * A real date rather than `Infinity`: this column is a Postgres `timestamp`,
 * and an out-of-range value is rejected by Prisma before it reaches the driver.
 * 2999 is comfortably inside Postgres' own maximum (294276) and inside the JS
 * `Date` range, so it is genuinely "not going to expire during this deployment's
 * life" without being a value the database refuses.
 */
export const PERMANENT_EXPIRY = new Date("2999-12-31T00:00:00.000Z");

/** Postgres unique-violation. Prisma's documented code for it. */
const UNIQUE_VIOLATION = "P2002";

/**
 * Is this the unique-index conflict we expect?
 *
 * Deliberately STRUCTURAL rather than `err instanceof PrismaClientKnownRequestError`.
 * Under Prisma 7 the generated client's re-exported `Prisma` namespace and the
 * class the runtime actually throws are not guaranteed to be the same object —
 * `instanceof` silently returns false across that boundary, which would turn
 * "I lost the race" into an unhandled throw and, worse, could make the winner's
 * caller see a 500. Checking the documented `code` plus the error's own name is
 * version-independent: the same code means the same thing in every Prisma
 * version, and this control must not depend on the ORM's module layout.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { code?: unknown; name?: unknown; meta?: unknown };
  if (candidate.code === UNIQUE_VIOLATION) return true;
  // Belt and braces: some transports report the driver error with a different
  // code but the same constraint name in the message.
  return (
    typeof candidate.name === "string" &&
    candidate.name.includes("UniqueConstraint") &&
    candidate.meta !== undefined
  );
}

function composite(scope: string, key: string, callerId: string) {
  return { scope_key_callerId: { scope, key, callerId } };
}

/**
 * Defensive normalisation. These strings become part of a unique index and are
 * echoed into audit rows; an unbounded caller-supplied value would let one
 * request bloat the table. Silently truncating is deliberate — auth state keys
 * are server-generated, so a long value is a bug elsewhere, and refusing the
 * request here would turn that bug into an outage.
 */
function norm(v: string, max: number): string {
  return v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max);
}

function scoped(scope: string, key: string, callerId: string) {
  return {
    scope: norm(scope, 64),
    key: norm(key, 128),
    callerId: norm(callerId, 64),
  };
}

/** Write (insert-or-replace) a record. `expiresAt` is the TTL ceiling. */
export async function put<T>(
  scope: string,
  key: string,
  callerId: string,
  value: T,
  expiresAt: Date
): Promise<void> {
  const s = scoped(scope, key, callerId);
  await db.idempotencyKey.upsert({
    where: composite(s.scope, s.key, s.callerId),
    create: { ...s, response: JSON.stringify(value), expiresAt },
    update: { response: JSON.stringify(value), expiresAt },
  });
}

/** Read a record. Returns null if absent, expired, or unparseable. */
export async function read<T>(scope: string, key: string, callerId: string): Promise<T | null> {
  const s = scoped(scope, key, callerId);
  const row = await db.idempotencyKey.findUnique({
    where: composite(s.scope, s.key, s.callerId),
    select: { response: true, expiresAt: true },
  });
  if (!row) return null;
  // Belt and braces on TTL: the boot-time evictor is best-effort and may not
  // have run since this row expired, so expiry is enforced on READ too.
  if (row.expiresAt.getTime() <= Date.now()) return null;
  try {
    return JSON.parse(row.response) as T;
  } catch {
    // A corrupt row must read as absent (fail closed), never as a partial
    // object that happens to pass a field check.
    return null;
  }
}

export type TakeResult = { ok: true } | { ok: false; reason: "already_taken" };

/**
 * Insert-if-absent, arbitrated by the unique index.
 *
 * This is the exactly-one-winner primitive. It performs NO read first: the
 * INSERT either succeeds (nobody has this key) or violates the index (somebody
 * already does). Two concurrent callers therefore cannot both return ok —
 * one of them loses at the database, not at a JavaScript check.
 */
export async function take(
  scope: string,
  key: string,
  callerId: string,
  value: unknown,
  expiresAt: Date
): Promise<TakeResult> {
  const s = scoped(scope, key, callerId);
  try {
    await db.idempotencyKey.create({
      data: { ...s, response: JSON.stringify(value ?? {}), expiresAt },
    });
    return { ok: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: "already_taken" };
    }
    // A genuine failure (connection lost, permission denied) must NOT be
    // reported as "someone else got there first" — that would let a caller
    // believe an invitation was consumed when it was not.
    throw err;
  }
}

/**
 * Read-modify-write. Returns the NEW value, or null if the record vanished.
 *
 * `next` receives the current value and returns the replacement. Returning the
 * unchanged current value is a no-op write — callers use that to skip a write
 * they do not need (see `touchLastSeen` in session.ts).
 */
export async function patch<T>(
  scope: string,
  key: string,
  callerId: string,
  next: (current: T) => T
): Promise<T | null> {
  const current = await read<T>(scope, key, callerId);
  if (current === null) return null;
  const updated = next(current);
  const s = scoped(scope, key, callerId);
  await db.idempotencyKey.update({
    where: composite(s.scope, s.key, s.callerId),
    data: { response: JSON.stringify(updated) },
  });
  return updated;
}

export async function drop(scope: string, key: string, callerId: string): Promise<void> {
  const s = scoped(scope, key, callerId);
  await db.idempotencyKey
    .deleteMany({ where: { scope: s.scope, key: s.key, callerId: s.callerId } })
    .catch(() => {
      // Best effort: a session row that outlives its own revocation is still
      // rejected by the epoch checks, so failing to delete cannot grant access.
    });
}

/** Every record in a scope for one caller. Used to revoke an org in one sweep. */
export async function listFor<T>(scope: string, callerId: string): Promise<Array<T & { key: string }>> {
  const s = scoped(scope, "", callerId);
  const rows = await db.idempotencyKey.findMany({
    where: { scope: s.scope, callerId: s.callerId },
    select: { key: true, response: true, expiresAt: true },
  });
  const out: Array<T & { key: string }> = [];
  for (const row of rows) {
    if (row.expiresAt.getTime() <= Date.now()) continue;
    try {
      out.push({ ...(JSON.parse(row.response) as T), key: row.key });
    } catch {
      // Corrupt row — skip rather than hand a half-object to a revocation sweep.
    }
  }
  return out;
}