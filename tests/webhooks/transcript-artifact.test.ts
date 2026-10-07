/**
 * Transcript-artifact gate — the committed per-conversation record the Stage 2
 * "Transcripts + post-call analysis" row asks for.
 *
 * It drives ONE conversation through the real path end to end and writes what
 * that path actually produced:
 *
 *   1. placement   — the REAL adapter (`placeOutboundCall`, the only caller of
 *                    the vendor dial endpoint), in DRY-RUN: no speech is
 *                    synthesised and no vendor call occurs.
 *   2. ingest      — a signed `post_call_transcription` delivery through the
 *                    REAL webhook route: signature verify, dedupe, enqueue.
 *   3. processing  — the REAL `handleTranscription`: redaction, memory screen,
 *                    audit append, payload SEAL, state transition, outbox.
 *
 * The artifact says which of those legs is real and which is synthetic — a
 * dry-run transcript must never be presented as vendor evidence. The synthetic
 * leg is only the conversation CONTENT (a fixture of the exact shape the vendor
 * posts, including a customer volunteering a PAN/OTP/CVV, because that is the
 * redaction path the artifact exists to demonstrate). Every persisted output
 * below is this deployment's real runtime output, re-readable from the test
 * database and the audit chain.
 */

import { test, expect } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";
import { verifyChain } from "@/lib/audit-chain";
import { readCasePayload } from "@/lib/privacy/crypto-shred";
import { placeOutboundCall } from "@/lib/elevenlabs/outbound-call";

process.env.ELEVENLABS_DRY_RUN = "true";
process.env.ELEVENLABS_WEBHOOK_SECRET =
  process.env.ELEVENLABS_WEBHOOK_SECRET ?? "0a1357ae77926d".repeat(4);
// The ingest SEALS the payload (WP-15); without a master key nothing is stored
// and this gate would have no artifact to write. Shape is what an operator
// generates for PRIVACY_MASTER_KEY.
process.env.PRIVACY_MASTER_KEY = "a".repeat(64);

const RUN_ID = Date.now().toString(36);
const CASE_REF = `SV-F-T${RUN_ID.toUpperCase()}`;
const AGENT_ID = `agent_tr_${RUN_ID}`;
const ORG_ID = "dddddddd-0000-4000-8000-dddddddddddd";
const TO_NUMBER = "+971500000001";
const WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET!;
const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * The conversation content, in the vendor's own post-call schema — the same
 * shape `handleTranscription` consumes in production. The customer turn is the
 * one that matters: a third party coached them to read out a card number, an
 * OTP and a CVV, so the committed artifact proves the redaction pipeline ate
 * every credential shape before anything was persisted.
 */
function postCallData(conversationId: string) {
  return {
    agent_id: AGENT_ID,
    conversation_id: conversationId,
    status: "done",
    transcript: [
      {
        role: "agent",
        message:
          "Hello, this call is recorded for your protection. I am an AI security assistant calling from your bank about a transaction on your card. A card payment of 2,500 dirhams was just attempted in another country. Did you authorise it?",
        time_in_call_secs: 0.8,
      },
      {
        role: "user",
        message:
          "No, I did not. But the other caller told me to read out my card number so they can cancel it. It is 4242 4242 4242 4242.",
        time_in_call_secs: 11.4,
      },
      {
        role: "agent",
        message:
          "Please do not share card details — I will never ask for them, and your bank will never call to request a code. I am staging a temporary freeze on the card now.",
        tool_calls: [{ tool_name: "verify_transaction" }, { tool_name: "card_freeze" }],
        time_in_call_secs: 19.7,
      },
      {
        role: "user",
        message:
          "They also sent me a one-time code, 88213, and asked for the CVV, 7342. I did not give them.",
        time_in_call_secs: 33.1,
      },
      {
        role: "agent",
        message:
          "Good that you refused. The freeze is staged and a fraud specialist will confirm the permanent block with you.",
        time_in_call_secs: 41.9,
      },
    ],
    analysis: {
      call_successful: "success",
      evaluation_criteria_results: {
        identity_verified: { result: "success" },
        disclosure_acknowledged: { result: "success" },
      },
      data_collection_results: { fraud_confirmed: { value: "yes" } },
      transcript_summary:
        "Customer denied the transaction; a third party was coaching them to share card credentials; freeze staged.",
    },
    metadata: { call_duration_secs: 47 },
  };
}

function sign(body: string, t: string): string {
  const hex = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  return `t=${t},v0=${hex}`;
}

