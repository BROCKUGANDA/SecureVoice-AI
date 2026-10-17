import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { guardToolCall } from "@/lib/tool-guard";
import { canTransition, transitionCase, IllegalTransitionError } from "@/lib/case-state-machine";
import { append as auditAppend } from "@/lib/audit-chain";
import { db } from "@/lib/db";
import { makeFailure, type FailureCode, type FailureInit } from "@/lib/failures/envelope";
import { transcript as redactText } from "@/lib/redact";
import { openCaseHandoffTicket } from "@/lib/crm/case-ticket";
import { logError, parseJson } from "@/lib/validation/safe-log";

function failure(code: FailureCode, init: FailureInit = {}): NextResponse {
  const f = makeFailure(code, init);
  return NextResponse.json(f.body, {
    status: f.status,
    headers: { ...f.headers, "Cache-Control": "no-store" },
  });
}

export const dynamic = "force-dynamic";

const TOOL_NAME = "human_handoff";
const ALLOWED_STATES = [
  "DISCLOSED",
  "VERIFYING",
  "CONFIRMED_FRAUD",
  "CONFIRMED_LEGITIMATE",
  "UNCERTAIN",
  "FREEZE_STAGED",
];
const HANDOFF_SPECIALIST = "fraud_specialist";
const ETA_SECS = 120;
const QUEUE_POSITION = 1;

const schema = z.strictObject({
  conversation_id: z.string().min(1).max(128),
  summary: z.string().min(1).max(2000),
});

export async function POST(req: NextRequest) {
  const body = await parseJson(req);
  if (body === null) return failure("malformed_request", { detail: "Invalid JSON body" });

  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return failure("semantically_invalid", { detail: "conversation_id and summary are required" });

  const { conversation_id, summary } = parsed.data;

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

  const escalates = canTransition(guard.state, "ESCALATED");

  try {
    await auditAppend({
      callRef: guard.caseRef,
      action: "handoff",
      intent: "human_handoff",
      callerId: "agent-tool",
      redactedText: redactText(summary),
      meta: {
        tool: TOOL_NAME,
        stage: "queued_for_specialist",
        specialist: HANDOFF_SPECIALIST,
        eta_secs: ETA_SECS,
        queue_position: QUEUE_POSITION,
        from: guard.state,
        to: escalates ? "ESCALATED" : null,
        escalated: escalates,
        source: "elevenlabs_agent_tool",
      },
    });
  } catch (err) {
    // A refused handoff is a fraud action that did not happen; log the case
    // it belonged to so it can be traced without a database query.
    logError("human_handoff audit append failed", {
      tool: TOOL_NAME,
      caseRef: guard.caseRef,
      from: guard.state,
      error: err,
    });
    return failure("dependency_unavailable", { detail: "audit_unavailable", retryAfterSec: 1 });
  }

  let state: string = guard.state;
  try {
    if (escalates) {
      const updated = await transitionCase(guard.caseRef, "ESCALATED", {
        handoffQueued: true,
        handoffSpecialist: HANDOFF_SPECIALIST,
      });
      state = updated.state;
    } else {
      await db.case.update({
        where: { caseRef: guard.caseRef },
        data: { handoffQueued: true, handoffSpecialist: HANDOFF_SPECIALIST },
        select: { id: true },
      });
    }
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      logError("handoff escalation refused by the state machine, queueing the specialist only", {
        tool: TOOL_NAME,
        caseRef: guard.caseRef,
        from: guard.state,
        error: err,
      });
      await db.case
        .update({
          where: { caseRef: guard.caseRef },
          data: { handoffQueued: true, handoffSpecialist: HANDOFF_SPECIALIST },
          select: { id: true },
        })
        .catch(() => {});
    } else {
      logError("human_handoff queue write failed", {
        tool: TOOL_NAME,
        caseRef: guard.caseRef,
        from: guard.state,
        error: err,
      });
      return failure("dependency_unavailable", {
        detail: "handoff_queue_failed",
        retryAfterSec: 1,
      });
    }
  }

  // The queue row is written; now tell the institution through ITS OWN CRM.
  // Fire-and-forget and never-fatal by design: the agent is holding a live
  // caller, and a CRM that is down must not turn into a refused handoff.
  // `human_review` is the reason the ticket contract already declared and no
  // voice path ever sent.
  void openCaseHandoffTicket(guard.caseRef, "human_review", "urgent").catch(() => {});

  return NextResponse.json({
    ok: true,
    specialist: HANDOFF_SPECIALIST,
    eta_secs: ETA_SECS,
    queue_position: QUEUE_POSITION,
    case_ref: guard.caseRef,
    state,
  });
}
