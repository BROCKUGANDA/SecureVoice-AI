import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardToolCall } from "@/lib/tool-guard";
import { canTransition, transitionCase, IllegalTransitionError } from "@/lib/case-state-machine";
import { append as auditAppend } from "@/lib/audit-chain";
import { db } from "@/lib/db";
import { transcript as redactText } from "@/lib/redact";
import { badRequest, parseJson, unprocessable } from "@/lib/api-errors";

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

const schema = z.object({
  conversation_id: z.string().min(1).max(128),
  summary: z.string().min(1).max(2000),
});

export async function POST(req: NextRequest) {
  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");

  const parsed = schema.safeParse(body);
  if (!parsed.success) return unprocessable("conversation_id and summary are required");

  const { conversation_id, summary } = parsed.data;

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
    console.error("[tool/human_handoff] audit append failed, refusing handoff:", err);
    return NextResponse.json({ ok: false, error: "audit_unavailable" }, { status: 503 });
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
      console.error(
        "[tool/human_handoff] escalation refused by the state machine, queueing the specialist only:",
        err,
      );
      await db.case
        .update({
          where: { caseRef: guard.caseRef },
          data: { handoffQueued: true, handoffSpecialist: HANDOFF_SPECIALIST },
          select: { id: true },
        })
        .catch(() => {});
    } else {
      console.error("[tool/human_handoff] handoff queue write failed:", err);
      return NextResponse.json({ ok: false, error: "handoff_queue_failed" }, { status: 503 });
    }
  }

  return NextResponse.json({
    ok: true,
    specialist: HANDOFF_SPECIALIST,
    eta_secs: ETA_SECS,
    queue_position: QUEUE_POSITION,
    case_ref: guard.caseRef,
    state,
  });
}
