import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { guardToolCall } from "@/lib/tool-guard";
import { canTransition, transitionCase, IllegalTransitionError } from "@/lib/case-state-machine";
import { append as auditAppend } from "@/lib/audit-chain";
import {
  makeFailure,
  type FailureCode,
  type FailureInit,
} from "@/lib/failures/envelope";
import { logError, parseJson } from "@/lib/validation/safe-log";

function failure(code: FailureCode, init: FailureInit = {}): NextResponse {
  const f = makeFailure(code, init);
  return NextResponse.json(f.body, {
    status: f.status,
    headers: { ...f.headers, "Cache-Control": "no-store" },
  });
}

export const dynamic = "force-dynamic";

const TOOL_NAME = "verify_transaction";
const ALLOWED_STATES = ["DISCLOSED", "VERIFYING"];

const DISPOSITION = {
  confirmed_fraud: { to: "CONFIRMED_FRAUD", next_prompt_key: "stage_freeze" },
  confirmed_legitimate: { to: "CONFIRMED_LEGITIMATE", next_prompt_key: "close_case" },
  uncertain: { to: "UNCERTAIN", next_prompt_key: "human_handoff" },
} as const;

const schema = z.strictObject({
  conversation_id: z.string().min(1).max(128),
  outcome: z.enum(["confirmed_fraud", "confirmed_legitimate", "uncertain"]),
});

export async function POST(req: NextRequest) {
  const body = await parseJson(req);
  if (body === null) return failure("malformed_request", {detail: "Invalid JSON body"});

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return failure("semantically_invalid", {detail: "conversation_id and outcome (confirmed_fraud | confirmed_legitimate | uncertain) are required"});
  }

  const { conversation_id, outcome } = parsed.data;
  const { to, next_prompt_key } = DISPOSITION[outcome];

  const guard = await guardToolCall(
    TOOL_NAME,
    req.headers.get("x-agent-tool-secret"),
    conversation_id,
    ALLOWED_STATES,
  );
  if (!guard.ok) {
    return failure(guard.status === 401 ? "unauthenticated" : guard.status === 403 ? "not_found" : "state_conflict", {detail: guard.error});
  }

  if (!canTransition(guard.state, to)) {
    await auditAppend(
      {
        callRef: guard.caseRef,
        action: "agent",
        intent: `tool_refused_${TOOL_NAME}`,
        callerId: "agent-tool",
        meta: {
          tool: TOOL_NAME,
          outcome,
          from: guard.state,
          to,
          reason: "illegal_transition",
          source: "elevenlabs_agent_tool",
        },
      },
      { fast: true },
    ).catch(() => {});
    return failure("state_conflict", {detail: `case cannot move from ${guard.state} to ${to}`});
  }

  try {
    await auditAppend({
      callRef: guard.caseRef,
      action: "agent",
      intent: `${TOOL_NAME}_${outcome}`,
      callerId: "agent-tool",
      meta: {
        tool: TOOL_NAME,
        outcome,
        from: guard.state,
        to,
        next_prompt_key,
        source: "elevenlabs_agent_tool",
      },
    });
  } catch (err) {
    logError("[tool/verify-transaction] audit append failed, refusing disposition", {
      tool: TOOL_NAME,
      error: err instanceof Error ? err.message : String(err),
    });
    return failure("dependency_unavailable", {detail: "audit_unavailable", retryAfterSec: 1});
  }

  try {
    const updated = await transitionCase(guard.caseRef, to);
    return NextResponse.json({
      ok: true,
      outcome,
      next_prompt_key,
      case_ref: guard.caseRef,
      state: updated.state,
    });
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      return failure("state_conflict", {detail: `case cannot move from ${guard.state} to ${to}`});
    }
    logError("[tool/verify-transaction] case transition failed", {
      tool: TOOL_NAME,
      error: err instanceof Error ? err.message : String(err),
    });
    return failure("dependency_unavailable", {detail: "case_transition_failed", retryAfterSec: 1});
  }
}
