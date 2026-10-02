import "server-only";

/**
 * Durable dial queue (S-1).
 *
 * Why this exists: while an outbound call is placed inside an HTTP request
 * handler, the bank's fraud engine sets our call rate, there is no
 * backpressure, and a campaign burst — 35× steady state in forty minutes — is
 * absorbed by nothing except the telephony provider's patience. The request
 * handler has already returned by then, or it is still holding a connection
 * while a call provider rate-limits it.
 *
 * So the call is a durable job. The handler enqueues and returns; a worker
 * claims with `FOR UPDATE SKIP LOCKED`, which is what lets N workers run with
 * no distributed lock and no job ever claimed twice.
 *
 * ── On "exactly once" ───────────────────────────────────────────────────────
 * The database guarantees exactly-once *job* per (caseRef, attemptNo) via a
 * unique index. It cannot guarantee exactly-once *external side effect* — a
 * worker killed between "provider accepted the call" and "we wrote PLACED"
 * leaves the provider holding a live call we do not know about. That window is
 * closed at the domain layer instead: before dialling, a claimed job checks
 * whether the case already has a conversation id, and if it does, the job is
 * marked PLACED (recovered) rather than dialled again. The residual window is
 * a crash inside the provider call itself, which is why the lease is generous
 * relative to the call timeout.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { db } from "@/lib/db";

export const DIAL_JOB_STATES = ["QUEUED", "LEASED", "PLACED", "FAILED", "DEAD"] as const;
export type DialJobState = (typeof DIAL_JOB_STATES)[number];

/** Attempts before a job is dead-lettered. 3 is the telephony reality: a busy
 *  signal, a rejected number, and one transient provider error. */
export const MAX_DIAL_ATTEMPTS = 3;

/** Default lease. Must exceed the provider call timeout (10s) with margin. */
export const DIAL_LEASE_MS = 60_000;

/** Backoff ladder by attempt number (1-based), in milliseconds. */
const BACKOFF_MS = [0, 30_000, 120_000];

export type EnqueueArgs = {
  caseRef: string;
  attemptNo?: number;
  /** Higher is dialled sooner. Used for expected-loss triage under load. */
  priority?: number;
  /** Delay the first attempt, e.g. to respect a retry ladder. */
  availableAt?: Date;
};

/**
 * Enqueue a dial. Idempotent by (caseRef, attemptNo): a duplicate enqueue —
 * from a bank retry, a double-click, or two instances racing — returns the
 * existing job rather than creating a second one. This is the property that
 * stops a fraud victim being called twice.
 */
export async function enqueueDial(args: EnqueueArgs): Promise<{ id: string; state: string; duplicate: boolean }> {
  const attemptNo = args.attemptNo ?? 1;
  const existing = await db.dialJob.findUnique({
    where: { caseRef_attemptNo: { caseRef: args.caseRef, attemptNo } },
    select: { id: true, state: true },
  });
  if (existing) return { id: existing.id, state: existing.state, duplicate: true };

  try {
    const row = await db.dialJob.create({
      data: {
        caseRef: args.caseRef,
        attemptNo,
        priority: args.priority ?? 0,
        availableAt: args.availableAt ?? new Date(),
      },
      select: { id: true, state: true },
    });
    return { id: row.id, state: row.state, duplicate: false };
  } catch (err) {
    // Unique violation means a concurrent enqueue won the race — return its row.
    if ((err as { code?: string } | null)?.code === "P2002") {
      const winner = await db.dialJob.findUnique({
        where: { caseRef_attemptNo: { caseRef: args.caseRef, attemptNo } },
        select: { id: true, state: true },
      });
      if (winner) return { id: winner.id, state: winner.state, duplicate: true };
    }
    throw err;
  }
}

/**
 * Claim up to `limit` jobs for this worker.
 *
 * Eligible: QUEUED jobs whose backoff has elapsed, plus LEASED jobs whose lease
 * has expired (the crashed-worker recovery path). Ordered by priority then age,
 * so an expected-loss triage decision made at enqueue time is actually honoured.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole concurrency story: two workers running
 * this simultaneously receive disjoint sets, with no lock table and no
 * distributed coordination.
 */
