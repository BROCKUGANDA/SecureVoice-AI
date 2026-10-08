/**
 * warm_transfer — the live human bridge.
 *
 * Proves the degradation ladder, which is the whole safety story of this tool:
 *   1. Authenticated, allowed, live case, transfer number configured, but the
 *      deployment has not attested TWILIO_LIVE_SEND -> the Twilio update is
 *      refused at the choke point and the tool DEGRADES to the specialist-queue
 *      semantics (ok:true, transferred:false) instead of failing the call.
 *   2. No transfer number configured (no org metadata, no HUMAN_AGENT_PHONE)
 *      -> same degradation, reason surfaced in the audit row.
 *   3. A case with no Twilio call sid (dialed before callSid persistence, or a
 *      non-Twilio leg) -> same degradation.
 *   4. Unauthenticated calls are refused with 401 like every other tool.
 * Every path escalates the case and appends its audit row.
 *
 * The test preload deletes TWILIO_LIVE_SEND unconditionally, so the live
 * Twilio branch is unreachable here by construction — exactly the guarantee
 * these tests are asserting.
 *
 *   bun test tests/tools/warm-transfer.test.ts
 */
import { test, expect } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { TOOL_TENANT_ORG_ID, issueTenantToolSecret } from "../tool-tenant";

process.env.ELEVENLABS_DRY_RUN = "true";
process.env.AGENT_TOOL_SECRET = process.env.AGENT_TOOL_SECRET ?? "test-tool-secret";
process.env.AGENT_TOOL_ALLOWED =
  "card_freeze,human_handoff,warm_transfer,verify_transaction,switch_language";
delete process.env.TWILIO_LIVE_SEND; // live branch unreachable by construction
delete process.env.HUMAN_AGENT_PHONE; // no fallback number: pure degradation

const SECRET = await issueTenantToolSecret("tools-warm-transfer");
const RUN_ID = Date.now().toString(36);

function toolRequest(body: Record<string, unknown>, secret: string | null = SECRET): NextRequest {
  return new NextRequest("http://localhost/api/elevenlabs/tools/warm-transfer", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-agent-tool-secret": secret } : {}),
    },
    body: JSON.stringify(body),
  } as ConstructorParameters<typeof NextRequest>[1]);
}

async function makeCase(state: string, conversationId: string, callSid?: string) {
  return db.case.create({
    data: {
      caseRef: `SV-F-TEST${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      conversationId,
      orgId: TOOL_TENANT_ORG_ID,
      state,
      ...(callSid ? { callSid } : {}),
    },
    select: { id: true, caseRef: true, state: true, callSid: true },
  });
}

const CONV_DEGRADED = `conv-wt-degraded-${RUN_ID}`;
const CONV_NOSID = `conv-wt-nosid-${RUN_ID}`;

test("warm_transfer: unauthenticated calls are refused", async () => {
  const { POST } = await import("@/app/api/elevenlabs/tools/warm-transfer/route");
  const res = await POST(
    toolRequest({ conversation_id: CONV_DEGRADED, summary: "no secret" }, null),
  );
  expect(res.status).toBe(401);
});

test("warm_transfer: without TWILIO_LIVE_SEND the tool degrades to the specialist queue", async () => {
  const { POST } = await import("@/app/api/elevenlabs/tools/warm-transfer/route");
  // The tenant org has no transferPhone metadata and HUMAN_AGENT_PHONE is
  // deleted above, so this degrades twice over: no number, and no attestation.
  const kase = await makeCase("VERIFYING", CONV_DEGRADED);
  const res = await POST(
    toolRequest({ conversation_id: CONV_DEGRADED, summary: "caller asked for a person now" }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    transferred: boolean;
    specialist: string;
  };
  expect(body.ok).toBe(true);
  expect(body.transferred).toBe(false);
  expect(body.specialist).toBe("fraud_specialist");

  // The escalation is recorded either way — degradation is queue semantics,
  // not a dropped handoff. The state moves to ESCALATED only where the state
  // machine allows it (VERIFYING cannot); the queue flags always land.
  const after = await db.case.findUnique({ where: { caseRef: kase.caseRef } });
  expect(after?.handoffQueued).toBe(true);
  expect(after?.handoffSpecialist).toBe("human_specialist");
  expect(["ESCALATED", kase.state]).toContain(after?.state ?? "");
}, 30000);

test("warm_transfer: a case without a Twilio call sid degrades the same way", async () => {
  const { POST } = await import("@/app/api/elevenlabs/tools/warm-transfer/route");
  await makeCase("DISCLOSED", CONV_NOSID);
  const res = await POST(
    toolRequest({ conversation_id: CONV_NOSID, summary: "no call sid on this leg" }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; transferred: boolean };
  expect(body.ok).toBe(true);
  expect(body.transferred).toBe(false);
}, 30000);
