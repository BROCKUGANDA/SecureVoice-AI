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
import { env } from "@/lib/config";
import { db } from "@/lib/db";
import { assertPilotAllowsEnqueue } from "@/lib/pilot/gate";
import { logError } from "@/lib/validation/safe-log";

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
export const DEFAULT_LEASE_MS = env.queueLeaseMs;

/**
 * Retry ladder for a failed attempt. Jittered by `dialJobBackoffMs`.
 *
 * Read from `DIAL_RETRY_LADDER_MS` via `env.dialRetryLadderMs`, so a deploy can
 * retune dial backoff without a rebuild; the default is the ladder that was
 * previously hard-coded here ([150s, 300s, 600s]), so nothing changes until the
 * var is set.
 *
 * Carrier-protection rule: never place more than TWO calls to one customer in
 * any five-minute window. Carriers flag numbers that re-dial inside that window
 * as robocall spam and start sending every later call to voicemail - which is
 * the one outcome a fraud-intervention call cannot afford.
 *
 * Attempts land at t0, t0 + L1, t0 + L1 + L2. The first two rungs must therefore
 * sum to MORE than 300s even at the bottom of the -20% jitter band:
 *   0.8 * (150s + 300s) = 360s > 300s.
 * The previous 30s/120s ladder put three calls inside 2.5 minutes. A configured
 * ladder that breaks the rule is REFUSED (loudly, at boot) by the config getter
 * below — the knob retunes backoff, it does not get to disarm the carrier rule.
 * tests/unit/scale.test.ts pins this against `CALL_RATE_WINDOW_MS`.
 */
export const DIAL_RETRY_LADDER_MS = env.dialRetryLadderMs;