export async function claimDialJobs(
  limit = 5,
  leaseMs: number = DIAL_LEASE_MS,
): Promise<
  Array<{
    id: string;
    caseRef: string;
    attemptNo: number;
    priority: number;
    attempts: number;
    conversationId: string | null;
  }>
> {
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      caseRef: string;
      attemptNo: number;
      priority: number;
      attempts: number;
      conversationId: string | null;
    }>
  >`
    UPDATE "DialJob" AS j
    SET "state" = 'LEASED',
        "leaseExpiresAt" = now() + (${leaseMs}::text || ' milliseconds')::interval,
        "attempts" = j."attempts" + 1,
        "updatedAt" = now()
    WHERE j."id" IN (
      SELECT d."id"
      FROM "DialJob" AS d
      WHERE (
              d."state" = 'QUEUED' AND d."availableAt" <= now()
            )
         OR (
              d."state" = 'LEASED' AND d."leaseExpiresAt" < now()
            )
      ORDER BY d."priority" DESC, d."createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING j."id", j."caseRef", j."attemptNo", j."priority", j."attempts", j."conversationId"
  `;
  return rows;
}

/** The call was accepted by the provider. Terminal for this attempt. */
export async function markDialPlaced(id: string, info: { conversationId: string | null; callSid?: string | null }): Promise<void> {
  await db.dialJob.update({
    where: { id },
    data: {
      state: "PLACED",
      conversationId: info.conversationId,
      callSid: info.callSid ?? null,
      placedAt: new Date(),
      leaseExpiresAt: null,
      lastError: null,
    },
  });
}

/**
 * Recovered, not re-dialled: the case already has a conversation id, which
 * means the call was placed before the crash. Recording it as PLACED closes
 * the crash window without contacting the customer a second time.
 */
export async function markDialRecovered(id: string, conversationId: string): Promise<void> {
  await db.dialJob.update({
    where: { id },
    data: { state: "PLACED", conversationId, placedAt: new Date(), leaseExpiresAt: null, lastError: null },
  });
}

/**
 * The call failed. Retry on the backoff ladder until MAX_DIAL_ATTEMPTS, then
 * dead-letter — a dead job is an operator-visible outcome, never a silent drop.
 */
export async function markDialFailed(id: string, error: string, attempts: number): Promise<"RETRY_SCHEDULED" | "DEAD"> {
  const dead = attempts >= MAX_DIAL_ATTEMPTS;
  const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 120_000;
  await db.dialJob.update({
    where: { id },
    data: {
      state: dead ? "DEAD" : "QUEUED",
      lastError: error.slice(0, 300),
      availableAt: new Date(Date.now() + delay),
      leaseExpiresAt: null,
    },
  });
  return dead ? "DEAD" : "RETRY_SCHEDULED";
}

/** Queue health, for the metrics surface. No customer data. */
export async function dialQueueStats(): Promise<{
  queued: number;
  leased: number;
  placed: number;
  dead: number;
  oldestQueuedAgeSeconds: number;
  attemptsInFlight: number;
}> {
  const now = new Date();
  const [queued, leased, placed, dead, oldest] = await Promise.all([
    db.dialJob.count({ where: { state: "QUEUED" } }),
    db.dialJob.count({ where: { state: "LEASED" } }),
    db.dialJob.count({ where: { state: "PLACED" } }),
    db.dialJob.count({ where: { state: "DEAD" } }),
    db.dialJob.findFirst({
      where: { state: { in: ["QUEUED", "LEASED"] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);
  return {
    queued,
    leased,
    placed,
    dead,
    oldestQueuedAgeSeconds: oldest ? Math.round((now.getTime() - oldest.createdAt.getTime()) / 1000) : 0,
    attemptsInFlight: leased,
  };
}

/** Test helper: remove all jobs. Never called from a request path. */
export async function _resetDialQueue(): Promise<number> {
  const r = await db.dialJob.deleteMany({});
  return r.count;
}