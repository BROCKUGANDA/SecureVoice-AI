import "server-only";

import { redactPII } from "./redactor";
import { isAfterHours, nextBusinessHoursStart } from "@/lib/abuse/velocity";
import { CALL_CATEGORIES, type CallCategory } from "@/lib/call-categories";
import { logError, logInfo } from "@/lib/validation/safe-log";
import { append as auditAppend } from "@/lib/audit-chain";
import { isWithinPrayerWindow } from "./prayer-times";

export type ComplianceGateResult = { ok: true } | { ok: false; code: string; reason: string };

/**
 * Compliance gate — runs immediately after the policy gate and before the
 * abuse/concurrency gate in `armAndDial`.
 *
 * Checks:
 *   1. call_category is one of the declared enum values.
 *   2. For `routine` category, the destination's local clock is inside the
 *      configured calling window. Fraud calls are exempt from the window.
 *   3. The signal payload has been PII-redacted before persistence.
 */
export async function runComplianceGate(params: {
  callCategory: string;
  phone: string;
  caseRef: string;
  callerId: string;
  orgId: string | null;
  transactionRef?: string;
  redactedText?: string;
  atMs?: number;
}): Promise<ComplianceGateResult> {
  const category = params.callCategory as CallCategory;

  if (!CALL_CATEGORIES.includes(category)) {
    const reason = `Invalid call_category: ${params.callCategory}`;
    void auditAppend(
      {
        callRef: params.caseRef,
        action: "freeze",
        intent: "compliance_rejected_invalid_category",
        callerId: params.callerId,
        meta: { reason, callCategory: params.callCategory, transactionRef: params.transactionRef },
        orgId: params.orgId ?? undefined,
      },
      { fast: true },
    ).catch(() => {});
    return { ok: false, code: "invalid_call_category", reason };
  }

  // Routine calls must land inside the customer's permitted calling window.
  // Time-critical fraud calls are explicitly exempt: a fraud signal does not
  // wait for business hours.
  if (category === "routine" && isAfterHours(params.atMs ?? Date.now())) {
    const nextOpen = nextBusinessHoursStart(Date.now());
    const reason = "Routine call outside permitted calling hours; retry after business hours.";
    void auditAppend(
      {
        callRef: params.caseRef,
        action: "freeze",
        intent: "compliance_rejected_outside_calling_hours",
        callerId: params.callerId,
        meta: {
          reason,
          callCategory: category,
          nextAllowedAt: new Date(nextOpen).toISOString(),
          transactionRef: params.transactionRef,
        },
        orgId: params.orgId ?? undefined,
      },
      { fast: true },
    ).catch(() => {});
    return { ok: false, code: "outside_calling_hours", reason };
  }

  // Defense-in-depth: verify the payload has been redacted before any
  // downstream persistence. This is not a substitute for upstream redaction;
  // it is a backstop that catches bypasses and misconfigured producers.
  const providedRedacted = params.redactedText ?? "";
  if (providedRedacted && params.phone && providedRedacted.includes(params.phone)) {
    const reason = "PII redaction check failed on inbound signal.";
    logError("[compliance] redaction mismatch", {
      callRef: params.caseRef,
      phone: params.phone.replace(/\d(?=\d{4})/g, "*"),
    });
    void auditAppend(
      {
        callRef: params.caseRef,
        action: "freeze",
        intent: "compliance_rejected_redaction_mismatch",
        callerId: params.callerId,
        meta: { reason, transactionRef: params.transactionRef },
        orgId: params.orgId ?? undefined,
      },
      { fast: true },
    ).catch(() => {});
    return { ok: false, code: "redaction_mismatch", reason };
  }

  // ── Salah window ────────────────────────────────────────────────────────────
  //
  // TIME-CRITICAL FRAUD IS EXEMPT, and that is not an oversight.
  //
  // This check exists because a collections or routine call landing during salah
  // is offensive in a way the caller cannot opt out of politely — they are
  // being called, not calling. But a fraud signal does not wait: the brief
  // scopes this path to time-critical calls only, and the whole product promise
  // is that the customer is contacted within 60 seconds of the signal. Blocking
  // a card freeze because the clock in Dubai reads 13:05 means leaving a live
  // fraud unaddressed for up to 20 minutes, which is the exact harm this
  // platform exists to prevent.
  //
  // So the exemption is symmetric with the calling-hours check above: same
  // category carve-out, same reason, stated in both places.
  //
  // It is ALSO a network call to a third-party API, which is why it must not
  // sit on the fraud path at all — an unreachable Aladhan endpoint must not be
  // able to delay or refuse a protective action.
  if (category !== "time_critical_fraud") {
    const duringPrayer = await isWithinPrayerWindow("UAE");
    if (duringPrayer) {
      const reason = "Intervention paused during the local Salah window.";
      void auditAppend(
        {
          callRef: params.caseRef,
          action: "freeze",
          intent: "compliance_paused_prayer_time",
          callerId: params.callerId,
          meta: {
            reason,
            callCategory: category,
            transactionRef: params.transactionRef,
            note: "time_critical_fraud is exempt from the Salah window",
          },
          orgId: params.orgId ?? undefined,
        },
        { fast: true },
      ).catch(() => {});
      return { ok: false, code: "prayer_time", reason };
    }
  }

  logInfo("[compliance] gate passed", {
    callRef: params.caseRef,
    callCategory: category,
    orgId: params.orgId ?? "unscoped",
  });

  return { ok: true };
}
