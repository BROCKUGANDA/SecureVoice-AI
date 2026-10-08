import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { authorizeToolCall } from "@/lib/agent-tool-auth";
import { CASE_STATES } from "@/lib/case-state-machine";
import { append as auditAppend } from "@/lib/audit-chain";
import { db } from "@/lib/db";
import { badRequest, parseJson, unprocessable, schemaErrorCode } from "@/lib/api-errors";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

const TOOL_NAME = "switch_language";

const schema = z.strictObject({
  conversation_id: z.string().min(1).max(128),
  language: z
    .string()
    .min(2)
    .max(16)
    .regex(
      /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/,
      "language must be a BCP-47 tag such as en, ar, hi or ur-AE",
    ),
});

/**
 * Latency budget: this tool sits on the conversational critical path, so the
 * hot path is TWO database round trips — the tool-auth credential lookup and
 * the case write, where the case lookup and the state precondition are folded
 * into the UPDATE itself (`CTE target … UPDATE … WHERE id IN target`) rather
 * than a findFirst + update pair. Refusals pay a third round trip to type the
 * 409, which is fine: only happy-path latency counts against the p95 gate
 * (docs/VERIFICATION.md, WP-3).
 */
export async function POST(req: NextRequest) {
  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return unprocessable(
      "conversation_id and a valid language tag are required",
      schemaErrorCode(parsed.error),
    );
  }

  const { conversation_id } = parsed.data;
  const language = parsed.data.language.toLowerCase();

  // One round trip: the tenant credential lives in agentToolSecret, and the
  // comparison is constant-time over fixed-size hashes.
  const auth = await authorizeToolCall(req.headers.get("x-agent-tool-secret"), TOOL_NAME);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  // ONE round trip: existence + state precondition + write, atomically.
  let rows: { caseRef: string; state: string }[];
  try {
    rows = await db.$queryRaw<{ caseRef: string; state: string }[]>(Prisma.sql`
      WITH target AS (
        SELECT id FROM "Case"
        WHERE "conversationId" = ${conversation_id}
          AND state::text = ANY(${CASE_STATES})
        LIMIT 1
      )
      UPDATE "Case" c
      SET language = ${language}
      FROM target t
      WHERE c.id = t.id
      RETURNING c."caseRef" AS "caseRef", c.state::text AS "state"
    `);
  } catch (err) {
    logError("[tool/switch_language] guarded update failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: false, error: "case_update_failed" }, { status: 503 });
  }

  if (rows.length === 0) {
    // Refusal path — one extra round trip to distinguish the typed 409s.
    const existing = await db.$queryRaw<{ caseRef: string; state: string }[]>(Prisma.sql`
      SELECT "caseRef" AS "caseRef", state::text AS "state" FROM "Case"
      WHERE "conversationId" = ${conversation_id} LIMIT 1
    `);
    if (existing.length > 0) {
      // `existing.length > 0` above proves index 0 exists.
      const existingCase = existing[0]!;
      await auditAppend(
        {
          callRef: existingCase.caseRef,
          action: "agent",
          intent: `tool_refused_${TOOL_NAME}`,
          callerId: "agent-tool",
          meta: {
            tool: TOOL_NAME,
            state: existingCase.state,
            allowedStates: CASE_STATES,
            reason: "state_precondition_failed",
          },
        },
        { fast: true },
      ).catch(() => {});
      return NextResponse.json(
        {
          ok: false,
          error: `tool ${TOOL_NAME} cannot act on a case in state ${existingCase.state}`,
          code: "state_precondition_failed",
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "no live case for this conversation_id", code: "case_not_found" },
      { status: 409 },
    );
  }

  // `rows.length === 0` above returns on every branch, so rows has >= 1 row.
  const { caseRef, state } = rows[0]!;

  // Fire-and-forget: a reversible language preference must not add a second
  // round trip to the conversational critical path; the per-callRef chain lock
  // still serialises it behind any other append for this conversation.
  void auditAppend(
    {
      callRef: caseRef,
      action: "agent",
      intent: "switch_language",
      callerId: "agent-tool",
      meta: { tool: TOOL_NAME, to_language: language, state, source: "elevenlabs_agent_tool" },
    },
    { fast: true },
  ).catch(() => {});

  return NextResponse.json({
    ok: true,
    language,
    case_ref: caseRef,
    state,
  });
}
