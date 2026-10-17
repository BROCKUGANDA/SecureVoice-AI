import { cpus } from "node:os";
import { classifyDatabaseUrl } from "@/lib/db-target";

/**
 * How many PostgreSQL connections this PROCESS is allowed to hold.
 *
 * ── The bug this file exists to fix ──────────────────────────────────────────
 *
 * Pool sizing used to be `cpus().length * 2 + 1` for the main client and a flat
 * `5` for the audit client, per process. That number is correct for exactly one
 * process talking to a Postgres it owns, and wrong everywhere else, because the
 * deployment is not one process: compose runs `app` plus six workers, all with
 * the same `DATABASE_URL`.
 *
 * Production does not point at the compose `db` at all — `readyz` reports
 * `database: managed-supabase` — so every one of those processes is a CLIENT of
 * one connection pooler, and Supabase's Supavisor in **session mode** caps the
 * client count for the whole deployment. The measured failure is that cap being
 * hit, and it is reported by the pooler rather than queued:
 *
 *     EMAXCONNSESSION  max clients reached in session mode
 *                      - max clients are limited to pool_size: 15
 *
 * On a 4-core VPS that is (9 + 5) x 7 services ≈ 98 client connections against
 * 15 slots. The retention worker, being a long-lived loop that holds its pool
 * open indefinitely, is simply the one that happens to be holding a connection
 * when someone else crosses the cap — so it gets named in the error while the
 * arithmetic that caused it is spread across seven containers.
 *
 * Two independent mistakes, and the second is the one that hides the first:
 *
 *   1. the default is scaled by CPU count, which measures the WRONG resource.
 *      Connection budget is shared with other processes; cores are not.
 *   2. it is not operator-overridable, so the only way to reduce it was to edit
 *      code and rebuild an image — which is why this stayed broken while every
 *      other knob in this file grew a documented env var.
 *
 * ── Why not simply raise the pooler's limit ─────────────────────────────────
 *
 * Because that trades a hard failure for a worse one. Each session-mode client
 * pins a real Postgres backend for as long as it lives, so raising the cap from
 * 15 to 100 on a small VPS trades "retention worker logs an error" for "every
 * worker can hold 14 connections and the database falls over for everyone".
 * The correct place to add capacity is the pooler QUOTA (or transaction mode),
 * not the per-process pool. `docs/runbooks/db-pool-exhaustion.md` says so, and
 * this module is what makes the per-process share small enough to fit under the
 * quota that IS configured.
 */

/**
 * Managed providers whose poolers cap CLIENTS for the whole deployment rather
 * than exposing a Postgres you can raise `max_connections` on.
 *
 * These are the kinds where a per-process pool sized for a dedicated server is
 * actively harmful: the budget is external, shared, and much smaller than
 * `cpus * 2 + 1` per process x N processes implies.
 */
const SHARED_POOLER_KINDS = new Set(["managed-supabase", "managed-neon", "managed-rds"]);

/**
 * Defaults for a process behind a shared, externally-capped pooler.
 *
 * `1 + 1 = 2` per process is starvation-avoidance, NOT capacity, and the
 * distinction matters more than the number. Seven services x 2 = 14 sits under
 * Supavisor's session-mode default of 15, so the fleet stops tripping
 * `EMAXCONNSESSION` on the default configuration — but a main pool of 1
 * serialises a process's queries, which is why this is the floor rather than a
 * target.
 *
 * There is no per-process value that makes session mode comfortable for seven
 * services on 15 slots: the slots are the scarce resource and they are shared,
 * so the only real capacity moves are (a) raising the pooler's client quota, or
 * (b) switching the pooler to TRANSACTION mode, which multiplexes many logical
 * clients over few backends and removes this ceiling entirely.
 *
 * (b) is safe for this codebase specifically: the two session-state features
 * that transaction mode breaks — `pg_advisory_xact_lock` in
 * `src/lib/audit-chain.ts` and `src/lib/billing/ledger.ts` — are both taken
 * inside an explicit `$transaction`, and transaction mode pins one backend
 * connection for the duration of a transaction. There is no `LISTEN`,
 * `pg_notify`, or bare session-level `SET` anywhere in src/ or scripts/.
 *
 * Until one of those happens, these defaults keep the fleet inside the quota and
 * make the trade explicit; `docs/runbooks/db-pool-exhaustion.md` carries the
 * provisioning change.
 */
