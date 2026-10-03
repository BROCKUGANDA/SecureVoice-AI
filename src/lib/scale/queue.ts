import "server-only";
/**
 * WP-19 — the durable dial queue (`dial_job`).
 *
 * The problem it solves is not throughput. It is the guarantee that a case is
 * never silently lost while the platform is over the vendor's concurrency
 * ceiling. Everything here exists to make three claims true at once:
 *
 *   1. **Every case has a row before it has a call.** A case is enqueued in the
 *      same breath as it is created; the worker claims a row, then dials. There
 *      is no path where a case exists in memory and vanishes — a crash between
 *      "admitted" and "dialled" leaves a CLAIMED row whose lease expires and is
 *      reclaimed, not a customer we forgot.
 *   2. **N workers, no lock.** Claiming is `FOR UPDATE SKIP LOCKED`: workers skip
 *      each other's in-flight rows instead of blocking on them, so draining
 *      scales with worker count and a slow vendor call cannot serialise the
 *      queue behind it.
 *   3. **Bounded, and then loud.** `retries` is capped; past the cap the row is
 *      DEAD with `last_error` set. DEAD is the dead-letter state. A case that
 *      ends DEAD has a row that says so and names why — which is the difference
 *      between "we tried and failed" and "we do not know", and the only one of
 *      those two a bank can accept.
 *
 * ── Raw SQL, and why ─────────────────────────────────────────────────────────
 * Every statement here is raw and every column is quoted by name. `DialJob` is
 * NOT yet in `prisma/schema.prisma`: the model block to add is reproduced in
 * `src/lib/scale/schema-notes.md`, and `prisma/migrations/2_dial_job/migration.sql`
 * carries the table. Until that block lands, `db.dialJob` does not exist in the
 * generated client and raw SQL is the only way to read the table — which also
 * means the SQL and the model cannot drift apart silently: the column list is
 * asserted against `information_schema` by the load gate, so a migration that
 * does not match this module fails loudly rather than at 3am.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ── Time: everything is the DATABASE clock, and that is not a style choice ────
 * Every deadline this module writes (`available_at`, `lease_expires_at`,
 * `completed_at`, `updated_at`) is produced by Postgres `now()`, and every delay
 * is an INTERVAL added to it. The API therefore takes *durations*
 * (`leaseMs`, `availableInMs`, backoff), never instants (`Date`).
 *
 * This is load-bearing, and it was found the hard way. `TIMESTAMP(3)` has no
 * timezone, so a JS `Date` sent through the driver arrives as its **UTC** wall
 * time, while `now()` returns the server's **local** wall time. On a host that
 * is not UTC — this repository's own Postgres runs on `E. Africa Standard Time`,
 * UTC+3 — every lease was written three hours in the PAST, so every claimed row
 * was instantly reclaimable. Measured effect at 8 workers and 300 cases: ~41,000
 * claims for 300 jobs, and the drain never finished.
 *
 * Two rules follow, and they are the reason for the shape of these functions:
 *   1. Never write a client-clock instant into a column later compared to
 *      `now()`. Write `now() + interval` instead.
 *   2. Prefer a duration over an instant in every API. A duration is timezone-
 *      free, clock-skew-free, and it is what callers actually mean.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

/** Milliseconds → an INTERVAL literal. Used for every deadline this module writes. */
const MS = "milliseconds";

/** `now() + $1 milliseconds`, as SQL text. */
function nowPlusMs(paramIndex: number): string {
  return `now() + (CAST($${paramIndex} AS text) || ' ${MS}')::interval`;
}

/** The physical table name (snake_case, see schema-notes.md). */
export const DIAL_JOB_TABLE = "dial_job";

/** PENDING → CLAIMED → DONE, or → DEAD (the dead-letter state). */
export const DIAL_JOB_STATES = ["PENDING", "CLAIMED", "DONE", "DEAD"] as const;
export type DialJobState = (typeof DIAL_JOB_STATES)[number];

/**
 * Attempts per JOB ROW. Distinct from `attempt_no`, which is the identity of the
 * attempt (and is unique per case together with it — that uniqueness is what
 * makes enqueue idempotent). This cap is what stops a permanently undiallable
 * number from being retried until the heat death of the universe.
 */
export const MAX_DIAL_ATTEMPTS = 3;

/** How long a claim is good for. A worker killed mid-call loses at most this. */
export const DEFAULT_LEASE_MS = 60_000;

