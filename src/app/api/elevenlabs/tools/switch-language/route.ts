import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardToolCall } from "@/lib/tool-guard";
import { CASE_STATES } from "@/lib/case-state-machine";
import { append as auditAppend } from "@/lib/audit-chain";
import { db } from "@/lib/db";
import { badRequest, parseJson, unprocessable } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

const TOOL_NAME = "switch_language";

const schema = z.object({
  conversation_id: z.string().min(1).max(128),
  language: z
    .string()
    .min(2)
    .max(16)
    .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/, "language must be a BCP-47 tag such as en, ar, hi or ur-AE"),
});

export async function POST(req: NextRequest) {
  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return unprocessable("conversation_id and a valid language tag are required");
  }

  const { conversation_id } = parsed.data;
  const language = parsed.data.language.toLowerCase();

  const auth = await guardToolCall(TOOL_NAME, req.headers.get("x-agent-tool-secret"), conversation_id, CASE_STATES);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error, code: auth.code },
      { status: auth.status },
    );
  }

  const updated = await db.case.updateMany({
    where: { conversationId: conversation_id, state: { in: [...CASE_STATES] } },
    data: { language },
  });

  if (updated.count === 0) {
    return NextResponse.json(
      { ok: false, error: "no live case for this conversation_id", code: "case_not_found" },
      { status: 409 },
    );
  }

  void auditAppend({
    callRef: auth.caseRef,
    action: "agent",
    intent: "switch_language",
    callerId: "agent-tool",
    meta: {
      tool: TOOL_NAME,
      to_language: language,
      state: auth.state,
      source: "elevenlabs_agent_tool",
    },
  }, { fast: true }).catch(() => {});

  return NextResponse.json({
    ok: true,
    language,
    case_ref: auth.caseRef,
    state: auth.state,
  });
}
