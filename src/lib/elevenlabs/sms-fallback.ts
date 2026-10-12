import "server-only";
/**
 * Voice failed. Make sure the customer - and the bank - find out anyway.
 *
 * Three triggers, one function, so the rules cannot drift between them:
 *   - `dial_exhausted`: the dial job dead-lettered (every attempt failed, or the
 *     number was undiallable). From the dial worker's `onDead` hook.
 *   - `voicemail`: the call reached an answering machine (the agent's
 *     `voicemail_detection` tool fired). From the post-call ingest.
 *   - `no_answer`: the provider reported busy / no-answer / initiation failure.
 *     From the call_initiation_failure event. Previously this went to the
 *     terminal FAILED state and the bank was never told.
 *
 * What it does:
 *   1. Sends the BLIND-PING SMS (no merchant, no amount; YES / NO to reply).
 *   2. Moves the case to UNREACHABLE and stamps `smsSentAt`, which opens the 24h
 *      reply window handled by src/lib/sms-verdict.ts.
 *   3. If no SMS CAN be sent, publishes the resolution to the bank at once
 *      (`voice_failed_sms_unavailable`): "we could not reach this customer by any
 *      channel" is exactly what the bank's fraud team must hear.
 *
 * Rules, each there because the opposite is a real failure:
 *   - Never real egress in dry-run, but the state path still runs, so the whole
 *     flow is testable end to end without texting a real phone.
 *   - Never once a human has heard the call. A case past ANSWERED had a person on
 *     the line; "we could not reach you" would be false and alarming.
 *   - Never to an opted-out number (SmsSuppression): STOP is honoured platform-wide.
 *   - At most once per case, decided by `smsSentAt`, not by an in-memory flag, so
 *     a webhook redelivery or a replayed dead-letter cannot text twice.
 *   - Never throws. This runs after the voice outcome is recorded; a fault here is
 *     audited, never allowed to undo or hide the real result.
 */

import { db } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";
import { isE164, isTwilioConfigured, sendInterventionSms, type DeliveryLang } from "@/lib/twilio";
import { classifyLine, supportsSmsConfirmation, UNKNOWN_LINE } from "@/lib/voice/line-type";
import { canTransition, transitionCase } from "@/lib/case-state-machine";
import { getInstitutionType } from "@/lib/institution";
import { publishResolution } from "@/lib/sms-verdict";
import { resolveCasePhone } from "@/lib/compliance/pii-vault";
import { logError } from "@/lib/validation/safe-log";

export type FallbackReason = "dial_exhausted" | "voicemail" | "no_answer" | "hearing_impaired";

export type FallbackResult =
  | { sent: true; simulated: boolean }
  | { sent: false; skipped: string }
  | { sent: false; error: string };

/**
 * States in which no human has yet heard the intervention AND the state machine
 * has an edge into UNREACHABLE. Anything past ANSWERED means a person was on the
 * line. FAILED / EXHAUSTED are terminal (no edges out) and RETRY_SCHEDULED has no
 * edge to UNREACHABLE, so none of them can carry the fallback - a test pins this
 * set to the real transition table so the two cannot drift apart.
 *
 * `hearing_impaired` enters through the same function but means something
 * different from the other three reasons: voice was never attempted, because the
 * bank flagged the customer as deaf or hard-of-hearing at ingest. The case is
 * SCREENED (voice never dialled), so `stateAllowsFallback` admits it, the same
 * blind-ping SMS goes out, and the audit row records the true reason rather
 * than a fabricated voice failure.
 */
const UNREACHED_STATES: ReadonlySet<string> = new Set([
  "SCREENED",
  "DIALING",
  "RINGING",
  "NO_ANSWER",
  "BUSY",
  "VOICEMAIL",
]);

/** True when a "we could not reach you" message is still true for a case in `state`. */
export function stateAllowsFallback(state: string): boolean {
  return UNREACHED_STATES.has(state);
}

const LANGS: readonly DeliveryLang[] = ["en", "ar", "hi", "ur", "fr", "sw"];

function asDeliveryLang(v: string | null | undefined): DeliveryLang {
  return (LANGS as readonly string[]).includes(v ?? "") ? (v as DeliveryLang) : "en";
}