/** Retry ladder for a failed attempt. Jittered by `dialJobBackoffMs`. */
export const DIAL_RETRY_LADDER_MS = [30_000, 120_000, 600_000] as const;

/**
 * What a human sees when the table is missing. The migration ships with this
 * module; seeing this message means it has not been applied to this database.
 */
export const MIGRATION_HINT =
  'relation "dial_job" does not exist — apply prisma/migrations/2_dial_job/migration.sql ' +
  "(prisma migrate deploy, or psql -f for a scratch database) and add the DialJob model " +
  "from src/lib/scale/schema-notes.md to prisma/schema.prisma.";

export type DialJob = {
  id: string;
  case_id: string;
  case_ref: string;
  org_id: string | null;
  attempt_no: number;
  retries: number;
  state: DialJobState;
  priority: number;
  payload: string;
  available_at: Date;
  lease_expires_at: Date | null;
  claimed_by: string | null;
  last_error: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * The column list every read shares, so no query can silently omit a field.
 * Literal SQL, never a bound parameter — a parameter cannot be a column list.
 */
const COLUMNS = `id, case_id, case_ref, org_id, attempt_no, retries, state, priority, payload,
  available_at, lease_expires_at, claimed_by, last_error, completed_at, created_at, updated_at`;

/** The same list, qualified for a RETURNING clause on an aliased UPDATE. */
const COLUMNS_QUALIFIED = `j.id, j.case_id, j.case_ref, j.org_id, j.attempt_no, j.retries, j.state,
  j.priority, j.payload, j.available_at, j.lease_expires_at, j.claimed_by, j.last_error,
  j.completed_at, j.created_at, j.updated_at`;

/** Prisma surfaces a missing relation as P2021; anything else is a real fault. */
function isMissingTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  if (e?.code === "P2021") return true;
  return (
    typeof e?.message === "string" &&
    /dial_job/.test(e.message) &&
    /does not exist/i.test(e.message)
  );
}

function rethrow(err: unknown, op: string): never {
  if (isMissingTable(err)) {
    throw new Error(`${MIGRATION_HINT} (while ${op})`, { cause: err });
  }
  throw err;
}

function backoffBaseMs(retries: number): number {
  const idx = Math.min(Math.max(retries, 1), DIAL_RETRY_LADDER_MS.length) - 1;
  return DIAL_RETRY_LADDER_MS[idx] ?? DIAL_RETRY_LADDER_MS[DIAL_RETRY_LADDER_MS.length - 1]!;
}

/** Exponential backoff with ±20% jitter — the same shape as the outbox ladder. */
export function dialJobBackoffMs(retries: number, rand: () => number = Math.random): number {
  const jitter = 0.8 + rand() * 0.4;
  return Math.round(backoffBaseMs(retries) * jitter);
}

export type EnqueueResult = {
  id: string;
  /** False when the unique (case_id, attempt_no) index rejected the write. */
  created: boolean;
  /** attempts on the existing row when `created` is false. */
  retries: number;
  state: DialJobState;
};

/**
 * Enqueue a dial job. IDEMPOTENT on (case_id, attempt_no).
 *
 * `ON CONFLICT DO NOTHING` plus a follow-up read is deliberate rather than an
 * upsert: an upsert would RESET a claimed or dead row when a signal is retried,
 * which is how a case gets dialled twice. Doing nothing and reporting the
 * existing row means a replayed signal costs one query and changes nothing.
 *
 * `priority` is the expected-loss ordering (see `expectedLossScore` in
 * @/lib/capacity): higher is dialled first, so when we can only serve some of a
 * burst it is the customer with the most money at risk who gets the call.
 */