/** The carrier rate window the ladder above is sized against. */
export const CALL_RATE_WINDOW_MS = env.callRateWindowMs;

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
  /** The alert type, for the pilot charter's one-alert-type rule. */
  signalKind?: string | null;
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

  // THE PILOT GATE — the last line of defence, at the one place a dial job
  // comes into existence.
  //
  // Every ingest path that can create a dial job — the bank signal endpoint,
  // the campaign endpoint, the console's fire button, the dispatch engine's
  // `call.trigger` and `retry.callback` handlers — has to remember to consult
  // the pilot charter and the pilot's volume cap. That is five call sites, and
  // a sixth added later would be a sixth way to place a call the pilot was
  // never chartered to place.
  //
  // The per-path calls remain, because refusing HERE is too late: the case row
  // has already been created by then, and a pilot that silently accumulates
  // cases it will never act on is a pilot whose shadow readout is wrong. But
  // a path that forgets to gate itself still cannot enqueue.
  //
  // The refusal is a THROWN error, not a silent no-op, because a caller that
  // believes it enqueued a job and did not will report a case as live to a
  // bank. `PilotRefusalError` carries the code and the reason so the caller
  // can turn it into the same 409 the intake gate produces.
  await assertPilotAllowsEnqueue({
    orgId: input.orgId ?? null,
    signalKind: input.signalKind ?? null,
  });

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
  // The limit is INLINED rather than bound as `$n`. That is a safety choice, not
  // the bug fix: a LIMIT placeholder depends on the driver inferring a numeric
  // type for an otherwise untyped parameter, and `limit` is already coerced to a
  // safe integer here, so inlining removes the inference entirely. (The over-claim
  // that WP-19's gate caught was NOT this — it was the derived-table shape, fixed
  // in the statement below.) Keep the coercion above: it is what makes inlining
  // safe, and a NaN would otherwise render as a syntax error.
  const requested = Number(opts.limit ?? 10);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.trunc(requested)) : 10;
  try {
    // $queryRawUnsafe, not the tagged form: the column list in RETURNING and the
    // INTERVAL expression are literal SQL, so this mixes SQL text with $params.
    //
    // The claim is a CTE, not a derived table. `UPDATE … FROM (SELECT … FOR
    // UPDATE SKIP LOCKED LIMIT n)` binds correctly when one statement runs alone
    // but over-claims when two run concurrently: Postgres re-evaluates the
    // sub-select for the outer row (EvalPlanQual), so each worker could be
    // handed far more than the `limit` it asked for — which defeats the entire
    // point of SKIP LOCKED and lets one worker drain the queue. Hoisting the
    // locking select into a WITH clause materialises it once, so the LIMIT is a
    // hard cap under concurrency as well as in isolation.
    return await db.$queryRawUnsafe<DialJob[]>(
      `WITH claimed AS (
         SELECT id FROM "dial_job"
          WHERE (state = 'PENDING' AND available_at <= now())
             OR (state = 'CLAIMED' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
          ORDER BY priority DESC, available_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
       )
       UPDATE "dial_job" j
          SET state = 'CLAIMED',
              claimed_by = $1,
              lease_expires_at = ${nowPlusMs(2)},
              updated_at = now()
         FROM claimed
        WHERE j.id = claimed.id
          AND (
            (j.state = 'PENDING' AND j.available_at <= now())
            OR (j.state = 'CLAIMED' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at < now())
          )
       RETURNING ${COLUMNS_QUALIFIED}`,
      opts.workerId,
      Math.max(0, Math.trunc(opts.leaseMs ?? DEFAULT_LEASE_MS)),
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
  /**
   * Deferred retry in ms (e.g. a routine call parked until calling hours open).
   * When set, the job goes back to PENDING at `now + retryAfterMs` WITHOUT
   * consuming an attempt: a regulatory deferral is not a failure, and letting
   * it climb the ladder would dead-letter an overnight routine call instead of
   * placing it in the morning. Clamped to [1min, 24h].
   */
  retryAfterMs?: number;
}): Promise<FailOutcome> {
  const maxAttempts = Math.max(1, args.maxAttempts ?? MAX_DIAL_ATTEMPTS);
  const error = args.error.slice(0, 500);
  // The in-flight marker is PRESERVED here, and that is load-bearing in a
  // narrow window.
  //
  // `markDialStarted` writes the marker immediately before the carrier call.
  // If the worker dies between this UPDATE and the DEAD-lettering UPDATE that
  // follows it, the row is left CLAIMED with a provider message and NO
  // marker — and the next claim would read "no marker", conclude that no call
  // was ever placed, and PLACE THE CALL AGAIN. On a call whose outcome was
  // unknown, that is a customer being rung twice.
  //
  // The marker is cleared only on the path where it is known to be wrong: the
  // carrier ANSWERED and refused, so nothing was placed. The worker clears it
  // explicitly (`clearDialInFlight`) BEFORE the failure is recorded, so by the
  // time these statements run the marker is already gone and the CASE takes
  // the plain branch.
  try {
    if (args.retryAfterMs !== undefined && !args.dead) {
      // A deferred retry is NOT an attempt: no retries increment, so parking a
      // routine call overnight cannot dead-letter it by morning.
      const deferMs = Math.min(Math.max(Math.trunc(args.retryAfterMs), 60_000), 86_400_000);
      const availableAt = new Date(Date.now() + deferMs).toISOString();
      const deferred = await db.$queryRaw<{ retries: number }[]>`
        UPDATE "dial_job"
           SET state = 'PENDING', "available_at" = ${availableAt}, claimed_by = NULL,
               lease_expires_at = NULL,
               last_error = CASE WHEN "last_error" = 'dial_in_flight'
                                 THEN 'dial_in_flight: ' ELSE '' END || ${error},
               updated_at = now()
         WHERE id = ${args.id} AND state = 'CLAIMED'
        RETURNING retries
      `;
      const row = deferred[0];
      if (row === undefined) {
        return { outcome: "SETTLED", retries: 0, nextAttemptAt: null, state: null };
      }
      return { outcome: "RETRY", retries: row.retries, nextAttemptAt: null };
    }
    const rows = await db.$queryRaw<{ retries: number }[]>`
      UPDATE "dial_job"
         SET retries = retries + 1,
             last_error = CASE WHEN "last_error" = 'dial_in_flight'
                               THEN 'dial_in_flight: ' ELSE '' END || ${error},
             updated_at = now()
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
 * ── The lease is a RECOVERY TIMER, not an ownership token ───────────────────
 *
 * It is tempting to add `lease_expires_at > now()` to the predicate — "our
 * lease lapsed, so we have lost the row" — and it is wrong.
 *
 * The claim above re-claims a row whose lease has expired, and it does so by
 * WRITING `claimed_by = <the new worker>`. So ownership is not expressed by
 * the lease at all; it is expressed by the `claimed_by` column, and this
 * UPDATE is the atomic compare-and-set on it. Two workers whose leases have
 * both expired race for the row, and exactly one of the two UPDATEs matches
 * the predicate: the loser reads zero rows back and does not dial.
 *
 * Adding a lease check would change the answer in the one case where the
 * current behaviour is correct. A batch of five is claimed at once with a
 * sixty-second lease and the worker runs the handlers serially, so a job late
 * in the batch routinely arrives at this call with its lease long expired and
 * nobody else has claimed it — it is still ours. Refusing to extend it would
 * skip the job, and the skip would repeat on every pass, so a slow batch
 * would silently stop making progress.
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

/**
 * A durable marker written immediately before the provider call.
 *
 * The claim lease cannot answer the one question that matters after a worker
 * dies mid-dial: did the carrier accept the call before the process stopped?
 * A redial guesses "no" and can ring the same customer twice. `last_error` is
 * reused as the marker rather than adding a column because the row already has
 * exactly one "what happened on the last attempt" field; a normal failure
 * overwrites it, and a normal completion clears it.
 */
export const DIAL_IN_FLIGHT = "dial_in_flight";

/**
 * The marker as it appears once a failure has been folded into it.
 *
 * `failDialJob` used to overwrite `last_error` with the error text, which
 * ERASED the marker. The marker then only survived a process kill — and a
 * provider call that failed *after* the carrier had already accepted the call
 * (a timeout, a socket reset, a 5xx from the provider after the call was
 * queued) climbed the retry ladder and rang the customer a second time. That
 * is the exact double-ring the marker exists to prevent, and it was the
 * commoner of the two cases.
 *
 * So the marker is PRESERVED and the failure is appended to it. The worker
 * reads the prefix (see `src/worker/dial.ts`), so both spellings mean "a call
 * may already have been placed" and neither is retried.
 */
export const DIAL_IN_FLIGHT_PREFIX = `${DIAL_IN_FLIGHT}:`;

/**
 * Record that THIS worker is about to hand the job to the provider.
 *
 * The CAS is the same ownership check as `renewClaim`: a worker that lost the
 * row must not mark it, and a false return means "do not dial".
 */
export async function markDialStarted(jobId: string, workerId: string): Promise<boolean> {
  try {
    const rows = await db.$queryRaw<{ id: string }[]>`
      UPDATE "dial_job"
         SET "last_error" = ${DIAL_IN_FLIGHT}, "updated_at" = now()
       WHERE id = ${jobId} AND state = 'CLAIMED' AND "claimed_by" = ${workerId}
      RETURNING id
    `;
    return rows.length === 1;
  } catch (err) {
    return rethrow(err, "markDialStarted");
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

/**
 * The highest attempt number this case has ever had.
 *
 * The pilot's per-dial human approval is bound to ONE attempt, so the console
 * has to know which attempt it is approving — and the answer is the queue's,
 * not the console's: the queue owns the attempt ladder.
 */
export async function latestDialAttemptForCase(caseRef: string): Promise<number> {
  try {
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT COALESCE(MAX(attempt_no), 1)::int AS "n"
        FROM "dial_job"
       WHERE "case_ref" = ${caseRef}
    `;
    return rows[0]?.n ?? 1;
  } catch (err) {
    return rethrow(err, "latestDialAttemptForCase");
  }
}

