import "server-only";
/**
 * Transactional outbox + signed bank webhook delivery (WP-5).
 *
 * Four rules the implementation exists to enforce:
 *
 *   1. **No `await fetch()` in a request handler.** Delivery is drained by a
 *      worker (`scripts/outbox-worker.ts`) from rows this module writes.
 *   2. **The state transition and the outbox row commit together.** Callers
 *      pass the transaction client returned by `case-state-machine.ts`'s
 *      transactional transition; a verdict cannot exist without its delivery.
 *   3. **Signed exactly once, over the exact bytes sent.** `SV-Signature:
 *      t={unix},v1={hex}` where `v1 = HMAC-SHA256({t}.{canonical_body})`. The
 *      canonical body is sorted-key JSON — the same bytes are hashed, stored,
 *      and transmitted, so the bank's verifier never has to guess.
 *   4. **Nothing is dropped.** A delivery that exhausts its retry ladder
 *      becomes DEAD plus a DeadLetter row, replayable by an admin.
 *
 * Payload discipline (hazard H28): outbound events carry the verdict, the
 * case reference and a signed retrieval link — never transcript content.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/config";

export const WEBHOOK_SIGNATURE_HEADER = "sv-signature";
export const SCHEMA_VERSION = "2026-10-01";
export const MAX_ATTEMPTS = 6;

/** Retry ladder: six attempts spread across roughly 21 hours, then dead. */
export const BACKOFF_LADDER_MS = [
  60_000, //  +1m
  300_000, //  +5m
  1_800_000, // +30m
  7_200_000, // +2h
  10_800_000, // +3h
  43_200_000, // +12h
] as const;

/** Deterministic JSON: object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return "null";
}

export function signPayload(body: string, timestamp: number, secret: string): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** Verify an SV-Signature header over a body. Constant-time, replay-windowed. */
export function verifySignature(
  header: string | null,
  body: string,
  secret: string,
  toleranceMs = 300_000,
): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing_signature" };
  const parts = Object.fromEntries(
    header
      .split(",")
      .map((p) => p.trim().split("="))
      .filter((p) => p.length === 2) as [string, string][],
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: "malformed_signature" };
  const ts = Number(t);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed_timestamp" };
  if (Math.abs(Date.now() - ts * 1000) > toleranceMs)
    return { ok: false, reason: "stale_timestamp" };
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, reason: "digest_mismatch" };
  return { ok: true };
}

export type BankEventInput = {
  eventType: string;
  caseRef?: string | null;
  orgId?: string | null;
  targetUrl?: string | null;
  data: Record<string, unknown>;
};

export function bankEventUrl(): string {
  return process.env.BANK_WEBHOOK_URL ?? `${env.appBaseUrl}/api/webhooks/receiver`;
}

export function signingSecret(): string {
  const s = process.env.BANK_WEBHOOK_SECRET;
  if (!s) throw new Error("BANK_WEBHOOK_SECRET is not configured");
  return s;
}

/** Build the canonical body for an event. `event_id` is the dedupe key. */
// The parameter is annotated `string` (not left to inference from
// randomUUID) so a caller-supplied event id of any string form type-checks.
export function buildBankEvent(input: BankEventInput, eventId: string = randomUUID()) {
  const body = {
    schema_version: SCHEMA_VERSION,
    event_id: eventId,
    event_type: input.eventType,
    case_ref: input.caseRef ?? null,
    org_id: input.orgId ?? null,
    occurred_at: new Date().toISOString(),
    data: input.data,
  };
  return { eventId, body, canonical: canonicalJson(body) };
}

/**
 * Write an outbox row inside the caller's transaction. The caller MUST pass
 * the transaction client from the same `$transaction` that performed the case
 * transition — that is what makes "no verdict without delivery" true.
 */
export async function enqueueOutbox(
  tx: Prisma.TransactionClient,
  input: BankEventInput & { eventId?: string; occurredAt?: string },
): Promise<{ id: string }> {
  // The default is applied inside buildBankEvent; passing undefined through
  // would defeat the parameter default and widen the event_id type.
  const built = input.eventId ? buildBankEvent(input, input.eventId) : buildBankEvent(input);
  const body = input.occurredAt ? { ...built.body, occurred_at: input.occurredAt } : built.body;
  const canonical = canonicalJson(body);
  const row = await tx.outboxEvent.create({
    data: {
      id: built.eventId,
      orgId: input.orgId ?? null,
      caseRef: input.caseRef ?? null,
      eventType: input.eventType,
      payload: canonical,
      targetUrl: input.targetUrl ?? bankEventUrl(),
    },
    select: { id: true },
  });
  return row;
}

/**
 * Claim a batch with `FOR UPDATE SKIP LOCKED` — the canonical multi-worker
 * pattern. N workers can drain concurrently without a distributed lock, and a
 * killed worker's lease is reclaimed by the `state='SENDING'` sweep below.
 */
export async function claimBatch(
  limit = 10,
  leaseMs = 5 * 60_000,
): Promise<
  {
    id: string;
    eventType: string;
    caseRef: string | null;
    payload: string;
    targetUrl: string;
    attempts: number;
  }[]