export async function enqueueDialJob(input: {
  caseId: string;
  caseRef: string;
  orgId?: string | null;
  attemptNo?: number;
  priority?: number;
  /** Sanitised dial inputs only — never transcript content (invariant I-10). */
  payload?: Record<string, unknown>;
  /** Delay before the job becomes claimable. 0 (default) = due now. */
  availableInMs?: number;
}): Promise<EnqueueResult> {
  if (!input.caseId || !input.caseRef)
    throw new TypeError("enqueueDialJob requires caseId and caseRef");
  const attemptNo = input.attemptNo ?? 1;
  if (!Number.isInteger(attemptNo) || attemptNo < 1) {
    throw new RangeError(`attemptNo must be a positive integer (got ${String(input.attemptNo)})`);
  }
  const availableInMs = Math.max(0, Math.trunc(input.availableInMs ?? 0));
  const id = randomUUID();
  const payload = JSON.stringify(input.payload ?? {});

  try {
    const inserted = await db.$queryRawUnsafe<
      { id: string; attempt_no: number; retries: number; state: DialJobState }[]
    >(
      `INSERT INTO "dial_job"
         (id, case_id, case_ref, org_id, attempt_no, retries, state, priority, payload,
          available_at, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, 0, 'PENDING', $6, $7, ${nowPlusMs(8)}, now(), now())
       ON CONFLICT ("case_id", "attempt_no") DO NOTHING
       RETURNING id, attempt_no, retries, state`,
      id,
      input.caseId,
      input.caseRef,
      input.orgId ?? null,
      attemptNo,
      Math.trunc(input.priority ?? 0),
      payload,
      availableInMs,
    );
    const row = inserted[0];
    if (row) return { id: row.id, created: true, retries: row.retries, state: row.state };

    const existing = await db.$queryRaw<
      { id: string; attempt_no: number; retries: number; state: DialJobState }[]
    >`
      SELECT id, attempt_no, retries, state FROM "dial_job"
       WHERE case_id = ${input.caseId} AND attempt_no = ${attemptNo}
    `;
    const hit = existing[0];
    if (!hit) {
      // ON CONFLICT fired but the row is not readable — only possible if another
      // transaction deleted it in between. Retrying the insert is correct.
      throw new Error(
        `dial_job conflict for case ${input.caseRef} attempt ${attemptNo} but no row was found`,
      );
    }
    return { id: hit.id, created: false, retries: hit.retries, state: hit.state };
  } catch (err) {
    return rethrow(err, "enqueueDialJob");
  }
}

/**
 * Claim up to `limit` due jobs for `workerId`, leasing each one.
 *
 * The claim predicate is `(PENDING and due) OR (CLAIMED and lease expired)`.
 * The second clause is what makes a killed worker's job recoverable: no
 * sweeper, no heartbeat, no orphan. When the lease lapses the row is simply
 * claimable again.
 *
 * ## Exactly-once is enforced by the UPDATE's own predicate, not by the lock
 *
 * `FOR UPDATE SKIP LOCKED` alone is NOT a claim. Two things go wrong without the
 * predicate repeated on the UPDATE target (`WHERE j.id = cand.id AND <claim
 * condition>`), and both were observed in this repo's own load gate:
 *
 *   1. **Double-claim.** The candidate list is captured from a snapshot, so a
 *      worker whose snapshot predates another worker's commit still sees the row
 *      as PENDING and re-claims it, overwriting `claimed_by`. Observed at 8-way
 *      concurrency: one job id returned to seven successive claims.
 *   2. **Livelock.** With `LIMIT 1` and many workers, every worker snapshots the
 *      SAME top-priority row, so one job collects N claims, N-1 of which are
 *      useless. Measured: ~270,000 claims for 1,200 cases, and the drain never
 *      finished.
 *
 * Re-asserting the claim condition on the target makes the transition an atomic
 * compare-and-set: PENDING → CLAIMED can only happen once per row, so a worker
 * that loses the race simply receives fewer rows. The `SKIP LOCKED` selection is
 * kept — it is what lets workers drain concurrently without blocking — but the
 * guarantee comes from the predicate.
 *
 * `renewClaim()` re-checks ownership once more immediately before the worker
 * places a call, and extends the lease to cover the call. That covers the case
 * the predicate cannot: a lease that lapses mid-conversation and is reclaimed by
 * someone else while the call is still running. The irreversible action gets the
 * guarantee, not the lock.
 *
 * Every time value here is the DATABASE clock (see the module header): the lease
 * is `now() + leaseMs`, so no client's timezone or skew can put it in the past.
 */
