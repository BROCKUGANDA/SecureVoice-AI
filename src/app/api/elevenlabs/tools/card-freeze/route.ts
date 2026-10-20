import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { guardToolCall } from "@/lib/tool-guard";
import { transitionCase, IllegalTransitionError } from "@/lib/case-state-machine";
import { recordSpanAndPersist } from "@/lib/telemetry/store";
import { db } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";
import { makeFailure, type FailureCode, type FailureInit } from "@/lib/failures/envelope";
import { env } from "@/lib/config";
import { logError, parseJson } from "@/lib/validation/safe-log";

function failure(code: FailureCode, init: FailureInit = {}): NextResponse {
  const f = makeFailure(code, init);
  return NextResponse.json(f.body, {
    status: f.status,
    headers: { ...f.headers, "Cache-Control": "no-store" },
  });
}

export const dynamic = "force-dynamic";

const TOOL_NAME = "card_freeze";
const ALLOWED_STATES = ["CONFIRMED_FRAUD"];
const REVERSAL_WINDOW_SECS = env.reversalWindowSecs;

const schema = z.strictObject({
  conversation_id: z.string().min(1).max(128),
  account_id: z.string().min(2).max(64),
  reason_code: z.string().min(3).max(64),
});

export async function POST(req: NextRequest) {
  const body = await parseJson(req);
  if (body === null) return failure("malformed_request", { detail: "Invalid JSON body" });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return failure("semantically_invalid", {
      detail: "conversation_id, account_id and reason_code are required",
    });
  }

  const { conversation_id, account_id, reason_code } = parsed.data;

  const guard = await guardToolCall(
    TOOL_NAME,
    req.headers.get("x-agent-tool-secret"),
    conversation_id,
    ALLOWED_STATES,
  );
  if (!guard.ok) {
    return failure(
      guard.status === 401
        ? "unauthenticated"
        : guard.status === 403
          ? "not_found"
          : "state_conflict",
      { detail: guard.error },
    );
  }

  const reference = `SV-FRZ-${guard.caseRef}`;

  try {
    await auditAppend({
      callRef: guard.caseRef,
      action: "freeze",
      intent: "freeze_staged",
      callerId: "agent-tool",
      redactedText: account_id,
      orgId: guard.orgId ?? undefined,
      meta: {
        tool: TOOL_NAME,
        stage: "pending_specialist",
        committed: false,
        reversal_window_secs: REVERSAL_WINDOW_SECS,
        reference,
        reason_code,
        from: guard.state,
        to: "FREEZE_STAGED",
        source: "elevenlabs_agent_tool",
      },
    });
  } catch (err) {
    // A freeze that could not be audited is refused (I-2); log which case
    // asked for it so the refusal is attributable without a database query.
    logError("card_freeze audit append failed", {
      tool: TOOL_NAME,
      caseRef: guard.caseRef,
      from: guard.state,
      error: err,
    });
    return failure("dependency_unavailable", { detail: "audit_unavailable", retryAfterSec: 1 });
  }

  try {
    const updated = await transitionCase(guard.caseRef, "FREEZE_STAGED", {
      freezeStaged: true,
      freezeReference: reference,
    });
    // Latency instrumentation (WP-7): the brief's headline span ends here. The
    // signal arrived when the case was created; the freeze is staged now. Both
    // endpoints are real executions of those two events, not approximated.
    const caseRow = await db.case.findUnique({ where: { caseRef: guard.caseRef } });
    // Always record — a failed lookup must not lose the span silently. The
    // start is the case's creation when we have it, else the guard's entry.
    const startedAt = caseRow ? caseRow.createdAt.getTime() : Date.now();
    recordSpanAndPersist({
      span: "signal_received_to_freeze_staged",
      startedAtMs: startedAt,
      endedAtMs: Date.now(),
      caseRef: guard.caseRef,
    });

    return NextResponse.json({
      ok: true,
      staged: true,
      committed: false,
      reversal_window_secs: REVERSAL_WINDOW_SECS,
      reference,
      case_ref: guard.caseRef,
      state: updated.state,
    });
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      return failure("state_conflict", {
        detail: `case cannot move from ${guard.state} to FREEZE_STAGED`,
      });
    }
    logError("card_freeze case transition failed", {
      tool: TOOL_NAME,
      caseRef: guard.caseRef,
      from: guard.state,
      error: err,
    });
    return failure("dependency_unavailable", {
      detail: "case_transition_failed",
      retryAfterSec: 1,
    });
  }
}
