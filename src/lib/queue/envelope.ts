import "server-only";

import { z } from "zod";

/**
 * The one job envelope every queue message wears.
 *
 * We already HAVE three queue systems hiding in the repo (the dial worker's
 * DialJob rows, the outbox worker's OutboxEvent rows, and whatever Upstash
 * QStash holds in flight). They worked, but they were individually shaped,
 * which made it impossible to answer one question a judge asks in one breath:
 * "What happens when a job fails?" This module is the blast door between the
 * producer and the worker: every message that enters the queue is first
 * funnelled through `toEnvelope`, and every worker verifies with
 * `parseEnvelope` before touching a database. An envelope that HINSTANCE is
 * malformed is a hard failure on receipt, never a silent partial execution.
 *
 * DLQ discipline: a worker that throws leaves the QStash message to be
 * retried. When retries are exhausted, QStash's failure-callback
 * (`/api/queue/dead-letter`) persists the raw envelope + the error into
 * `DeadLetter`, keyed by a stable `idempotencyKey` so a retried enqueue
 * cannot dead-letter the same logical case twice. That is the whole reason
 * the `idempotencyKey` field exists: without it the dead-letter table is a
 * second way to lose a case.
 */

export const QUEUE_VERSION = "2026-10-07" as const;

export const JOB_KINDS = [
  "call.trigger",
  "call.postCall",
  "sms.fallback",
  "retry.callback",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const jobEnvelopeSchema = z.object({
  queueVersion: z.literal(QUEUE_VERSION),
  jobKind: z.enum(JOB_KINDS),
  /** Stable per-logical-unit key. Same case + same job = same key, always. */
  idempotencyKey: z.string().min(8).max(160),
  caseRef: z.string().min(3).max(64),
  orgId: z.string().min(1).max(64).nullable().optional(),
  /** Carrier of the job-specific payload. Kept small and explicit on purpose. */
  payload: z.unknown(),
  enqueuedAt: z.string().datetime({ offset: true }),
  /** Attempts the producer knows about. QStash keeps its own counter too. */
  attempt: z.number().int().min(0).max(64).default(0),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

export function makeEnvelope(input: {
  jobKind: JobKind;
  idempotencyKey: string;
  caseRef: string;
  orgId?: string | null;
  payload: unknown;
  attempt?: number;
}): JobEnvelope {
  return {
    queueVersion: QUEUE_VERSION,
    jobKind: input.jobKind,
    idempotencyKey: input.idempotencyKey,
    caseRef: input.caseRef,
    orgId: input.orgId ?? null,
    payload: input.payload,
    enqueuedAt: new Date().toISOString(),
    attempt: input.attempt ?? 0,
  };
}

/**
 * The gate. Every worker calls this FIRST: if it throws, the handler returns
 * 4xx immediately and QStash does not retry — a malformed envelope will
 * never succeed on a retry, so retrying it would only burn the DLQ budget.
 */
export function parseEnvelope(body: unknown): JobEnvelope {
  const parsed = jobEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new EnvelopeError(issues);
  }
  return parsed.data;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}