const SHARED_POOLER_MAIN = 1;
const SHARED_POOLER_AUDIT = 1;

/**
 * Defaults for a process behind a TRANSACTION-mode pooler (Supavisor on 6543).
 *
 * Transaction mode multiplexes many logical clients over few backend connections,
 * so the per-process `max` is no longer bounded by the pooler's client quota the way
 * session mode is. This is the number the enterprise sizing guide asks for, and it
 * is deliberately env-overridable: the right value is a property of the process's
 * real concurrency, and only a load test against a real call can settle it.
 *
 * The audit pool stays at 1. Audit appends are fire-and-forget and must never
 * compete with the hot path for a backend, which is the whole reason it is a
 * separate pool.
 */
const TRANSACTION_MODE_MAIN = 100;

export type PoolBudget = {
  /** `max` for the main client. */
  main: number;
  /** `max` for the audit client, which is deliberately a separate pool. */
  audit: number;
  /** The kind this was derived from, for the boot log. */
  kind: ReturnType<typeof classifyDatabaseUrl>;
  /** True when the defaults were narrowed because the target is a shared pooler. */
  sharedPooler: boolean;
  /** True when the target is a transaction-mode pooler, which may run a larger pool. */
  transactionMode: boolean;
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  // A pool of 0 connections is a self-inflicted outage and `max: 0` is a
  // pg.Pool VALID value meaning "never connect", so it must not survive here.
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * `connection_limit` in the URL wins when present, because that is the knob an
 * operator already reaches for; the env vars are additive and override it, so a
 * deployment can change one number without editing a connection string that is
 * also pasted into dashboards and CI.
 */
export function resolvePoolBudget(
  databaseUrl: string,
  env: { DB_POOL_MAX?: string; DB_AUDIT_POOL_MAX?: string } = {
    DB_POOL_MAX: process.env.DB_POOL_MAX,
    DB_AUDIT_POOL_MAX: process.env.DB_AUDIT_POOL_MAX,
  },
): PoolBudget {
  const kind = classifyDatabaseUrl(databaseUrl);
  const sharedPooler = SHARED_POOLER_KINDS.has(kind);
  // Transaction mode is detected from the URL, not from the kind: the same
  // managed provider serves both modes on different ports, and the MODE is the
  // property that decides how large a per-process pool may be. `pgbouncer=true`
  // is the flag Prisma/node-postgres recognise; 6543 is Supavisor's transaction
  // port. Either is sufficient, and both are checked because a URL can carry one
  // without the other.
  const transactionMode = /[?&]pgbouncer=true/.test(databaseUrl) || /:6543\b/.test(databaseUrl);

  const urlMain = Number.parseInt(/[?&]connection_limit=(\d+)/.exec(databaseUrl)?.[1] ?? "", 10);
  const mainFallback = transactionMode
    ? TRANSACTION_MODE_MAIN
    : sharedPooler
      ? SHARED_POOLER_MAIN
      : cpus().length * 2 + 1;
  // The audit pool stays small in every mode: it is fire-and-forget and must never
  // compete with the hot path for a backend.
  const auditFallback = sharedPooler || transactionMode ? SHARED_POOLER_AUDIT : 5;

  return {
    main: positiveInt(env.DB_POOL_MAX, positiveInt(String(urlMain || ""), mainFallback)),
    audit: positiveInt(env.DB_AUDIT_POOL_MAX, auditFallback),
    kind,
    sharedPooler: sharedPooler || transactionMode,
    transactionMode,
  };
}
