/**
 * `fraud_confirmed_to_webhook_delivered` — the bank's own 2-second webhook promise.
 *
 * The span has been declared since the latency contract was written and had no producer
 * for the same reason the ringing and turn-latency spans did: one of its two instants
 * was not a fact anywhere. The delivery instant was (and always has been) persisted —
 * `OutboxEvent.deliveredAt`, written by `src/lib/outbox.ts` — but the confirmation
 * instant lived only as a state name, so measuring it would have meant borrowing a
 * column that means something else. `Case.fraudConfirmedAt` is that missing half,
 * stamped by the single state writer when the customer's own denial lands.
 *
 * WHAT THIS MEASURES, exactly: the elapsed time between the agent recording a fraud
 * denial and the platform's notification for that case being accepted by the bank's
 * endpoint. It is not time-to-contact (that is `signal_received_to_ringing`) and not
 * decision latency inside the platform (that is `signal_received_to_accepted`).
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 * · It never refuses a LONG sample. A delivery that took nine seconds is the failure
 *   this budget exists to surface, so the only numeric guards here are arithmetic
 *   ones (finite, non-negative). A producer that filters out its own bad news is how
 *   a p95 becomes a marketing number.
 * · It never falls back to `Case.updatedAt` or `createdAt` when `fraudConfirmedAt` is
 *   null. Cases confirmed before the column exists, or reached by an SMS-only path
 *   that never enters `CONFIRMED_FRAUD`, produce no sample and are counted as
 *   unmeasurable rather than estimated from a column that any later write moves.
 * · It never lets telemetry break a delivery. The caller has already committed the
 *   state transition; a throw here would turn an observability bug into a missed
 *   notification, so every failure is caught and reported as an outcome string.
 */
import { db } from "@/lib/db";
import { logError } from "@/lib/validation/safe-log";
import { recordSpanAndPersist } from "@/lib/telemetry/store";

/** The only event type the bank's webhook promise is about. */
const NOTIFICATION_EVENT = "case.notified";

export type ConfirmationSpanOutcome =
  | "recorded"
  | "not-a-notification"
  | "no-case-ref"
  | "no-start-instant"
  | "unknown-case"
  | "clock-skew"
  | "error";

/**
 * Record the span for one DELIVERED outbox event.
 *
 * Called from `src/lib/outbox.ts` at the moment a delivery is marked `DELIVERED`, once
 * per event row — which is the right unit: a case that genuinely earns two
 * notifications was told twice, and each delivery is its own latency observation. A
 * retry that failed never reaches this (only a success writes `deliveredAt`), so the
 * ladder cannot inflate the sample count.
 */
export async function recordWebhookDeliverySpan(args: {
  caseRef: string | null;
  eventType: string;
  deliveredAtMs: number;
}): Promise<ConfirmationSpanOutcome> {
  if (args.eventType !== NOTIFICATION_EVENT) return "not-a-notification";
  if (!args.caseRef) return "no-case-ref";
  const caseRef = args.caseRef;
  try {
    const row = await db.case.findFirst({
      where: { caseRef },
      select: { fraudConfirmedAt: true, conversationId: true, orgId: true },
    });
    if (!row) {
      // An outbox row whose case has been erased (retention, or an operator purge).
      // Warn, not error: this is expected after erasure, and an error line here would
      // train an operator to ignore real ones.
      logError("[telemetry] webhook delivery has no case to attach to", { caseRef });
      return "unknown-case";
    }
    const confirmedAt = row.fraudConfirmedAt;
    if (!confirmedAt) return "no-start-instant";

    const startedAtMs = confirmedAt.getTime();
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(args.deliveredAtMs)) return "clock-skew";
    const durationMs = args.deliveredAtMs - startedAtMs;
    // End before start is not a slow delivery, it is a broken pair — a clock jump, an
    // NTP correction, or a row written by a different process with a skewed wall clock.
    // `recordSpan` rejects a negative duration anyway; refusing here keeps the reason
    // specific instead of reporting the generic `invalid_span` the recorder would give.
    if (durationMs < 0) return "clock-skew";

    recordSpanAndPersist({
      span: "fraud_confirmed_to_webhook_delivered",
      startedAtMs,
      endedAtMs: args.deliveredAtMs,
      interventionId: caseRef,
      caseRef,
      conversationId: row.conversationId ?? null,
      attributes: {
        // Which tenant's endpoint accepted it, so a single slow bank integration can
        // be told apart from a platform-wide delivery problem.
        org: row.orgId ?? "unscoped",
      },
    });
    return "recorded";
  } catch (err) {
    logError("[telemetry] webhook delivery span failed", {
      caseRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return "error";
  }
}