> {
  const stale = new Date(Date.now() - leaseMs);
  const rows = await db.$queryRaw<
    {
      id: string;
      eventType: string;
      caseRef: string | null;
      payload: string;
      targetUrl: string;
      attempts: number;
    }[]
  >`
    UPDATE "OutboxEvent" o
       SET state = 'SENDING', "updatedAt" = now()
     WHERE o.id IN (
       SELECT id FROM "OutboxEvent"
        WHERE (state = 'PENDING' AND "nextAttemptAt" <= now())
           OR (state = 'SENDING' AND "updatedAt" < ${stale})
        ORDER BY "nextAttemptAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
     )
     -- CAS: re-assert claimability on the UPDATE's own WHERE.
     --
     -- SKIP LOCKED alone is NOT a claim. The subquery locks a row for the
     -- duration of THIS statement, but nothing stops two concurrent workers
     -- from both selecting the same id across statements, and the UPDATE would
     -- then stamp state='SENDING' twice and both workers would deliver the same
     -- bank notification. Re-checking the state here means a row that changed
     -- under us simply is not returned, and the loser's UPDATE affects zero
     -- rows. This is the same defect the dial-queue load gate caught.
     AND (
       (o.state = 'PENDING' AND o."nextAttemptAt" <= now())
       OR (o.state = 'SENDING' AND o."updatedAt" < ${stale})
     )
    RETURNING o.id, o."eventType", o."caseRef", o.payload, o."targetUrl", o.attempts
  `;
  return rows;
}

/** Exponential backoff with ±20% jitter, clamped to the declared ladder. */
export function backoffMs(attempts: number, rand: number = Math.random()): number {
  // Clamp BOTH ends of the index. The upper clamp alone was not enough: an
  // `attempts` of 0 or less produced a negative index, i.e. `undefined`, and
  // `undefined * jitter` is NaN — an Invalid Date as `nextAttemptAt`. The only
  // caller passes `event.attempts + 1` (>= 1), so this only ever turns a
  // corrupt value into the first rung instead of into a NaN timestamp. The
  // clamp into [0, length - 1] is what proves the element exists.
  const index = Math.min(Math.max(attempts - 1, 0), BACKOFF_LADDER_MS.length - 1);
  const base = BACKOFF_LADDER_MS[index]!;
  const jitter = 0.8 + rand * 0.4;
  return Math.round(base * jitter);
}

export type DeliveryResult =
  | { id: string; status: "DELIVERED"; attempts: number }
  | { id: string; status: "RETRY"; attempts: number; nextAttemptAt: Date }
  | { id: string; status: "DEAD"; attempts: number };

/** Deliver one claimed event. Retryable: network errors, 408, 429, 5xx. */
export async function deliver(
  event: {
    id: string;
    eventType: string;
    caseRef: string | null;
    payload: string;
    targetUrl: string;
    attempts: number;
  },
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<DeliveryResult> {
  const attempt = event.attempts + 1;
  let ok = false;
  let status = 0;
  let error = "";
  try {
    const res = await fetchImpl(event.targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signPayload(
          event.payload,
          Math.floor(now.getTime() / 1000),
          signingSecret(),
        ),
      },
      body: event.payload,
      // A slow bank server must not hang the worker. 10s is generous for a
      // webhook delivery; the retry ladder handles transient failures.
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    ok = res.status >= 200 && res.status < 300;
    if (!ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = `network_error: ${String(err).slice(0, 200)}`;
  }

  if (ok) {
    await db.outboxEvent.update({
      where: { id: event.id },
      data: { state: "DELIVERED", attempts: attempt, deliveredAt: now, lastError: null },
    });
    return { id: event.id, status: "DELIVERED", attempts: attempt };
  }

  if (attempt >= MAX_ATTEMPTS) {
    await db.$transaction([
      db.outboxEvent.update({
        where: { id: event.id },
        data: { state: "DEAD", attempts: attempt, lastError: error },
      }),
      db.deadLetter.upsert({
        where: { eventId: event.id },
        create: {
          eventId: event.id,
          eventType: event.eventType,
          caseRef: event.caseRef,
          payload: event.payload,
          targetUrl: event.targetUrl,
          error,
          attempts: attempt,
        },
        update: { error, attempts: attempt, failedAt: now },
      }),
    ]);
    return { id: event.id, status: "DEAD", attempts: attempt };
  }

  const nextAttemptAt = new Date(now.getTime() + backoffMs(attempt));
  await db.outboxEvent.update({
    where: { id: event.id },
    data: { state: "PENDING", attempts: attempt, lastError: error, nextAttemptAt },
  });
  return { id: event.id, status: "RETRY", attempts: attempt, nextAttemptAt };
}

/** Drain up to `limit` due deliveries. Safe to call from many workers. */
export async function drainOutbox(
  limit = 10,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<DeliveryResult[]> {
  const batch = await claimBatch(limit);
  const out: DeliveryResult[] = [];
  for (const event of batch) {
    out.push(await deliver(event, fetchImpl, now));
  }
  return out;
}

/** Admin replay of a dead letter. Re-queues the original row for one more delivery. */
export async function replayDeadLetter(
  deadLetterId: string,
  now: Date = new Date(),
): Promise<{ ok: boolean; error?: string }> {
  const dl = await db.deadLetter.findUnique({ where: { id: deadLetterId } });
  if (!dl) return { ok: false, error: "dead_letter_not_found" };
  if (dl.replayedAt) return { ok: false, error: "already_replayed" };
  await db.$transaction([
    db.outboxEvent.update({
      where: { id: dl.eventId },
      data: { state: "PENDING", nextAttemptAt: now, lastError: null },
    }),
    db.deadLetter.update({ where: { id: deadLetterId }, data: { replayedAt: now } }),
  ]);
  return { ok: true };
}

/** Envelope digest the bank can quote in a ticket; identical for both languages. */
export function payloadDigest(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
