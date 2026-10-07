import "server-only";
/**
 * SMS fallback - the last-resort channel when the voice call could not reach a
 * human.
 *
 * Two triggers, one helper, so the rules cannot drift between them:
 *   - `dial_exhausted`: the dial job dead-lettered (every attempt failed or the
 *     number was undiallable). Called from the dial worker's `onDead` hook.
 *   - `voicemail`: the call connected to an answering machine. Called from the
 *     post-call ingest when the agent's `voicemail_detection` tool fired. The
 *     voicemail message is deliberately generic (no amount, no merchant), so the
 *     customer still has no idea a transaction needs attention until this lands.
 *
 * Rules, each of which exists because the opposite is a real failure:
 *   - Never in dry-run. Dry-run promises no egress; a real text to a real phone
 *     from a demo is the failure it exists to prevent.
 *   - Never when the customer has already engaged. A case that is ANSWERED or
 *     later has a human who heard the call; a text saying "we could not reach
 *     you" would be false and would alarm them for nothing.
 *   - At most once per case, decided from the audit chain. A webhook redelivery
 *     or an operator replay of a dead-lettered job must not text twice - carriers
 *     treat repeat identical texts as spam, and that poisons the sender for the
 *     real fraud alerts that follow.
 *   - Never throws. This runs after the voice outcome is already recorded; a
 *     fallback fault is audited, not allowed to undo or hide the real result.
 *   - Every outcome (sent / skipped / failed) is audited with its reason, so an
 *     auditor can see that the fallback was considered and why it did what it did.
 */

import { db } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";
import { isE164, isTwilioConfigured, sendInterventionSms, type DeliveryLang } from "@/lib/twilio";

export type FallbackReason = "dial_exhausted" | "voicemail";

export type FallbackResult =
  { sent: true } | { sent: false; skipped: string } | { sent: false; error: string };

/**
 * States in which no human has yet heard the intervention. Anything past
 * ANSWERED means a person was on the line, so "we could not reach you" is false.
 */
const UNREACHED_STATES: ReadonlySet<string> = new Set([
  "SCREENED",
  "DIALING",
  "RINGING",
  "NO_ANSWER",
  "BUSY",
  "FAILED",
  "VOICEMAIL",
  "RETRY_SCHEDULED",
  "EXHAUSTED",
]);

/** True when a fallback text is still true to send for a case in `state`. */
export function stateAllowsFallback(state: string): boolean {
  return UNREACHED_STATES.has(state);
}

const LANGS: readonly DeliveryLang[] = ["en", "ar", "hi", "ur", "fr", "sw"];

function asDeliveryLang(v: string | null | undefined): DeliveryLang {
  return (LANGS as readonly string[]).includes(v ?? "") ? (v as DeliveryLang) : "en";
}

/** "AED 2500" - the same raw value the voice agent reads, never rescaled. */
export function formatAmount(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string | undefined {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return undefined;
  const cur = (currency ?? "").trim().slice(0, 3).toUpperCase();
  return cur ? `${cur} ${amount}` : String(amount);
}

async function record(
  caseRef: string,
  orgId: string | null | undefined,
  intent: "sms_fallback_sent" | "sms_fallback_skipped" | "sms_fallback_failed",
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
    console.error("[sms-fallback] audit append failed:", err instanceof Error ? err.message : err);
  }
}

export async function sendUnreachableSms(args: {
  caseRef: string;
  reason: FallbackReason;
  /** Raw amount as stored on the case / job payload. */
  amount?: number | null;
  currency?: string | null;
}): Promise<FallbackResult> {
  const { caseRef, reason } = args;
  try {
    const row = await db.case.findFirst({
      where: { caseRef },
      select: { phone: true, language: true, state: true, orgId: true },
    });
    if (!row) return { sent: false, skipped: "case_not_found" };

    const skip = async (why: string): Promise<FallbackResult> => {
      await record(caseRef, row.orgId, "sms_fallback_skipped", reason, why);
      return { sent: false, skipped: why };
    };

    if (process.env.ELEVENLABS_DRY_RUN === "true") return skip("dry_run");
    if (!isTwilioConfigured()) return skip("twilio_unconfigured");
    if (!stateAllowsFallback(row.state)) return skip(`customer_engaged_${row.state}`);
    if (!row.phone || !isE164(row.phone)) return skip("no_valid_destination");

    const already = await db.auditLog.count({
      where: { callRef: caseRef, action: "handoff", intent: "sms_fallback_sent" },
    });
    if (already > 0) return skip("already_sent");

    const amountText = formatAmount(args.amount, args.currency);
    const res = await sendInterventionSms({
      to: row.phone,
      lang: asDeliveryLang(row.language),
      caseRef,
      kind: "unreachable",
      ...(amountText === undefined ? {} : { amount: amountText }),
    });
    if (!res.ok) {
      await record(caseRef, row.orgId, "sms_fallback_failed", reason, res.error);
      return { sent: false, error: res.error };
    }
    await record(caseRef, row.orgId, "sms_fallback_sent", reason, `twilio ${res.status}`);
    return { sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sms-fallback] failed:", message);
    return { sent: false, error: message.slice(0, 200) };
  }
}