/**
 * Make a case's pending dial jobs claimable NOW.
 *
 * The pilot approval gate parks a job with a future `available_at` while it
 * waits for a human, so an approved case does not wait out the parking delay
 * before its call goes out.
 *
 * `last_error` is cleared for the same reason: it carries the
 * `pilot_blocked:<reason>` marker, and the marker is what makes the worker
 * write exactly one audit row per blocked episode. Leaving it behind would
 * silence the next block's row.
 *
 * The deadline is the DATABASE clock (`now()`), for the reason the module
 * header gives: a JavaScript instant arrives as UTC wall time and lands in the
 * past on a host that is not UTC.
 */
export async function releaseDialJobsForCase(caseRef: string): Promise<number> {
  try {
    const rows = await db.$executeRaw`
      UPDATE "dial_job"
         SET "available_at" = now(), "last_error" = NULL, "updated_at" = now()
       WHERE "case_ref" = ${caseRef} AND state = 'PENDING'
    `;
    return rows;
  } catch (err) {
    return rethrow(err, "releaseDialJobsForCase");
  }
}

/**
 * Stop a case's dial jobs for good: PENDING and CLAIMED rows go to DEAD.
 *
 * DEAD is the dead-letter state, which is the right destination for a job a
 * human has DECLINED: it is not a failure, but it must never be dialled, and
 * `replayDeadDialJob` — the only thing that can revive it — is an explicit
 * operator action.
 *
 * CLAIMED rows are included deliberately. A worker that has claimed a job and
 * not yet placed the call is stopped by its own CAS: `markDialStarted`
 * requires the row to still be `state = 'CLAIMED' AND claimed_by = <this
 * worker>`, so a row that has already gone DEAD fails that check and the
 * worker refuses to dial.
 */
