import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requirePrivileged } from "@/lib/auth/guards";
import { caseByRef, transitionCase } from "@/lib/case-state-machine";
import { append } from "@/lib/audit-chain";
import { z } from "zod";

/**
 * POST /api/console/freeze/commit
 *
 * Commits a staged card freeze. This is the second actor in invariant I-1:
 * the agent stages `committed: false`, a human or bank system commits it.
 *
 * Requires step-up re-authentication (commit_freeze is a privileged action).
 * Only executable from FREEZE_STAGED state.
 */

const CommitFreezeBody = z.strictObject({
  caseRef: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  try {
    // 1. Auth + step-up (commit_freeze requires re-auth)
    const authed = await requirePrivileged(
      req.headers.get("cookie"),
      "commit_freeze"
    );
    if (!authed.ok) {
      return NextResponse.json(
        { error: authed.error, code: authed.code },
        { status: authed.status }
      );
    }

    // 2. Parse body strictly
    const bodyResult = CommitFreezeBody.safeParse(await req.json());
    if (!bodyResult.success) {
      return NextResponse.json(
        { error: "Invalid request body", code: "invalid_payload", details: bodyResult.error.issues },
        { status: 422 }
      );
    }
    const { caseRef, reason } = bodyResult.data;

    // 3. Look up the case
    const caseRow = await caseByRef(caseRef, authed.identity.orgId);
    if (!caseRow) {
      return NextResponse.json(
        { error: `Case not found: ${caseRef}`, code: "case_not_found" },
        { status: 404 }
      );
    }

    // 4. State precondition: must be FREEZE_STAGED
    if (caseRow.state !== "FREEZE_STAGED") {
      return NextResponse.json(
        {
          error: `Cannot commit freeze: case is ${caseRow.state}, expected FREEZE_STAGED`,
          code: "state_precondition_failed",
          caseRef,
          currentState: caseRow.state,
        },
        { status: 409 }
      );
    }

    // 5. Append audit row BEFORE the mutation
    await append({
      callRef: caseRef,
      action: "freeze",
      intent: "commit_freeze",
      redactedText: `Freeze committed by operator ${authed.identity.email}`,
      meta: {
        actorId: authed.identity.accountId,
        actorEmail: authed.identity.email,
        role: authed.role,
        reason: reason ?? null,
        committedAt: new Date().toISOString(),
      },
      orgId: caseRow.orgId ?? undefined,
    });

    // 6. Transition the case (FREEZE_STAGED → ESCALATED is the canonical next
    //    state). The freeze is committed; the case moves to escalation.
    //
    //    No extra fields are written here. This route previously passed
    //    `freezeCommittedBy` / `freezeCommittedAt` / `freezeReason` as
    //    transition meta, which `transitionCase` spreads straight into the
    //    Prisma `update` — and `Case` has no such columns, so EVERY commit
    //    returned 500. The commit record lives in the audit row above, which
    //    carries actorId, actorEmail, role, reason and committedAt.
    //
    //    KNOWN GAP: the Case row itself does not record who committed the
    //    freeze, so a case list cannot show it without walking the chain. The
    //    fix is three columns and a migration — deliberately not done here
    //    because a schema migration must not land while other work is in flight.
    await transitionCase(caseRef, "ESCALATED");

    // 7. Return success
    return NextResponse.json({
      committed: true,
      caseRef,
      committedBy: authed.identity.accountId,
      committedAt: new Date().toISOString(),
      nextState: "ESCALATED",
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (err instanceof Error && err.name === "IllegalTransitionError") {
      return NextResponse.json(
        { error: message, code: "state_precondition_failed" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Internal server error", code: "internal_error" },
      { status: 500 }
    );
  }
}