export async function claimDialJobs(opts: {
  workerId: string;
  limit?: number;
  leaseMs?: number;
}): Promise<DialJob[]> {
  const limit = Math.max(1, Math.trunc(opts.limit ?? 10));
  try {
    // $queryRawUnsafe, not the tagged form: the column list in RETURNING and the
    // INTERVAL expression are literal SQL, so this mixes SQL text with $params.
    return await db.$queryRawUnsafe<DialJob[]>(
      `UPDATE "dial_job" j
          SET state = 'CLAIMED',
              claimed_by = $1,
              lease_expires_at = ${nowPlusMs(2)},
              updated_at = now()
         FROM (
           SELECT id FROM "dial_job"
            WHERE (state = 'PENDING' AND available_at <= now())
               OR (state = 'CLAIMED' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
            ORDER BY priority DESC, available_at ASC, created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $3
         ) AS cand
        WHERE j.id = cand.id
          AND (
            (j.state = 'PENDING' AND j.available_at <= now())
            OR (j.state = 'CLAIMED' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at < now())
          )
       RETURNING ${COLUMNS_QUALIFIED}`,
      opts.workerId,
      Math.max(0, Math.trunc(opts.leaseMs ?? DEFAULT_LEASE_MS)),
      limit,
    );
  } catch (err) {
    return rethrow(err, "claimDialJobs");
  }
}

/**
 * Mark a claimed job DONE. Idempotent: a job that is already DONE or DEAD is
 * left alone, so a duplicated completion cannot resurrect a dead-lettered row.
 */
export async function completeDialJob(id: string): Promise<boolean> {
  try {
    const rows = await db.$executeRaw`
      UPDATE "dial_job"
         SET state = 'DONE', completed_at = now(), last_error = NULL,
             claimed_by = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = ${id} AND state = 'CLAIMED'
    `;
    return rows > 0;
  } catch (err) {
    return rethrow(err, "completeDialJob");
  }
}

/**
 * Reschedule a claimed job, or dead-letter it once the ladder is exhausted.
 *
 * The ladder is `retries + 1 >= maxAttempts` → DEAD. `DEAD` is terminal for the
 * worker and replayable only by an operator (`replayDeadDialJob`), which is the
 * point: an automatic retry that can run forever is not a retry, it is a loop
 * with a billing card attached.
 *
 * ## It never throws on a row it does not own
 *
 * The first attempt at this function threw when the row was no longer `CLAIMED`,
 * and that was wrong: a worker whose lease expired mid-call, or whose job was
 * settled by a reclaiming worker, is a normal event on a queue with leases — and
 * throwing turned it into a crashed drainer. It now returns `SETTLED` with the
 * row's current state (or `null` if the row is gone), and `drainDialQueue`
 * counts those in `lost` so the accounting test can still fail on a case that
 * went missing. Loud in the metrics, not fatal to the worker.
 */
export async function failDialJob(args: {
  id: string;
  error: string;
  maxAttempts?: number;
  rand?: () => number;
  /** Force the dead-letter branch regardless of the ladder (operator use). */
  dead?: boolean;
}): Promise<FailOutcome> {
  const maxAttempts = Math.max(1, args.maxAttempts ?? MAX_DIAL_ATTEMPTS);
  const error = args.error.slice(0, 500);
  try {
    const rows = await db.$queryRaw<{ retries: number }[]>`
      UPDATE "dial_job"
         SET retries = retries + 1, last_error = ${error}, updated_at = now()
       WHERE id = ${args.id} AND state = 'CLAIMED'
      RETURNING retries
    `;
    const retries = rows[0]?.retries;
    if (retries === undefined) {
      // Not ours any more: reclaimed after a lease expiry, already settled, or
      // removed. Report what is actually there rather than guessing.
      const current = await db.$queryRaw<{ state: DialJobState; retries: number }[]>`
        SELECT state, retries FROM "dial_job" WHERE id = ${args.id}
      `;
      const row = current[0];
      return {
        outcome: "SETTLED",
        retries: row?.retries ?? 0,
        nextAttemptAt: null,
        state: row?.state ?? null,
      };
    }
    if (args.dead || retries >= maxAttempts) {
      await db.$executeRaw`
        UPDATE "dial_job"
           SET state = 'DEAD', completed_at = now(), claimed_by = NULL,
               lease_expires_at = NULL, updated_at = now()
         WHERE id = ${args.id}
      `;
      return { outcome: "DEAD", retries, nextAttemptAt: null };
    }
    // The backoff is applied by the DATABASE clock (see the module header).
    const backoffMs = dialJobBackoffMs(retries, args.rand);
    await db.$executeRawUnsafe(
      `UPDATE "dial_job"
          SET state = 'PENDING', "available_at" = ${nowPlusMs(1)}, claimed_by = NULL,
              lease_expires_at = NULL, updated_at = now()
        WHERE id = $2`,
      backoffMs,
      args.id,
    );
    return { outcome: "RETRY", retries, nextAttemptAt: null };
  } catch (err) {
    return rethrow(err, "failDialJob");
  }
}

