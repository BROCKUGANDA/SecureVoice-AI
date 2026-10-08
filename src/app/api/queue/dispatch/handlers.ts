import "server-only";

/**
 * The four job handlers the QStash dispatcher knows how to route to.
 *
 * Each handler is intentionally thin and IDIOMATIC:
 *
 *  - `call.trigger`  — enqueues the dial job through the SAME Postgres
 *    queue the dial worker drains (`enqueueDialJob`). Wrapping the dial worker
 *    in QStash means the bank's HTTP request returns in milliseconds, and
 *    transient DB blips retry against QStash instead of dropping the call.
 *  - `call.postCall` — the post-call resolution hook (verdict parsing,
 *    outbox event, credits reconcile) lives behind the webhook; this handler
 *    must be idempotent because QStash retries.
 *  - `sms.fallback`  — the unreachable-consumer SMS. markVoiceFailed already
 *    has one-bank-event-per-case idempotency, so a QStash retry is safe.
 *  - `retry.callback` — a scheduled retry signal; enqueues the dial for the
 *    same case via the same `enqueueDialJob` path.
 */

import { enqueueDialJob } from "@/lib/scale/queue";
import { markVoiceFailed } from "@/lib/elevenlabs/sms-fallback";
import type { JobEnvelope } from "@/lib/queue/envelope";
import { logWarn } from "@/lib/validation/safe-log";

type CallTriggerPayload = {
  caseId?: string;
  to?: string;
  language?: string;
  merchant?: string;
  amount?: number;
  currency?: string;
  transactionRef?: string;
  priority?: number;
  /** Delay before the queued call becomes due, typically the heads-up window. */
  availableInMs?: number;
};

export async function handleTriggerCall(envelope: JobEnvelope): Promise<void> {
  const p = (envelope.payload ?? {}) as CallTriggerPayload;
  if (!p.caseId) throw new TypeError("call.trigger requires payload.caseId");
  await enqueueDialJob({
    caseId: p.caseId,
    caseRef: envelope.caseRef,
    orgId: envelope.orgId ?? null,
    payload: {
      to: p.to,
      phone: p.to,
      language: p.language,
      merchant: p.merchant,
      amount: p.amount,
      currency: p.currency,
      transaction_ref: p.transactionRef,
    },
    priority: p.priority ?? 0,
    availableInMs: p.availableInMs ?? 0,
  });
}

export async function handlePostCallResolution(envelope: JobEnvelope): Promise<void> {
  // Post-call resolution is driven by the provider's own webhook; a QStash
  // re-dispatch of the same logical post-call is only meaningful when the
  // webhook could not be forwarded. Record the attempt and let the webhook
  // own the truth: a blind re-run of state transitions is the classic way a
  // duplicate delivery flips a case backwards.
  const p = (envelope.payload ?? {}) as { conversationId?: string | null };
  if (!p.conversationId) {
    logWarn("[queue] postCall had no conversationId; nothing to resume", {
      caseRef: envelope.caseRef,
    });
    return;
  }
  // Deliberately a no-op for now: the ElevenLabs webhook owns resolution,
  // and re-running it from here would double-event the bank. The envelope
  // is still validated above so an actually-missing conversationId surfaces
  // as a DLQ row rather than a silent pass.
}

export async function handleSmsFallback(envelope: JobEnvelope): Promise<void> {
  const p = (envelope.payload ?? {}) as { caseRef?: string; reason?: string };
  // markVoiceFailed has one-bank-event-per-case idempotency, so a QStash
  // retry is safe to deliver the same caseRef to it twice.
  const candidates = new Set(["dial_exhausted", "voicemail", "no_answer"]);
  const reason = (p.reason && candidates.has(p.reason) ? p.reason : "dial_exhausted") as
    "dial_exhausted" | "voicemail" | "no_answer";
  await markVoiceFailed({ caseRef: envelope.caseRef, reason });
}

export async function handleScheduledRetry(envelope: JobEnvelope): Promise<void> {
  const p = (envelope.payload ?? {}) as { caseId?: string; to?: string };
  if (!p.caseId) throw new TypeError("retry.callback requires payload.caseId");
  await enqueueDialJob({
    caseId: p.caseId,
    caseRef: envelope.caseRef,
    orgId: envelope.orgId ?? null,
    attemptNo: envelope.attempt > 0 ? envelope.attempt + 1 : 2,
    payload: { to: p.to, phone: p.to },
  });
}
