import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardToolCall } from "@/lib/tool-guard";
import { canTransition, transitionCase, IllegalTransitionError } from "@/lib/case-state-machine";
import { append as auditAppend } from "@/lib/audit-chain";
import { badRequest, parseJson, unprocessable, schemaErrorCode } from "@/lib/api-errors"

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
  if (body === null) return badRequest("Invalid JSON body");

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return unprocessable("conversation_id and outcome (confirmed_fraud | confirmed_legitimate | uncertain) are required", schemaErrorCode(parsed.error));
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
    return NextResponse.json(
      { ok: false, error: guard.error, code: guard.code },
      { status: guard.status },
    );
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
    return NextResponse.json(
      { ok: false, error: `case cannot move from ${guard.state} to ${to}`, code: "illegal_transition" },
      { status: 409 },
    );
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
    console.error(`[tool/${TOOL_NAME}] audit append failed, refusing disposition:`, err);
    return NextResponse.json({ ok: false, error: "audit_unavailable" }, { status: 503 });
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
      return NextResponse.json(
        { ok: false, error: `case cannot move from ${guard.state} to ${to}`, code: "illegal_transition" },
        { status: 409 },
      );
    }
    console.error(`[tool/${TOOL_NAME}] case transition failed:`, err);
    return NextResponse.json({ ok: false, error: "case_transition_failed" }, { status: 503 });
  }
}
