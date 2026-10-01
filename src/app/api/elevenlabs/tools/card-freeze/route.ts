import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { append as auditAppend } from "@/lib/audit-chain";
import { authorizeToolCall } from "@/lib/agent-tool-auth";
import { badRequest, parseJson, unprocessable } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/**
 * `card_freeze` — the high-stakes action, invoked by the ElevenLabs Agents
 * Platform as a webhook (server) tool.
 *
 * THE CENTRAL GUARDRAIL, and it is a property of this endpoint rather than of
 * the prompt: a freeze raised by the agent is a PAUSE, never a commit.
 *
 *   The agent may call this the instant a customer denies the transaction. What
 *   it may not do is settle the outcome. The write here marks the card
 *   `pending_specialist` and returns `committed: false`. The card processor is
 *   not touched. Only when a human fraud specialist confirms in the console
 *   does the freeze become final.
 *
 * That inversion is deliberate: the agent's judgement is allowed to be fast and
 * wrong about a *reversible* thing, and is never allowed to be right about an
 * irreversible thing on its own. Policy section 3 of SV-FDP-2026-01.
 *
 * Auth: shared secret + per-caller tool scope (see lib/agent-tool-auth).
 */

const schema = z.object({
  account_id: z.string().min(2).max(64),
  reason_code: z.string().min(3).max(64),
  case_id: z.string().min(3).max(64),
});

export async function POST(req: NextRequest) {
  const auth = authorizeToolCall(req.headers.get("x-agent-tool-secret"), "card_freeze");
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return unprocessable("account_id, reason_code and case_id are required");
  }

  const { account_id, reason_code, case_id } = parsed.data;
  const reference = `SV-FRZ-${case_id}`;

  // A freeze request is itself a recordable event — including the fact that it
  // stopped short of committing. If the audit write fails we must NOT proceed,
  // because an unlogged freeze is exactly the state the regulator asks about.
  try {
    await auditAppend({
      callRef: reference,
      action: "freeze",
      intent: reason_code,
      redactedText: account_id,
      meta: {
        stage: "pending_specialist",
        committed: false,
        source: "elevenlabs_agent_tool",
        reason_code,
        case_id,
      },
    });
  } catch (err) {
    // Fail closed: no audit row means no freeze.
    console.error("[tool/card_freeze] audit append failed, refusing freeze:", err);
    return NextResponse.json(
      { ok: false, committed: false, error: "audit_unavailable" },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    committed: false,
    reference,
    case_id,
    // Read back to the agent so it tells the customer the truth: paused, not blocked.
    next_step: "A fraud specialist must confirm this freeze before it becomes final.",
  });
}