async function record(
  caseRef: string,
  orgId: string | null | undefined,
  intent:
    | "sms_fallback_sent"
    | "sms_fallback_skipped"
    | "sms_fallback_failed"
    // Sent, but to a line that cannot confirm receipt — recorded separately so a
    // reviewer can tell "we texted the customer" from "we texted a number".
    | "sms_fallback_unconfirmable",
  reason: FallbackReason,
  detail: string,
): Promise<void> {
  try {
    await auditAppend({
      callRef: caseRef,
      action: "handoff",
      intent,
      callerId: "sms-fallback",
      redactedText: detail.slice(0, 200),
      meta: { reason, channel: "sms" },
      orgId: orgId ?? undefined,
    });
  } catch (err) {
    logError("[sms-fallback] audit append failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Walk the case into UNREACHABLE through legal edges only. */
async function enterUnreachable(
  caseRef: string,
  state: string,
  reason: FallbackReason,
  smsSentAt: Date | null,
): Promise<void> {
  let current = state;
  // A voicemail is its own recorded state on the way in, so the audit chain says
  // WHY the voice channel failed, not just that it did.
  if (reason === "voicemail" && canTransition(current, "VOICEMAIL")) {
    await transitionCase(caseRef, "VOICEMAIL");
    current = "VOICEMAIL";
  }
  if (!canTransition(current, "UNREACHABLE")) return;
  await transitionCase(caseRef, "UNREACHABLE", smsSentAt ? { smsSentAt } : undefined);
}

export async function markVoiceFailed(args: {
  caseRef: string;
  reason: FallbackReason;
}): Promise<FallbackResult> {
  const { caseRef, reason } = args;
  try {
    const row = await db.case.findFirst({
      where: { caseRef },
      select: {
        id: true,
        phone: true,
        customerPhoneToken: true,
        language: true,
        state: true,
        orgId: true,
        cardLast4: true,
        smsSentAt: true,
      },
    });
    if (!row) return { sent: false, skipped: "case_not_found" };

    const skip = async (why: string): Promise<FallbackResult> => {
      await record(caseRef, row.orgId, "sms_fallback_skipped", reason, why);
      return { sent: false, skipped: why };
    };

    if (row.smsSentAt) return skip("already_sent");
    if (!stateAllowsFallback(row.state)) return skip(`customer_engaged_${row.state}`);

    // The destination resolves token-first through the PII vault under the
    // case's own org; rows created before tokenization still carry the legacy
    // raw column and answer from it. Null means no destination: the live send
    // below refuses with no_valid_destination, and dry run classifies
    // UNKNOWN_LINE instead.
    const to = await resolveCasePhone(row, row.orgId);

    /** The bank hears now: no SMS can be sent, so nobody else will tell it. */
    const unavailable = async (why: string): Promise<FallbackResult> => {
      await record(caseRef, row.orgId, "sms_fallback_skipped", reason, why);
      await enterUnreachable(caseRef, row.state, reason, null);
      await publishResolution({
        caseRef,
        method: "voice_failed_sms_unavailable",
        customerResponse: null,
        outcome: `voice_failed_${why}`,
        note: `The voice call did not reach the customer and no SMS could be sent (${why}).`,
      });
      return { sent: false, skipped: why };
    };

    const dryRun = process.env.ELEVENLABS_DRY_RUN === "true";
    if (!dryRun) {
      if (!isTwilioConfigured()) return unavailable("sms_not_configured");
      if (!to || !isE164(to)) return unavailable("no_valid_destination");
      const suppressed = await db.smsSuppression.findUnique({ where: { phone: to } });
      if (suppressed) return unavailable("customer_opted_out");

      const institution = await getInstitutionType(row.orgId);
      const res = await sendInterventionSms({
        to,
        lang: asDeliveryLang(row.language),
        caseRef,
        kind: "unreachable",
        last4: row.cardLast4,
        institution,
        // The tenant's own sender, and the case the outbox joins on. A
        // dead-lettered Bank A alert must not go out on the platform line.
        orgId: row.orgId,
        caseId: row.id,
      });
      if (!res.ok) {
        await record(caseRef, row.orgId, "sms_fallback_failed", reason, res.error);
        return unavailable("sms_delivery_failed");
      }

      // `smsSentAt` is not a timestamp here — it is the evidence that the
      // customer WAS reached, and the case state machine and the bank event both
      // read it that way. So it is only written when the destination can receive
      // an SMS at all: a landline, toll-free or premium number accepts a Twilio
      // `sent` and delivers it to a machine with no handset, and "sent, silently
      // to nothing" is indistinguishable from "the customer was warned and said
      // nothing" — on a fraud call, exactly the confusion that lets a transfer
      // stand. The call is still walked to UNREACHABLE; what is withheld is the
      // claim of reach, never the state change.
      const line = await classifyLine(to);
      const smsCanProveReach = supportsSmsConfirmation(line.type);
      if (!smsCanProveReach) {
        await record(
          caseRef,
          row.orgId,
          "sms_fallback_unconfirmable",
          reason,
          `line_type=${line.type} source=${line.source}`,
        );
      }

      await record(caseRef, row.orgId, "sms_fallback_sent", reason, `twilio ${res.status}`);
      await enterUnreachable(caseRef, row.state, reason, smsCanProveReach ? new Date() : null);
      return { sent: true, simulated: false };
    }

    // Dry-run: the whole state path runs, nothing leaves the building — including
    // the reachability claim, which is gated the same way so the demo exercises
    // the real decision rather than a friendlier copy of it.
    await record(caseRef, row.orgId, "sms_fallback_skipped", reason, "dry_run_simulated");
    const dryLine = to ? await classifyLine(to) : UNKNOWN_LINE;
    const dryReach = supportsSmsConfirmation(dryLine.type);
    if (!dryReach) {
      await record(
        caseRef,
        row.orgId,
        "sms_fallback_unconfirmable",
        reason,
        `line_type=${dryLine.type} source=${dryLine.source}`,
      );
    }
    await enterUnreachable(caseRef, row.state, reason, dryReach ? new Date() : null);
    return { sent: true, simulated: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("[sms-fallback] failed", { message });
    return { sent: false, error: message.slice(0, 200) };
  }
}
