/**
 * WP-4 Gate: post-call inbound webhook proves
 *   1. a forged signature is rejected (401, never 5xx),
 *   2. a stale timestamp is rejected even with a valid signature,
 *   3. an exact replay is idempotent (duplicate: true, no second audit write),
 *   4. a transcript containing a synthetic OTP/CVV/PAN is stored redacted (I-10),
 *   5. the case advances to NOTIFIED, and the chain verifies after ingest (I-6).
 *
 *   TEST_DATABASE_URL=<co-located postgres> bun test tests/webhooks/elevenlabs-inbound.test.ts
 */
import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { db } from "@/lib/db";
import { verifyChain } from "@/lib/audit-chain";

process.env.ELEVENLABS_DRY_RUN = "true";
process.env.AGENT_TOOL_SECRET = process.env.AGENT_TOOL_SECRET ?? "test-tool-secret";
process.env.AGENT_TOOL_ALLOWED = "card_freeze,human_handoff,verify_transaction,switch_language";
process.env.ELEVENLABS_WEBHOOK_SECRET =
  process.env.ELEVENLABS_WEBHOOK_SECRET ?? "0a1357ae77926d".repeat(4);

const RUN_ID = Date.now().toString(36);
const CONV_ID = `conv-webhook-${RUN_ID}`;
const WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET!;

function sign(body: string, t: string): string {
  const hex = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  return `t=${t},v0=${hex}`;
}

function postCallPayload(conversationId: string = CONV_ID): string {
  return JSON.stringify({
    type: "post_call_transcription",
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      agent_id: "agent_test",
      conversation_id: conversationId,
      status: "done",
      transcript: [
        { role: "agent", message: "We detected a charge of AED 2500. Did you make it?" },
        { role: "user", message: "No. My card number is 4242 4242 4242 4242." },
        { role: "agent", message: "I will stage a temporary freeze, thank you.", tool_calls: [{ tool_name: "verify_transaction" }] },
        { role: "user", message: "And the OTP they sent me was 88213. My CVV is 7342." },
      ],
      analysis: {
        evaluation_criteria_results: { identity_verified: { result: "success" } },
        data_collection_results: { outcome: { value: "fraud_confirmed" } },
        call_successful: "success",
        transcript_summary: "Customer denied a transaction and shared credentials.",
      },
      metadata: { call_duration_secs: 184 },
    },
  });
}

function bodyReq(body: string, sigHeader: string): Request {
  return new Request("http://localhost/api/webhooks/elevenlabs", {
    method: "POST",
    headers: { "content-type": "application/json", "elevenlabs-signature": sigHeader },
    body,
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("WP-4: post-call ingest verifies, dedupes, redacts, notifies", async () => {
  const { POST } = await import("@/app/api/webhooks/elevenlabs/route");
  type POSTReq = Parameters<typeof POST>[0];
  const asReq = (body: string, sig: string) => bodyReq(body, sig) as POSTReq;

  const c = await db.case.create({
    data: {
      caseRef: `SV-F-W${RUN_ID.toUpperCase()}`,
      orgId: "org-test",
      state: "CONFIRMED_FRAUD",
      conversationId: CONV_ID,
    },
  });

  const body = postCallPayload();

  // 1. Forged signature -> 401, never a 5xx
  const t = String(Math.floor(Date.now() / 1000));
  const forged = await POST(asReq(body, `t=${t},v0=${"ab".repeat(32)}`));
  expect(forged.status).toBe(401);

  // 2. Stale timestamp with an otherwise VALID signature -> 401
  const staleT = String(Math.floor(Date.now() / 1000) - 3600);
  const stale = await POST(asReq(body, sign(body, staleT)));
  expect(stale.status).toBe(401);

  // 3. Valid delivery -> 200, processing completes, case reaches NOTIFIED
  const ok = await POST(asReq(body, sign(body, t)));
  expect(ok.status).toBe(200);
  expect((await ok.json()).ok).toBe(true);

  const processed = await waitFor(async () => {
    const ev = await db.webhookEvent.findFirst({
      where: { conversationId: CONV_ID, eventType: "post_call_transcription" },
    });
    return ev?.processed === true;
  }, 20_000);
  expect(processed).toBe(true);

  const updated = await db.case.findUnique({ where: { id: c.id } });
  expect(updated?.state).toBe("NOTIFIED");
  expect(updated?.durationSeconds).toBe(184);
  expect(updated?.outcome).toBe("success");

  // Redaction (I-10): no OTP, CVV, or PAN anywhere in the stored transcript.
  const stored = updated?.transcriptRedacted ?? "";
  expect(stored).not.toContain("88213");
  expect(stored).not.toContain("7342");
  expect(stored).not.toContain("4242");
  expect(stored).toContain("[REDACTED]");

  // Chain verifies after ingest (I-6) and carries the ingest entry.
  // The ingest row is appended with `orgId: caseRow.orgId`, and the fixture
  // created the Case with `orgId: "org-test"` — so "org-test" owns this chain.
  const chain = await verifyChain(c.caseRef, "org-test");
  expect(chain.ok).toBe(true);
  const auditCountBefore = await db.auditLog.count({ where: { callRef: c.caseRef } });
  expect(auditCountBefore).toBeGreaterThan(0);

  // 4. Exact replay -> duplicate, zero new side effects (no second audit row)
  const replay = await POST(asReq(body, sign(body, t)));
  expect(replay.status).toBe(200);
  expect((await replay.json()).duplicate).toBe(true);
  const auditCountAfter = await db.auditLog.count({ where: { callRef: c.caseRef } });
  expect(auditCountAfter).toBe(auditCountBefore);
  const after = await db.case.findUnique({ where: { id: c.id } });
  expect(after?.state).toBe("NOTIFIED");

  // 5. Correlation failure -> quarantine, never dropped (WP-4 step 4)
  const orphanConv = `conv-webhook-orphan-${RUN_ID}`;
  const orphanBody = postCallPayload(orphanConv);
  const orphanT = String(Math.floor(Date.now() / 1000));
  const orphan = await POST(asReq(orphanBody, sign(orphanBody, orphanT)));
  expect(orphan.status).toBe(200);
  const quarantined = await waitFor(async () => {
    const q = await db.webhookQuarantine.findFirst({ where: { conversationId: orphanConv } });
    return q !== null;
  }, 20_000);
  expect(quarantined).toBe(true);
  const qrow = await db.webhookQuarantine.findFirst({ where: { conversationId: orphanConv } });
  expect(qrow?.reason).toBe("correlation_failed");
  // Even the quarantined excerpt is redacted (I-10 applies to every store).
  expect(qrow?.transcriptRedacted ?? "").not.toContain("4242");

  await db.$disconnect();
}, 120_000);
