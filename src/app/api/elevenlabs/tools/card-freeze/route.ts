import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardToolCall } from "@/lib/tool-guard";
import { transitionCase, IllegalTransitionError } from "@/lib/case-state-machine";
import { append as auditAppend } from "@/lib/audit-chain";
import { badRequest, parseJson, unprocessable, schemaErrorCode } from "@/lib/api-errors"

export const dynamic = "force-dynamic";

const TOOL_NAME = "card_freeze";
const ALLOWED_STATES = ["CONFIRMED_FRAUD"];
const REVERSAL_WINDOW_SECS = 300;

const schema = z.strictObject({
  conversation_id: z.string().min(1).max(128),
  account_id: z.string().min(2).max(64),
  reason_code: z.string().min(3).max(64),
});

export async function POST(req: NextRequest) {
  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return unprocessable("conversation_id, account_id and reason_code are required", schemaErrorCode(parsed.error));
  }

  const { conversation_id, account_id, reason_code } = parsed.data;

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

  const reference = `SV-FRZ-${guard.caseRef}`;

  try {
    await auditAppend({
      callRef: guard.caseRef,
      action: "freeze",
      intent: "freeze_staged",
      callerId: "agent-tool",
      redactedText: account_id,
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
    console.error("[tool/card_freeze] audit append failed, refusing freeze:", err);
    return NextResponse.json(
      { ok: false, staged: false, committed: false, error: "audit_unavailable" },
      { status: 503 },
    );
  }

  try {
    const updated = await transitionCase(guard.caseRef, "FREEZE_STAGED", {
      freezeStaged: true,
      freezeReference: reference,
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
      return NextResponse.json(
        { ok: false, staged: false, committed: false, error: `case cannot move from ${guard.state} to FREEZE_STAGED`, code: "illegal_transition" },
        { status: 409 },
      );
    }
    console.error("[tool/card_freeze] case transition failed:", err);
    return NextResponse.json(
      { ok: false, staged: false, committed: false, error: "case_transition_failed" },
      { status: 503 },
    );
  }
}
