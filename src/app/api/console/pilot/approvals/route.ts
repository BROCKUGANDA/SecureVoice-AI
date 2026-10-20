import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator } from "@/lib/credits";
import { db } from "@/lib/db";
import { append } from "@/lib/audit-chain";
import {
  PILOT_DECLINE_INTENT,
  pilotApprovalIntent,
  pilotDialApproved,
  pilotMode,
} from "@/lib/pilot/mode";
import {
  killDialJobsForCase,
  latestDialAttemptForCase,
  releaseDialJobsForCase,
} from "@/lib/scale/queue";
import { transitionCase } from "@/lib/case-state-machine";
import { parseJson } from "@/lib/validation/safe-log";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

const decisionSchema = z.object({
  caseRef: z.string().trim().min(6).max(40),
  decision: z.enum(["approve", "decline"]),
  note: z.string().trim().max(500).optional(),
});

function orgRequired(): NextResponse {
  return NextResponse.json(
    { error: "Select an organization before recording pilot dial decisions." },
    { status: 400 },
  );
}

/**
 * Record the per-dial human decision for one case.
 *
 * Phase 1 of the pilot charter (`docs/PILOT-READINESS.md`) says "no auto-dial —
 * a human approves every call". `pilotDialDecision` enforces it by looking for
 * a row with `intent = "pilot_dial_approved:<attempt>"` in the append-only
 * audit chain; this route is the only intended WRITER of that row from a
 * browser. The chain was chosen over a Case column there: it is tamper-evident,
 * it is the record a bank reviewer reads, and it does not rotate case state.
 *
 * ── The approval is bound to ONE ATTEMPT ─────────────────────────────────────
 *
 * A case that is dialled, comes back unanswered and is retried as attempt 2
 * needs a SECOND approval: a second call to a customer is a second call to a
 * customer, and Phase 1 says a human approves every dial. The attempt number
 * is therefore part of the audit `intent` (`pilot_dial_approved:2`), because
 * the intent is an indexed exact-match column while `meta` is a JSON string
 * that cannot be queried as JSON.
 *
 * ── The decision has to MOVE the queue, not just record itself ──────────────
 *
 * A pilot dial is PARKED while it waits for a human: the job is PENDING with
 * a future `available_at`, so the worker does not keep re-deciding it every
 * minute. An approval that only wrote an audit row would leave the call
 * waiting out the parking delay; a decline that only wrote an audit row would
 * leave the case dialled later anyway. So:
 *
 *   approve → the pending job is made claimable NOW.
 *   decline → the pending and claimed jobs are DEAD-lettered, and the case is
 *             moved to REJECTED so the operator's screen and the bank's view
 *             agree that this alert was consciously not called.
 *
 * The lookup is org-predicated because this decision must not become an
 * oracle: approving a case from another institution is a cross-tenant write,
 * and the endpoint answers a foreign caseRef with the SAME 404 a missing
 * caseRef gets, so a caller cannot distinguish "not mine" from "does not
 * exist".
 *
 * `decline` is recorded, not silently dropped: a case that waits forever on a
 * decision nobody logged is different from a case someone examined and refused,
 * and the queue's next attempt deserves to know which.
 *
 * The two-factor step-up gate is deliberately NOT applied: this is a
 * per-dial operational decision the fraud desk makes dozens of times a day,
 * the same class as the analyst's existing console actions, and it is the thing
 * a live pilot starves without. The audit row carries the operator's user id.
 */
export async function POST(req: Request) {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const orgId = guard.profile.orgId;
  if (!orgId) return orgRequired();

  const mode = pilotMode();
  if (mode !== "live") {
    return NextResponse.json(
      { error: "Per-dial approvals apply in live pilot mode only." },
      { status: 409 },
    );
  }

  const body = await parseJson(req);
  if (body === null) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "caseRef and decision (approve|decline) are required" },
      { status: 422 },
    );
  }
  const { caseRef, decision, note } = parsed.data;

  try {
    const row = await db.case.findFirst({
      where: { caseRef, orgId },
      select: { id: true, state: true },
    });
    if (!row) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }

    // The attempt the queue is on. The QUEUE owns the attempt ladder, so the
    // console asks it rather than counting audit rows itself.
    const attemptNo = await latestDialAttemptForCase(caseRef);

    if (decision === "approve") {
      await append({
        callRef: caseRef,
        action: "pilot",
        intent: pilotApprovalIntent(attemptNo),
        callerId: guard.profile.userId,
        meta: { decision, attemptNo, note: note ?? null, caseState: row.state },
        orgId,
      });
      // Wake the parked job. Without this the call waits out the delay the
      // approval gate put on it, and the fraud customer waits for no reason.
      const released = await releaseDialJobsForCase(caseRef);
      return NextResponse.json(
        {
          caseRef,
          decision,
          attemptNo,
          approved: await pilotDialApproved(caseRef, attemptNo, orgId),
          jobsReleased: released,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Decline. The intent is the CASE-level one, so it refuses every attempt
    // for the case: the operator said no to this alert, not just to this call.
    await append({
      callRef: caseRef,
      action: "pilot",
      intent: PILOT_DECLINE_INTENT,
      callerId: guard.profile.userId,
      meta: { decision, attemptNo, note: note ?? null, caseState: row.state },
      orgId,
    });
    // Dead-letter the jobs rather than merely parking them, so the case
    // cannot be dialled later by a worker that reclaims it. A CLAIMED row is
    // included deliberately: the worker's own CAS (`markDialStarted`) requires
    // the row to still be CLAIMED, so a row that has gone DEAD stops the dial.
    const stopped = await killDialJobsForCase(caseRef, "pilot_dial_declined");
    // REJECTED is a legal edge out of SCREENED and it is terminal, so the
    // operator's screen and the bank's view agree that this alert was
    // consciously not called.
    try {
      await transitionCase(caseRef, "REJECTED");
    } catch (err) {
      // A case that moved between the read and here may no longer have a legal
      // edge. The jobs are already dead-lettered, which is the control that
      // matters; the state is reported rather than forced.
      logError("[pilot-approvals] could not move the declined case to REJECTED", {
        caseRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return NextResponse.json(
      { caseRef, decision, attemptNo, approved: false, jobsStopped: stopped },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: `Dial decision could not be recorded: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 503 },
    );
  }
}