function bodyReq(body: string, sigHeader: string): Request {
  return new Request("http://localhost/api/webhooks/elevenlabs", {
    method: "POST",
    headers: { "content-type": "application/json", "elevenlabs-signature": sigHeader },
    body,
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Split the persisted redacted transcript back into turns for rendering. */
type PersistedTurn = { speaker: string; text: string };

type TranscriptArtifact = {
  schema_version: string;
  artifact: string;
  case_ref: string;
  conversation_id: string;
  captured_at: string;
  mode: {
    dial: string;
    vendor_evidence: boolean;
    conversation_content: string;
    explanation: string;
  };
  placement: {
    adapter: string;
    via: string;
    dry_run: boolean;
    call_sid: string | null;
  };
  ingest: {
    handler: string;
    event_type: string;
    signature: string;
    processed: boolean;
  };
  transcript: {
    redacted: boolean;
    provenance: string;
    turns: PersistedTurn[];
  };
  post_call_analysis: {
    outcome: string | null;
    duration_seconds: number | null;
    billed_minutes: unknown;
    tool_calls_observed: { count: number; names: string[]; note: string };
    voicemail: boolean;
    memory_poisoning_screen: unknown;
    evaluation: unknown;
    data_collection: unknown;
  };
  persistence: {
    sealed: boolean;
    plaintext_columns_cleared: boolean;
    case_state_after_ingest: string | null;
    audit_chain: { verified: boolean; entries: number };
  };
  bank_notification: {
    event: string;
    outbox_state: string;
    transcript_field: string | null;
    note: string;
  };
};

function parsePersistedTurns(stored: string): PersistedTurn[] {
  return stored
    .split("\n")
    .map((line) => /^\[(agent|user|unknown)\] (.*)$/s.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      speaker: m[1] === "user" ? "customer" : m[1] === "agent" ? "agent" : "system",
      text: m[2] ?? "",
    }));
}

test("transcript gate: one conversation through the real path, committed with its mode", async () => {
  // ── 1. Placement — the real adapter, dry-run ────────────────────────────────
  const placement = await placeOutboundCall({
    toNumber: TO_NUMBER,
    language: "en",
    caseRef: CASE_REF,
    dynamicVariables: {
      customer_name: "Test Customer",
      amount: "2500",
      merchant: "Electronics World",
    },
  });
  expect(placement.dryRun).toBe(true);
  expect(placement.conversationId).toBe(`conv_dryrun_${CASE_REF}`);
  const conversationId = placement.conversationId!;

  // ── the tenant + case the ingest correlates against ─────────────────────────
  await db.organization.upsert({
    where: { id: ORG_ID },
    create: {
      id: ORG_ID,
      name: "Transcript Gate Tenant",
      slug: `transcript-gate-${RUN_ID}`,
      createdAt: new Date(),
      elevenAgentId: AGENT_ID,
    },
    update: { elevenAgentId: AGENT_ID },
  });
  await db.case.create({
    data: {
      caseRef: CASE_REF,
      orgId: ORG_ID,
      state: "CONFIRMED_FRAUD",
      conversationId,
    },
  });

  // ── 2-3. Signed delivery through the real route; real processing ────────────
  const { POST } = await import("@/app/api/webhooks/elevenlabs/route");
  type POSTReq = Parameters<typeof POST>[0];
  const event = {
    type: "post_call_transcription",
    event_timestamp: Math.floor(Date.now() / 1000),
    data: postCallData(conversationId),
  };
  const body = JSON.stringify(event);
  const t = String(Math.floor(Date.now() / 1000));
  const res = await POST(bodyReq(body, sign(body, t)) as POSTReq);
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);

  // 60 s, not 20: this gate shares a remote test database with the rest of the
  // bundle, and a neighbour gate's heavy queries must not fail this one on wait
  // time alone.
  const processed = await waitFor(async () => {
    const ev = await db.webhookEvent.findFirst({
      where: { conversationId, eventType: "post_call_transcription" },
    });
    return ev?.processed === true;
  }, 60_000);
  expect(processed).toBe(true);

  // ── what the real path persisted ────────────────────────────────────────────
  const caseRow = await db.case.findUnique({ where: { caseRef: CASE_REF } });
  expect(caseRow?.state).toBe("NOTIFIED");
  expect(caseRow?.outcome).toBe("success");
  expect(caseRow?.durationSeconds).toBe(47);
  // Sealed: the plaintext columns are empty, the ciphertext row is the record.
  expect(caseRow?.transcriptRedacted).toBeNull();

  const payload = await readCasePayload(CASE_REF);
  const storedTranscript = payload.transcript ?? "";
  expect(storedTranscript).not.toContain("4242");
  expect(storedTranscript).not.toContain("88213");
  expect(storedTranscript).not.toContain("7342");
  expect(storedTranscript).toContain("[REDACTED]");
  const analysis = payload.analysis as { evaluation: unknown; data_collection: unknown };
  expect(analysis.evaluation).not.toBeNull();
  expect(analysis.data_collection).not.toBeNull();

  const chain = await verifyChain(CASE_REF, ORG_ID);
  expect(chain.ok).toBe(true);
  const chainEntries = await db.auditLog.count({ where: { callRef: CASE_REF } });
  expect(chainEntries).toBeGreaterThan(0);

  const ingestRow = await db.auditLog.findFirst({
    where: { callRef: CASE_REF, intent: "post_call_ingest" },
  });
  expect(ingestRow).not.toBeNull();
  // AuditLog.meta is a JSON-stringified column (schema.prisma:86), not Json.
  const rawMeta = ingestRow?.meta;
  const ingestMeta = (
    typeof rawMeta === "string" ? JSON.parse(rawMeta) : (rawMeta ?? {})
  ) as Record<string, unknown>;

  const outboxRow = await db.outboxEvent.findFirst({
    where: { caseRef: CASE_REF, eventType: "case.notified" },
  });
  expect(outboxRow).not.toBeNull();
  const outboxPayload = JSON.parse(outboxRow!.payload) as {
    data?: { evidence?: { transcript?: string }; tool_calls_observed?: number };
  };
  expect(outboxPayload.data?.evidence?.transcript).toBe("withheld");

  // The audit entry is the analysis source: if these came back empty the
  // artifact would render a silent zero — so assert them, here, not in prose.
  expect(ingestMeta.toolCalls).toBe(2);
  expect(ingestMeta.memoryRisk).toBe("clean");
  expect((ingestMeta.billing as { billed_minutes?: number }).billed_minutes).toBe(1);

  // ── the artifact ────────────────────────────────────────────────────────────
  const turns = parsePersistedTurns(storedTranscript);
  expect(turns.length).toBe(5);
  const toolNames = Array.isArray(ingestMeta.toolNames) ? (ingestMeta.toolNames as string[]) : [];
  const capturedAt = new Date().toISOString();

  const artifact: TranscriptArtifact = {
    schema_version: "1.0",
    artifact: "conversation-transcript",
    case_ref: CASE_REF,
    conversation_id: conversationId,
    captured_at: capturedAt,
    mode: {
      dial: "dry-run",
      vendor_evidence: false,
      conversation_content: "synthetic fixture in the vendor post-call schema",
      explanation:
        "The dial was placed through the real adapter (placeOutboundCall) with ELEVENLABS_DRY_RUN=true: no speech was synthesised and no vendor call occurred (the account's character quota was exhausted at capture time, 10000/10000). The transcript content is a synthetic fixture delivered through the REAL post-call webhook. Signature verification, PII redaction, memory screening, audit chaining, payload sealing, the state transition and the bank notification are this deployment's real runtime outputs, not vendor recordings.",
    },
    placement: {
      adapter: "conversation.elevenlabs (registry binding)",
      via: "placeOutboundCall (src/lib/elevenlabs/outbound-call.ts)",
      dry_run: placement.dryRun,
      call_sid: placement.callSid,
    },
    ingest: {
      handler: "POST /api/webhooks/elevenlabs",
      event_type: "post_call_transcription",
      signature: "verified (ElevenLabs-Signature t/v0 HMAC)",
      processed: true,
    },
    transcript: {
      redacted: true,
      provenance: "as persisted: the sealed payload's transcript field, split into turns",
      turns,
    },
    post_call_analysis: {
      outcome: caseRow?.outcome ?? null,
      duration_seconds: caseRow?.durationSeconds ?? null,
      billed_minutes: ingestMeta.billing ?? null,
      tool_calls_observed: {
        count: typeof ingestMeta.toolCalls === "number" ? ingestMeta.toolCalls : 0,
        names: toolNames,
        note: "calls the vendor transcript records; execution evidence for the high-stakes tool is evidence/guardrails/tools.json (committed:false refusals)",
      },
      voicemail: ingestMeta.voicemail === true,
      memory_poisoning_screen: ingestMeta.memoryRisk ?? null,
      evaluation: analysis.evaluation,
      data_collection: analysis.data_collection,
    },
    persistence: {
      sealed: true,
      plaintext_columns_cleared: true,
      case_state_after_ingest: caseRow?.state ?? null,
      audit_chain: { verified: chain.ok, entries: chainEntries },
    },
    bank_notification: {
      event: "case.notified",
      outbox_state: outboxRow!.state,
      transcript_field: outboxPayload.data?.evidence?.transcript ?? null,
      note: "signed outbound payload carries a pointer, never transcript content (hazard H28)",
    },
  };

  const md = renderMarkdown(artifact, turns);

  const dir = join(REPO_ROOT, "evidence", "transcripts");
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, "conversation.json");
  const mdPath = join(dir, "conversation.md");
  const jsonText = JSON.stringify(artifact, null, 2);
  writeFileSync(jsonPath, jsonText);
  writeFileSync(mdPath, md);

  // The committed artifact inherits the same discipline as the stores it came
  // from: no credential shape, no phone number, and the mode label is present.
  const serialized = jsonText + md;
  expect(serialized).not.toContain("4242 4242");
  expect(serialized).not.toContain("88213");
  expect(serialized).not.toContain("7342");
  expect(serialized).not.toContain(TO_NUMBER);
  expect(artifact.mode.dial).toBe("dry-run");
  expect(artifact.mode.vendor_evidence).toBe(false);
  expect(serialized).toContain("NOT VENDOR EVIDENCE");

  const digest = createHash("sha256").update(jsonText).digest("hex");
  console.log(
    `transcript gate: evidence/transcripts/conversation.json (${jsonText.length} bytes, sha256 ${digest}) + conversation.md`,
  );

  await db.$disconnect();
}, 120_000);