export type FailOutcome =
  | { outcome: "RETRY"; retries: number; nextAttemptAt: null }
  | { outcome: "DEAD"; retries: number; nextAttemptAt: null; state?: undefined }
  | {
      outcome: "SETTLED";
      retries: number;
      nextAttemptAt: null;
      /** The row's state now, or null if it no longer exists. */
      state: DialJobState | null;
    };

/**
 * Count jobs by state. `pending` is the queue_depth metric — the number of cases
 * that have a durable row and no voice slot, i.e. the backlog a regulator would
 * ask about.
 */
export async function queueDepth(): Promise<{
  pending: number;
  claimed: number;
  done: number;
  dead: number;
  total: number;
}> {
  try {
    const rows = await db.$queryRaw<{ state: DialJobState; n: number }[]>`
      SELECT state, count(*)::int AS n FROM "dial_job" GROUP BY state
    `;
    const out = { pending: 0, claimed: 0, done: 0, dead: 0, total: 0 };
    for (const r of rows) {
      if (r.state === "PENDING") out.pending = r.n;
      else if (r.state === "CLAIMED") out.claimed = r.n;
      else if (r.state === "DONE") out.done = r.n;
      else if (r.state === "DEAD") out.dead = r.n;
      out.total += r.n;
    }
    return out;
  } catch (err) {
    return rethrow(err, "queueDepth");
  }
}

/** Pending + claimed: everything that still owes the customer a contact. */
export async function outstandingJobs(): Promise<number> {
  const d = await queueDepth();
  return d.pending + d.claimed;
}

/**
 * Reclaim jobs whose lease has expired. Optional: `claimDialJobs` already
 * reclaims them as it goes. Exposed separately because an operator needs a
 * number — "how many jobs are stranded right now" — and because a queue whose
 * recovery depends on traffic has no recovery when the traffic stops.
 */
export async function reapExpiredLeases(): Promise<number> {
  try {
    return await db.$executeRaw`
      UPDATE "dial_job"
         SET state = 'PENDING', claimed_by = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE state = 'CLAIMED' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()
    `;
  } catch (err) {
    return rethrow(err, "reapExpiredLeases");
  }
}

/** Operator replay of a dead-lettered job: back to PENDING, ladder untouched. */
export async function replayDeadDialJob(id: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const rows = await db.$executeRaw`
      UPDATE "dial_job"
         SET state = 'PENDING', available_at = now(), last_error = NULL,
             completed_at = NULL, claimed_by = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = ${id} AND state = 'DEAD'
    `;
    if (rows === 0) return { ok: false, reason: "not_dead" };
    return { ok: true };
  } catch (err) {
    return rethrow(err, "replayDeadDialJob");
  }
}

/**
 * Re-verify that THIS worker still owns the job, and extend its lease.
 *
 * Two jobs in one statement, because they are two halves of the same problem:
 *
 *   1. **Ownership.** The claim above is a hint with a measured race (see its
 *      doc comment). This is the check that makes a double-dial impossible: the
 *      row must still be CLAIMED *by this worker*. If another worker took it, the
 *      call is not placed — the customer gets one call, not two.
 *   2. **Lease length.** A lease shorter than the call it covers expires
 *      mid-conversation, and an expired lease is reclaimable — so a 120 s lease
 *      around a 180 s call guarantees the call is re-attempted by someone else
 *      while it is still in progress. The lease must exceed the expected talk
 *      time, and the only place that knows how long the call is about to be is
 *      here. Pass `MEAN_CALL_SECONDS` plus headroom, not the drain interval.
 *
 * @returns true if the worker owns the job (and the lease is now `leaseMs` long
 *          from now); false if it does not, in which case do NOT place the call.
 */
