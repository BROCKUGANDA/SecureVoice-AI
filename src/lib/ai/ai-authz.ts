/**
 * Just-in-Time Pre-Authorized AuthZ — the soft freeze.
 *
 * ── What this is, stated exactly ─────────────────────────────────────────────
 * SecureVoice does not write to a bank's core ledger. Per `case.notified` in
 * `src/lib/contracts/schema.ts`, what this platform sends the institution is
 * EVIDENCE, and the institution decides what happens to the account. So a
 * "soft freeze" here is three durable things, and only three:
 *
 *   1. the Case row moves to `FREEZE_STAGED` with `freezeStaged: true` and a
 *      `freezeReference` the bank can quote;
 *   2. the decision is appended to the hash-chained audit log BEFORE the row is
 *      written, so a freeze nobody audited is refused rather than recorded twice
 *      (invariant I-2);
 *   3. a human fraud reviewer is paged by the state machine's own escalation
 *      rule (`FREEZE_STAGED: "page"`), and the final freeze stays with them
 *      (`/api/console/freeze/commit` needs a second, step-up-authenticated actor).
 *
 * ── Why this file used to be a stub ─────────────────────────────────────────
 * It returned `{ ok: true, status: 202 }` for any input, without reading a
 * database or calling anything. Its one live caller ignored the result and then
 * spoke, in the customer's own language, "I have temporarily restricted your
 * card to protect your account." On the media-stream plane — the plane a real
 * bank call takes when the durable dial queue and Media Streams are enabled —
 * that sentence was never true. A customer hung up believing their funds were
 * protected when nothing had been written at all, and the audit trail carried a
 * synthetic `vs-<uuid>` reference because the worker never resolved the Case.
 *
 * A confirmation is now spoken only if this function says it staged, and this
 * function only says that when the row and the audit entry both exist.
 */
import { append as auditAppend } from "@/lib/audit-chain";
import { IllegalTransitionError, transitionCase } from "@/lib/case-state-machine";
import { env } from "@/lib/config";
import { db } from "@/lib/db";
import { logError } from "@/lib/validation/safe-log";

/** States a live call can be in when the caller denies the transaction. */
const PRE_FRAUD_STATES = ["DISCLOSED", "VERIFYING"] as const;

export type SoftFreezeResult =
  | {
      ok: true;
      caseRef: string;
      reference: string;
      state: "FREEZE_STAGED";
      /** True when an earlier turn (or the SMS path) had already staged it. */
      alreadyStaged: boolean;
    }
  | {
      ok: false;
      code: "no_case" | "illegal_state" | "audit_unavailable" | "staging_failed";
      error: string;
      caseRef?: string;
      from?: string;
    };

/**
 * Stage a soft freeze whose reversal window is `REVERSAL_WINDOW_SECS` (src/lib/config.ts,
 * 300s by default — the older comment here said 24 hours, which was the SMS reply
 * window, not this one).
 *
 * When the window closes with no commit, `src/lib/freeze-window.ts` escalates the
 * hold on the worker's tick. Nothing is reversed: this platform never wrote a hold
 * at the bank, so there is nothing to roll back.
 *
 * @param callSid the provider call-leg sid the media stream was opened with;
 *                `Case.callSid` is persisted at dial time for exactly this join.
 * @param source  which plane asked, recorded on the audit entry.
 */
export async function executeSoftFreeze(
  callSid: string,
  source = "voice_media_stream",
): Promise<SoftFreezeResult> {
  if (!callSid) return { ok: false, code: "no_case", error: "no call-leg reference" };

  const row = await db.case
    .findFirst({
      where: { callSid },
      select: { caseRef: true, state: true, freezeStaged: true, freezeReference: true },
    })
    .catch((err: unknown) => {
      logError("[ai-authz] case lookup by call sid failed", {
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });

  if (!row?.caseRef) return { ok: false, code: "no_case", error: "no case for this call" };
  const caseRef = row.caseRef;

  // Idempotent by design: the caller may deny twice, and the SMS path may have
  // staged the same hold minutes earlier. Re-staging is not an error and must
  // not produce a second audit "decision" for one freeze.
  if (row.state === "FREEZE_STAGED" && row.freezeStaged) {
    return {
      ok: true,
      caseRef,
      reference: row.freezeReference ?? `SV-FRZ-${caseRef}`,
      state: "FREEZE_STAGED",
      alreadyStaged: true,
    };
  }

  // Confirm the fraud first when the call has not reached that verdict yet, so
  // the customer's denial is on the record before the hold that follows from it.
  if ((PRE_FRAUD_STATES as readonly string[]).includes(row.state)) {
    try {
      // The third argument is spread straight into the Prisma `data`, so only
      // real Case columns may appear here; the narrative belongs to the audit
      // row below.
      await transitionCase(caseRef, "CONFIRMED_FRAUD", { customerResponse: "no" });
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        return {
          ok: false,
          code: "illegal_state",
          error: `case cannot move from ${row.state} to CONFIRMED_FRAUD`,
          caseRef,
          from: row.state,
        };
      }
      // Never throw: the caller's contract is a truthful result, and a throw
      // here would abort the turn mid-sentence on a live call.
      logError("[ai-authz] fraud confirmation transition failed", {
        caseRef,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, code: "staging_failed", error: "confirmation failed", caseRef };
    }
  } else if (row.state !== "CONFIRMED_FRAUD") {
    return {
      ok: false,
      code: "illegal_state",
      error: `case is ${row.state}, which does not permit a hold`,
      caseRef,
      from: row.state,
    };
  }

  const reference = `SV-FRZ-${caseRef}`;

  // Audit first (I-2): a freeze that could not be audited is refused.
  try {
    await auditAppend({
      callRef: caseRef,
      action: "freeze",
      intent: "freeze_staged",
      callerId: source,
      redactedText: caseRef,
      meta: {
        stage: "pending_specialist",
        committed: false,
        reversal_window_secs: env.reversalWindowSecs,
        reference,
        to: "FREEZE_STAGED",
        source,
      },
    });
  } catch (err) {
    logError("[ai-authz] freeze audit append failed — refusing the hold", {
      caseRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "audit_unavailable", error: "audit unavailable", caseRef };
  }

  try {
    const updated = await transitionCase(caseRef, "FREEZE_STAGED", {
      freezeStaged: true,
      freezeReference: reference,
    });
    return {
      ok: true,
      caseRef,
      reference,
      state: updated.state as "FREEZE_STAGED",
      alreadyStaged: false,
    };
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      return {
        ok: false,
        code: "illegal_state",
        error: "case could not move to FREEZE_STAGED",
        caseRef,
      };
    }
    logError("[ai-authz] freeze staging failed", {
      caseRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "staging_failed", error: "staging failed", caseRef };
  }
}