export async function killDialJobsForCase(caseRef: string, reason: string): Promise<number> {
  try {
    const rows = await db.$executeRaw`
      UPDATE "dial_job"
         SET state = 'DEAD', "completed_at" = now(), "last_error" = ${reason},
             "claimed_by" = NULL, "lease_expires_at" = NULL, "updated_at" = now()
       WHERE "case_ref" = ${caseRef} AND state IN ('PENDING', 'CLAIMED')
    `;
    return rows;
  } catch (err) {
    return rethrow(err, "killDialJobsForCase");
  }
}

// ── the worker ───────────────────────────────────────────────────────────────

export type DialOutcome =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** Retryable failures climb the ladder. */
      retryable?: boolean;
      /**
       * Deferred retry in ms (regulatory deferral, e.g. routine calling hours).
       * Passed to `failDialJob`, which parks the job WITHOUT consuming an
       * attempt — see failDialJob.
       */
      retryAfterMs?: number;
    };

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
  /**
   * Called once when a job is dead-lettered by THIS drain - the point where the
   * voice channel has definitively failed and a fallback channel (SMS) is the
   * only way left to reach the customer. It runs after the row is settled, so a
   * slow or failing fallback can never hold a lease or undo the dead-letter.
   * A throw is swallowed: the fallback is best-effort and the DEAD row is the
   * record of truth.
   */
  onDead?: (job: DialJob, error: string) => Promise<void>;
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
    //
    // A THROW here is caught, and it must be. `beforeHandler` is wired to
    // `renewClaim`, which rethrows database errors. An uncaught throw left the
    // whole batch: the remaining claimed jobs (up to the batch size) were
    // abandoned in CLAIMED with no handler run, the drain aborted, and the
    // worker slept for the poll interval believing the queue was empty. A
    // single database blip in the ownership check could therefore stall the
    // queue completely, with no counter moving to show for it.
    //
    // A throw is counted as a crash and the job is SKIPPED — not settled, not
    // retried, not marked done. The row stays CLAIMED with its lease, and
    // becomes claimable again when the lease expires, so the work is not lost.
    let mayRun = true;
    if (args.beforeHandler) {
      try {
        mayRun = await args.beforeHandler(job);
      } catch (err) {
        out.crashed++;
        logError("[queue] the ownership gate threw; the job was not run", {
          jobId: job.id,
          workerId: args.workerId,
          error: err instanceof Error ? err.message : String(err),
        });
        mayRun = false;
      }
    }
    if (!mayRun) {
      out.skipped++;
      // WP19_DEBUG_SKIP=1 prints the row we refused to act on. Kept because this
      // is the one failure in the queue that is invisible in the counters — the
      // job looks claimed, and nothing anywhere records that a worker gave it up.
      if (process.env.WP19_DEBUG_SKIP) {
        const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT id, state, "claimed_by", retries, "lease_expires_at" FROM "dial_job" WHERE id = $1`,
          job.id,
        );
        logError("[wp19-queue] refused (not ours)", { workerId: args.workerId, rows });
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
      retryAfterMs: outcome.retryable === false ? undefined : outcome.retryAfterMs,
    });
    if (settled.outcome === "DEAD") {
      out.dead++;
      if (args.onDead) {
        try {
          await args.onDead(job, outcome.error);
        } catch {
          // best-effort by contract - see `onDead` above
        }
      }
    } else if (settled.outcome === "RETRY") out.retried++;
    else out.lost++; // reclaimed or removed under us — counted, never thrown
  }
  return out;
}
