/**
 * The ringing adapter — the missing producer for `signal_received_to_ringing`.
 *
 * The span has been declared since the telemetry plane was built
 * (`src/lib/telemetry/spans.ts:48`, "signal received → ringing", p95 < 5 s) and has never
 * had a sample, because the two instants it joins were not both persisted anywhere:
 * the intake arrival instant lived in a request local, and the carrier's `ringing`
 * status was folded into the delivery vocabulary as `queued`
 * (`src/lib/telecom-outbox.ts:117-121`), which is right for an outbox and fatal for a
 * measurement — `queued` and `ringing` are different instants and nothing downstream
 * can recover which one arrived.
 *
 * So this is the join, and it is deliberately the only writer of `Case.ringingAt`:
 *
 *  1. compare-and-set the ringing instant on the row that carries this call leg, and
 *     only on a row whose start instant is actually known;
 *  2. emit the span if and only if THIS call won the race.
 *
 * That ordering is what makes Twilio's at-least-once callbacks harmless. A provider
 * re-delivers status; a second callback finds `ringingAt` already set, writes nothing,
 * and records nothing — so a retry cannot inflate the sample count, and the count that
 * `evidence/latency/slo.json` reports is a count of calls, not of webhooks.
 *
 * A row with no `signalReceivedAt` is skipped rather than estimated. The cases created
 * before that column existed, and any written by a path that never captured an arrival
 * instant, are not evidence about ringing latency, and inventing a start is exactly how
 * a measurement starts lying — which is the failure this whole file exists to close.
 */
import "server-only";

import { db } from "@/lib/db";
import { recordSpanAndPersist } from "@/lib/telemetry/store";
import { logError, logInfo } from "@/lib/validation/safe-log";

/** The carrier statuses that mean "the handset is actually ringing". */
const RINGING_STATUSES = new Set(["ringing", "early-media"]);

/** True when a status callback names a ringing event. Case-insensitive by contract. */
export function isRingingStatus(raw: string | null | undefined): boolean {
  return raw != null && RINGING_STATUSES.has(raw.toLowerCase());
}

export type RingingOutcome =
  /** A sample was recorded: this callback won the race for a case with a known start. */
  | { recorded: true; caseRef: string; durationMs: number }
  /** Another callback already rang this case, or the row has no known start instant. */
  | {
      recorded: false;
      reason: "already-recorded" | "unknown-case" | "no-start-instant" | "clock-skew";
    }
  /** The write or the read failed. Reported, never swallowed into a silent zero. */
  | { recorded: false; reason: "error"; detail: string };

/**
 * Record the ringing instant for one call leg and produce its span.
 *
 * Called from the status callback with the raw provider status, BEFORE it is folded into
 * the delivery vocabulary — after that fold, `ringing` is indistinguishable from
 * `queued` and the measurement is gone.
 *
 * `atMs` defaults to now because the callback's arrival is the best available
 * observation of the event; Twilio's own `Timestamp` fields are the provider's clock on
 * a different machine, and a cross-clock duration is a fabricated duration.
 */
export async function recordRingingFromCallback(
  callSid: string,
  atMs: number = Date.now(),
): Promise<RingingOutcome> {
  if (!callSid) return { recorded: false, reason: "unknown-case" };
  try {
    // The CAS carries `signalReceivedAt: { not: null }` inside the WHERE, so a row we
    // cannot measure from is never written and never counted — instead of being
    // stamped and then skipped, which would leave a ringing time nobody can age.
    const won = await db.case.updateMany({
      where: { callSid, ringingAt: null, signalReceivedAt: { not: null } },
      data: { ringingAt: new Date(atMs) },
    });
    if (won.count === 0) {
      // Either the sid is not ours, or a callback already won. Distinguishing them
      // costs a read on the retry path for no decision, so both are reported as
      // "not recorded" and the counts stay honest.
      const known = await db.case.findFirst({
        where: { callSid },
        select: { id: true, signalReceivedAt: true },
      });
      if (!known) return { recorded: false, reason: "unknown-case" };
      return {
        recorded: false,
        reason: known.signalReceivedAt ? "already-recorded" : "no-start-instant",
      };
    }

    const row = await db.case.findFirst({
      where: { callSid },
      select: { caseRef: true, signalReceivedAt: true },
    });
    const start = row?.signalReceivedAt?.getTime();
    if (!row || start == null) return { recorded: false, reason: "no-start-instant" };

    const durationMs = atMs - start;
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      // Both ends come from this process's clock, so a negative age means the row's
      // start is in the future — a clock step, not a fast ring. Refusing is the only
      // honest option, and it is loud, because a silently-absent sample is the
      // invisible failure this plane keeps producing.
      logError("[telemetry:ringing] refused a negative ringing duration", {
        caseRef: row.caseRef,
        durationMs,
      });
      return { recorded: false, reason: "clock-skew" };
    }

    recordSpanAndPersist({
      span: "signal_received_to_ringing",
      startedAtMs: start,
      endedAtMs: atMs,
      interventionId: row.caseRef,
      caseRef: row.caseRef,
      attributes: { join: "twilio-status-callback", sid: callSid },
    });
    logInfo("[telemetry:ringing] signal→ringing sample recorded", {
      caseRef: row.caseRef,
      durationMs,
    });
    return { recorded: true, caseRef: row.caseRef, durationMs };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logError("[telemetry:ringing] could not record the ringing sample", { callSid, error: detail });
    return { recorded: false, reason: "error", detail };
  }
}
