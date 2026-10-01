import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { append as auditAppend } from "@/lib/audit-chain";
import { authorizeToolCall } from "@/lib/agent-tool-auth";
import { transcript as redactText } from "@/lib/redact";
import { badRequest, parseJson, unprocessable } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/**
 * `human_handoff` — the escalation tool, invoked by the ElevenLabs Agents
 * Platform as a webhook (server) tool.
 *
 * This is the failure/escalation path the Stage 2 brief explicitly requires a
 * demo of. The agent calls it on denial, distress, an explicit request for a
 * person, or any attempt to steer the agent off-policy.
 *
 * The agent's summary is untrusted caller-supplied text, so it is redacted
 * before it is written to the chain — a coached caller could otherwise talk a
 * summary full of PAN digits into the bank's audit record.
 */

const schema = z.object({
  case_id: z.string().min(3).max(64),
  summary: z.string().min(1).max(2000),
});

export async function POST(req: NextRequest) {
  const auth = authorizeToolCall(req.headers.get("x-agent-tool-secret"), "human_handoff");
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");

  const parsed = schema.safeParse(body);
  if (!parsed.success) return unprocessable("case_id and summary are required");

  const { case_id, summary } = parsed.data;
  const reference = `SV-HND-${case_id}`;

  try {
    await auditAppend({
      callRef: reference,
      action: "handoff",
      intent: "specialist_requested",
      redactedText: redactText(summary),
      meta: {
        stage: "queued_for_specialist",
        sla_seconds: 30,
        source: "elevenlabs_agent_tool",
        case_id,
      },
    });
  } catch (err) {
    console.error("[tool/human_handoff] audit append failed:", err);
    return NextResponse.json(
      { ok: false, error: "audit_unavailable" },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    reference,
    case_id,
    next_step: "A fraud specialist has been queued and will join the call.",
  });
}