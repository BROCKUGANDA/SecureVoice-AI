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
// The post-call ingest SEALS the payload (WP-15): without a master key it
// stores no evidence payload at all (that path is the second test in this
// file). This suite proves the sealed path, so it provisions one — the shape
// (64 hex chars) is what an operator generates for PRIVACY_MASTER_KEY.
process.env.PRIVACY_MASTER_KEY = "a".repeat(64);

const RUN_ID = Date.now().toString(36);
const CONV_ID = `conv-webhook-${RUN_ID}`;
/** The agent the payload names; the Organization below is bound to it. */
const INBOUND_AGENT_ID = "agent_test";
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
        {
          role: "agent",
          message: "I will stage a temporary freeze, thank you.",
          tool_calls: [{ tool_name: "verify_transaction" }],
        },
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

  // The inbound bleedguard resolves the tenant from the agent the event names,
  // so the fixture has to mirror production: a real Organization bound to the
  // agent, and the case owned by THAT org. Seeding the case against a bare
  // "org-test" string that no organization claims made the scoped lookup
  // correctly resolve nothing.
  const INBOUND_ORG_ID = "cccccccc-0000-4000-8000-cccccccccccc";
  await db.organization.upsert({
    where: { id: INBOUND_ORG_ID },
    create: {
      id: INBOUND_ORG_ID,
      name: "Inbound Test Tenant",
      slug: `inbound-test-${RUN_ID}`,
      createdAt: new Date(),
      elevenAgentId: INBOUND_AGENT_ID,
    },
    update: { elevenAgentId: INBOUND_AGENT_ID },
  });
  await db.case.update({ where: { id: c.id }, data: { orgId: INBOUND_ORG_ID } });

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

  // Sealed storage (WP-15): the plaintext columns were cleared once the
  // ciphertext was appended, so the Case row holds NO readable transcript —
  // the redaction claims are proven against the decrypted payload instead.
  expect(updated?.transcriptRedacted).toBeNull();
  expect(updated?.evaluationResults).toBeNull();
  expect(updated?.dataCollectionResults).toBeNull();
  const { readCasePayload } = await import("@/lib/privacy/crypto-shred");
  const payload = await readCasePayload(c.caseRef);
  const stored = payload.transcript ?? "";
  expect(stored).not.toContain("88213");
  expect(stored).not.toContain("7342");
  expect(stored).not.toContain("4242");
  expect(stored).toContain("[REDACTED]");
  // The analysis arrived redacted and neutralised, and is inside the seal too.
  const analysis = payload.analysis as { evaluation: unknown; data_collection: unknown };
  expect(analysis.evaluation).not.toBeNull();
  expect(analysis.data_collection).not.toBeNull();
  expect(JSON.stringify(analysis)).not.toContain("4242");

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

test("WP-15: without a master key the post-call payload is dropped, not stored in plaintext", async () => {
  const { POST } = await import("@/app/api/webhooks/elevenlabs/route");
  type POSTReq = Parameters<typeof POST>[0];
  const asReq = (body: string, sig: string) => bodyReq(body, sig) as POSTReq;

  const conv = `conv-webhook-nokey-${RUN_ID}`;
  const caseRef = `SV-F-N${RUN_ID.toUpperCase()}`;
  // Same tenant the first test bound to agent_test, so correlation resolves.
  const c = await db.case.create({
    data: {
      caseRef,
      orgId: "cccccccc-0000-4000-8000-cccccccccccc",
      state: "CONFIRMED_FRAUD",
      conversationId: conv,
    },
  });

  const savedKey = process.env.PRIVACY_MASTER_KEY;
  delete process.env.PRIVACY_MASTER_KEY;
  try {
    const body = postCallPayload(conv);
    const t = String(Math.floor(Date.now() / 1000));
    const ok = await POST(asReq(body, sign(body, t)));
    expect(ok.status).toBe(200);

    const processed = await waitFor(async () => {
      const ev = await db.webhookEvent.findFirst({
        where: { conversationId: conv, eventType: "post_call_transcription" },
      });
      return ev?.processed === true;
    }, 20_000);
    expect(processed).toBe(true);

    // The case still advances and the operational fields still land — the
    // failure mode of an unsealed payload is never "write it in plaintext".
    const row = await db.case.findUnique({ where: { id: c.id } });
    expect(row?.state).toBe("NOTIFIED");
    expect(row?.outcome).toBe("success");
    expect(row?.transcriptRedacted).toBeNull();
    expect(row?.evaluationResults).toBeNull();
    expect(row?.dataCollectionResults).toBeNull();

    // Nothing was sealed, and the drop is on the record rather than silent.
    expect(
      await db.auditLog.count({ where: { callRef: caseRef, intent: "payload_sealed_v1" } }),
    ).toBe(0);
    expect(
      await db.auditLog.count({ where: { callRef: caseRef, intent: "payload_unsealed_dropped" } }),
    ).toBe(1);

    // The chain still verifies with the drop row in it.
    const chain = await verifyChain(caseRef, "cccccccc-0000-4000-8000-cccccccccccc");
    expect(chain.ok).toBe(true);
  } finally {
    if (savedKey !== undefined) process.env.PRIVACY_MASTER_KEY = savedKey;
  }

  await db.$disconnect();
}, 120_000);
