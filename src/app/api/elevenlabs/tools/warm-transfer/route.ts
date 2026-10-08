import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { guardToolCall } from "@/lib/tool-guard";
import { canTransition, transitionCase, IllegalTransitionError } from "@/lib/case-state-machine";
import { append as auditAppend } from "@/lib/audit-chain";
import { db } from "@/lib/db";
import { transcript as redactText } from "@/lib/redact";
import { badRequest, parseJson, unprocessable, schemaErrorCode } from "@/lib/api-errors";
import { getTransferNumber } from "@/lib/institution";
import { transferCallToSpecialist } from "@/lib/twilio";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

const TOOL_NAME = "warm_transfer";
const ALLOWED_STATES = [
  "DISCLOSED",
  "VERIFYING",
  "CONFIRMED_FRAUD",
  "CONFIRMED_LEGITIMATE",
  "UNCERTAIN",
  "FREEZE_STAGED",
];
const SPECIALIST = "human_specialist";
const ETA_SECS = 120;
const QUEUE_POSITION = 1;

const schema = z.strictObject({
  conversation_id: z.string().min(1).max(128),
  summary: z.string().min(1).max(2000),
});

/**
 * warm_transfer — bridge the LIVE call to a human specialist's phone.
 *
 * The agent says the transfer line in the caller's language FIRST (this tool
 * rewrites the Twilio leg's TwiML, which is what ends the AI's audio), then
 * invokes this tool. Twilio dials the specialist and bridges the customer;
 * the platform agent leg is gone by design.
 *
 * Degradation is deliberate, never fatal: with no transfer number configured,
 * or without the live-fire attestation (TWILIO_LIVE_SEND=true — a TwiML update
 * reaches Twilio's API exactly like a dial), the tool falls back to the
 * human_handoff queue semantics so the customer is told a specialist will
 * follow up rather than the call failing.
 */
export async function POST(req: NextRequest) {
  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");

  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return unprocessable("conversation_id and summary are required", schemaErrorCode(parsed.error));

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

  // The transfer destination and the Twilio leg both live on the case row.
  const row = await db.case.findUnique({
    where: { caseRef: guard.caseRef },
    select: { orgId: true, callSid: true, phone: true },
  });

  const specialist = await getTransferNumber(row?.orgId ?? null);
  const callSid = row?.callSid ?? null;
  const transferable = specialist !== null && callSid !== null;

  let transferred = false;
  let transferError: string | null = null;
  if (transferable) {
    const res = await transferCallToSpecialist({ callSid: callSid!, specialist: specialist! });
    if (res.ok) {
      transferred = true;
    } else {
      // Live gate, bad number, or Twilio outage: degrade, never fail the call.
      transferError = res.error.slice(0, 200);
    }
  }

  try {
    await auditAppend({
      callRef: guard.caseRef,
      action: "handoff",
      intent: transferred ? "warm_transferred" : "warm_transfer_degraded",
      callerId: "agent-tool",
      redactedText: redactText(summary),
      meta: {
        tool: TOOL_NAME,
        transferred,
        specialist: transferred ? SPECIALIST : "fraud_specialist",
        ...(transferError ? { transferError } : {}),
        ...(transferable
          ? {}
          : { reason: specialist === null ? "no_transfer_number" : "no_call_sid" }),
        from: guard.state,
        source: "elevenlabs_agent_tool",
      },
    });
  } catch (err) {
    logError("[tool/warm_transfer] audit append failed, refusing transfer", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: "audit_unavailable" }, { status: 503 });
  }

  // Escalate like human_handoff does — the specialist follow-up queue is the
  // record of truth whether or not the live bridge succeeded.
  let state: string = guard.state;
  try {
    if (canTransition(guard.state, "ESCALATED")) {
      const updated = await transitionCase(guard.caseRef, "ESCALATED", {
        handoffQueued: true,
        handoffSpecialist: SPECIALIST,
      });
      state = updated.state;
    } else {
      await db.case.update({
        where: { caseRef: guard.caseRef },
        data: { handoffQueued: true, handoffSpecialist: SPECIALIST },
        select: { id: true },
      });
    }
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      await db.case
        .update({
          where: { caseRef: guard.caseRef },
          data: { handoffQueued: true, handoffSpecialist: SPECIALIST },
          select: { id: true },
        })
        .catch(() => {});
    } else {
      logError("[tool/warm_transfer] escalation write failed", { error: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ ok: false, error: "handoff_queue_failed" }, { status: 503 });
    }
  }

  return NextResponse.json({
    ok: true,
    transferred,
    specialist: transferred ? SPECIALIST : "fraud_specialist",
    ...(transferred ? {} : { eta_secs: ETA_SECS, queue_position: QUEUE_POSITION }),
    case_ref: guard.caseRef,
    state,
  });
}