export async function renewClaim(
  jobId: string,
  workerId: string,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<boolean> {
  try {
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE "dial_job"
          SET "lease_expires_at" = ${nowPlusMs(3)}, "updated_at" = now()
        WHERE id = $1 AND state = 'CLAIMED' AND "claimed_by" = $2
      RETURNING id`,
      jobId,
      workerId,
      Math.max(0, Math.trunc(leaseMs)),
    );
    return rows.length === 1;
  } catch (err) {
    return rethrow(err, "renewClaim");
  }
}

/** Read one job by id — the queue's own view of a case's dial history. */
export async function dialJobById(id: string): Promise<DialJob | null> {
  try {
    const rows = await db.$queryRawUnsafe<DialJob[]>(
      `SELECT ${COLUMNS} FROM "dial_job" WHERE id = $1`,
      id,
    );
    return rows[0] ?? null;
  } catch (err) {
    return rethrow(err, "dialJobById");
  }
}

// ── the worker ───────────────────────────────────────────────────────────────

export type DialOutcome =
  | { ok: true }
  | { ok: false; error: string; /** Retryable failures climb the ladder. */ retryable?: boolean };

export type DrainResult = {
  claimed: number;
  done: number;
  retried: number;
  dead: number;
  /** Handler exceptions that were not a typed `DialOutcome`. */
  crashed: number;
  /** Jobs this worker no longer owned by the time it tried to settle them. */
  lost: number;
  /** Jobs `beforeHandler` refused: not ours to run, so not run. */
  skipped: number;
};

/**
 * Drain the queue once: claim a batch, run the handler on each job, settle it.
 *
 * The handler is INJECTED because the dial is the only part of this that
 * touches a vendor, and a queue is only testable at full strength if the vendor
 * can be replaced without touching the queue. In production the handler is the
 * policy gate + admission ladder + conversation plane; in tests/load it is that
 * same code with the vendor call replaced at the port seam.
 *
 * `maxAttempts` is passed to `failDialJob` rather than read from the module, so
 * a load test can prove the bounded-attempts ladder without editing the env of a
 * process that is also running other tests.
 *
 * `beforeHandler` is the exactly-once gate. It runs after the claim and before
 * the handler — the last point before the irreversible action — and returning
 * false skips the job entirely (counted in `skipped`). Wire it to `renewClaim`,
 * which is what stops a lost claim race from becoming two phone calls.
 */
export async function drainDialQueue(args: {
  workerId: string;
  handler: (job: DialJob) => Promise<DialOutcome>;
  /** Ownership gate. `false` ⇒ do not run the handler for this job. */
  beforeHandler?: (job: DialJob) => Promise<boolean>;
  limit?: number;
  leaseMs?: number;
  maxAttempts?: number;
  rand?: () => number;
}): Promise<DrainResult> {
  const out: DrainResult = {
    claimed: 0,
    done: 0,
    retried: 0,
    dead: 0,
    crashed: 0,
    lost: 0,
    skipped: 0,
  };
  const jobs = await claimDialJobs({
    workerId: args.workerId,
    limit: args.limit ?? 10,
    leaseMs: args.leaseMs,
  });
  out.claimed = jobs.length;

  for (const job of jobs) {
    // Not ours any more (or our lease lapsed and someone took it): do not act.
    // Releasing it would be wrong too — the other worker owns it now.
    if (args.beforeHandler && !(await args.beforeHandler(job))) {
      out.skipped++;
      // WP19_DEBUG_SKIP=1 prints the row we refused to act on. Kept because this
      // is the one failure in the queue that is invisible in the counters — the
      // job looks claimed, and nothing anywhere records that a worker gave it up.
      if (process.env.WP19_DEBUG_SKIP) {
        const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT id, state, "claimed_by", retries, "lease_expires_at" FROM "dial_job" WHERE id = $1`,
          job.id,
        );
        console.error("[wp19-queue] refused (not ours):", args.workerId, JSON.stringify(rows));
      }
      continue;
    }
    let outcome: DialOutcome;
    try {
      outcome = await args.handler(job);
    } catch (err) {
      // A handler that throws is a BUG, not a dial failure. It is still settled
      // (otherwise the lease holds the row until it expires) and still counted
      // separately, so a bug cannot hide inside the retry statistics.
      out.crashed++;
      outcome = {
        ok: false,
        error: `handler crashed: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      };
    }
    if (outcome.ok) {
      if (await completeDialJob(job.id)) out.done++;
      continue;
    }
    const settled = await failDialJob({
      id: job.id,
      error: outcome.error,
      maxAttempts: args.maxAttempts,
      rand: args.rand,
      dead: outcome.retryable === false,
    });
    if (settled.outcome === "DEAD") out.dead++;
    else if (settled.outcome === "RETRY") out.retried++;
    else out.lost++; // reclaimed or removed under us — counted, never thrown
  }
  return out;
}