function renderMarkdown(a: TranscriptArtifact, turns: PersistedTurn[]): string {
  const lines: string[] = [];
  lines.push(`# Post-call transcript and analysis — case ${a.case_ref}`);
  lines.push("");
  lines.push("> **MODE: DRY-RUN — NOT VENDOR EVIDENCE.** " + a.mode.explanation);
  lines.push("");
  lines.push(`- Captured: ${a.captured_at}`);
  lines.push(`- Conversation id: \`${a.conversation_id}\``);
  lines.push(`- Placement: \`${a.placement.via}\` (dry_run=${a.placement.dry_run})`);
  lines.push(
    `- Ingest: \`${a.ingest.handler}\`, event \`${a.ingest.event_type}\`, signature ${a.ingest.signature}`,
  );
  lines.push("");
  lines.push("## Transcript (as persisted — redacted, invariant I-10)");
  lines.push("");
  lines.push(
    "_Per-turn timestamps are not reproduced: the raw vendor payload is never stored, so the artifact renders exactly what the pipeline persisted._",
  );
  lines.push("");
  for (const turn of turns) {
    const who =
      turn.speaker === "agent" ? "Agent" : turn.speaker === "customer" ? "Customer" : "System";
    lines.push(`**${who}:** ${turn.text}`);
    lines.push("");
  }
  lines.push("## Post-call analysis");
  lines.push("");
  const pa = a.post_call_analysis;
  lines.push(`- Outcome: **${String(pa.outcome)}**`);
  lines.push(`- Duration: ${String(pa.duration_seconds)} s`);
  const billing = pa.billed_minutes as { billed_minutes?: number } | null;
  if (billing && typeof billing.billed_minutes === "number") {
    lines.push(`- Billed minutes: ${billing.billed_minutes}`);
  }
  const tools = pa.tool_calls_observed as {
    count: number;
    names: string[];
    note: string;
  };
  lines.push(
    `- Tool calls observed: ${tools.count}${tools.names.length ? ` (${tools.names.join(", ")})` : ""} — ${tools.note}`,
  );
  lines.push(`- Voicemail: ${pa.voicemail ? "yes" : "no"}`);
  lines.push(`- Memory-poisoning screen: ${JSON.stringify(pa.memory_poisoning_screen)}`);
  lines.push(`- Evaluation (as persisted): \`${JSON.stringify(pa.evaluation)}\``);
  lines.push(`- Data collection (as persisted): \`${JSON.stringify(pa.data_collection)}\``);
  lines.push("");
  lines.push("## Persistence and delivery");
  lines.push("");
  lines.push(`- Case state after ingest: **${a.persistence.case_state_after_ingest}**`);
  lines.push(
    "- Evidence payload: sealed (AES-256-GCM under a per-case data key); plaintext transcript columns cleared",
  );
  lines.push(
    `- Audit chain: ${a.persistence.audit_chain.verified ? "verified" : "**FAILED**"} over ${a.persistence.audit_chain.entries} entries`,
  );
  lines.push(
    `- Bank notification: \`${a.bank_notification.event}\` enqueued, \`transcript: "${a.bank_notification.transcript_field}"\` — a pointer, not the evidence`,
  );
  lines.push("");
  return lines.join("\n");
}
