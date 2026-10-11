/**
 * THE RECORDING IS ARCHIVED ON THE WAY IN — the half of the object-storage feature
 * the download endpoint silently depended on.
 *
 * `src/lib/storage/recordings.ts` shipped `storeRecording()` with no caller, and
 * `GET /api/recordings/[id]/download` minted presigned URLs for objects nothing had
 * ever written. The archive is what the ingest path's comment called "the provider
 * as system of record" — a defensible position until you notice a recording is a
 * bank customer's voice with an erasure obligation and a tenant-set retention
 * period, neither of which can be executed on a vendor's bucket.
 *
 * So the seam asserted here is the whole round trip, driven by the real signed
 * webhook:
 *
 *   1. A `post_call_audio` event PUTs the decoded bytes under
 *      `<orgId>/recordings/<conversationId>.mp3` — the tenant prefix comes from
 *      the CASE's org, which the bleedguard resolves from the agent the event
 *      names, never from the payload's own `organization_id`.
 *   2. The object carries `Cache-Control: no-store`. R2 serves stored headers on a
 *      direct GET, a path that never passes through our code.
 *   3. The audit row says which of the three outcomes happened — archived,
 *      refused, or no audio at all. A silent absence is indistinguishable from a
 *      call that produced no recording.
 *   4. An upload failure does NOT fail the ingest: the case still advances and the
 *      webhook still answers 200, because the alternative is ElevenLabs retrying a
 *      delivery we already processed.
 *   5. With storage unconfigured nothing is PUT and nothing throws — the same
 *      degrade-everything-else-in-this-repo-uses.
 *
 * `fetch` is replaced with a recording tripwire, so no byte can leave the process.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { db } from "@/lib/db";

const WEBHOOK_SECRET = "0a1357ae77926d".repeat(4);
process.env.ELEVENLABS_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ELEVENLABS_DRY_RUN = "true";
process.env.PRIVACY_MASTER_KEY = process.env.PRIVACY_MASTER_KEY ?? "a".repeat(64);

const RUN_ID = Date.now().toString(36);
const AGENT_ID = "agent_archive_test";
const ORG_ID = "dddddddd-0000-4000-8000-dddddddddddd";
/** 3 bytes encoded, so the decoded length is exactly knowable. */
const AUDIO_B64 = Buffer.from([0x46, 0x46, 0x46]).toString("base64");

type Put = { url: string; method: string; headers: Record<string, string>; bytes: number };
let puts: Put[] = [];
let failNextPut = false;

const realFetch = globalThis.fetch;

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.headers;
    const headers =
      raw instanceof Headers
        ? Object.fromEntries(raw.entries())
        : Array.isArray(raw)
          ? Object.fromEntries(raw as [string, string][])
          : { ...((raw ?? {}) as Record<string, string>) };
    const method = init?.method ?? "GET";
    const body = init?.body;
    const bytes = Buffer.isBuffer(body)
      ? body.length
      : body instanceof Uint8Array
        ? body.length
        : typeof body === "string"
          ? body.length
          : 0;
    puts.push({ url: String(input), method, headers, bytes });
    if (method === "PUT" && failNextPut) {
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    }
    return new Response("", { status: 200, headers: { etag: '"abc123"' } });
  }) as typeof fetch;
}

function sign(body: string): string {
  const t = String(Math.floor(Date.now() / 1000));
  return `t=${t},v0=${createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex")}`;
}

async function ingest(payload: unknown) {
  const { POST } = await import("@/app/api/webhooks/elevenlabs/route");
  type POSTReq = Parameters<typeof POST>[0];
  const body = JSON.stringify(payload);
  const req = new Request("http://localhost/api/webhooks/elevenlabs", {
    method: "POST",
    headers: { "content-type": "application/json", "elevenlabs-signature": sign(body) },
    body,
  }) as POSTReq;
  return POST(req);
}

function audioPayload(conversationId: string) {
  return {
    type: "post_call_audio",
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      agent_id: AGENT_ID,
      conversation_id: conversationId,
      full_audio: AUDIO_B64,
      media_type: "audio/mpeg",
    },
  };
}

async function seedCase(conversationId: string, caseRef: string) {
  await db.organization.upsert({
    where: { id: ORG_ID },
    create: {
      id: ORG_ID,
      name: "Archive Test Tenant",
      slug: `archive-${RUN_ID}`,
      createdAt: new Date(),
      elevenAgentId: AGENT_ID,
    },
    update: { elevenAgentId: AGENT_ID },
  });
  return db.case.create({
    data: { caseRef, orgId: ORG_ID, state: "CONFIRMED_FRAUD", conversationId },
  });
}

/** `AuditLog.meta` is a JSON string column, not a Postgres `jsonb`. */
function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The ingest handler appends with `{ fast: true }`; give the queue a beat. */
async function waitForAudit(caseRef: string) {
  for (let i = 0; i < 40; i++) {
    const row = await db.auditLog.findFirst({
      where: { callRef: caseRef, intent: "post_call_audio" },
    });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

beforeEach(() => {
  puts = [];
  failNextPut = false;
  installFetch();
  process.env.R2_ENDPOINT = "https://acct.test.r2.cloudflarestorage.com";
  process.env.R2_BUCKET = "securevoice-recordings-test";
  process.env.R2_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
  process.env.R2_SECRET_ACCESS_KEY = "wJalrXUtnFEMI-KODE-MdspF+HEXAMPLEACUV";
  process.env.R2_REGION = "auto";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of [
    "R2_ENDPOINT",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_REGION",
  ]) {
    delete process.env[k];
  }
});

test("a post-call recording is PUT under the case's own tenant prefix", async () => {
  const conv = `conv-archive-${RUN_ID}`;
  const c = await seedCase(conv, `SV-AR-${RUN_ID.toUpperCase()}`);
  try {
    const res = await ingest(audioPayload(conv));
    expect(res.status).toBe(200);

    // The handler runs after the response is sent (the route answers 200 as soon
    // as the event is durably queued), so the effect is awaited, not assumed.
    const audit = await waitForAudit(c.caseRef);
    expect(audit, "the post_call_audio audit row never landed").not.toBeNull();

    const put = puts.find((p) => p.method === "PUT");
    expect(put, "no upload was attempted").toBeDefined();
    if (!put) return;
    expect(decodeURIComponent(new URL(put.url).pathname)).toBe(
      `/securevoice-recordings-test/${ORG_ID}/recordings/${conv}.mp3`,
    );
    // The bytes that arrived are the bytes that were stored — 3 bytes decoded.
    expect(put.bytes).toBe(3);
    expect(put.headers["content-type"]).toBe("audio/mpeg");
    // A direct GET from the bucket never passes through our code, so the
    // no-store has to travel with the object.
    expect(put.headers["cache-control"]).toBe("no-store");
    // Signed, not anonymous: an unauthenticated PUT would be an open write.
    expect(put.headers.authorization).toContain("AWS4-HMAC-SHA256");

    const meta = audit ? parseMeta(audit.meta) : {};
    expect(meta.archived).toBe(true);
    expect(meta.recordingKey).toBe(`${ORG_ID}/recordings/${conv}.mp3`);
    expect(meta.approxAudioBytes).toBe(3);
  } finally {
    await db.case.deleteMany({ where: { id: c.id } });
    await db.organization.deleteMany({ where: { id: ORG_ID } });
  }
}, 60_000);

test("a failed upload is recorded and does not fail the ingest", async () => {
  const conv = `conv-archive-fail-${RUN_ID}`;
  const c = await seedCase(conv, `SV-ARF-${RUN_ID.toUpperCase()}`);
  try {
    failNextPut = true;
    const res = await ingest(audioPayload(conv));
    // 200, not 5xx: a retry of a delivery we already processed is worse than
    // the archive gap we just logged.
    expect(res.status).toBe(200);

    const audit = await waitForAudit(c.caseRef);
    expect(audit, "the post_call_audio audit row never landed").not.toBeNull();
    const meta = audit ? parseMeta(audit.meta) : {};
    expect(meta.archived).toBe(false);
    expect(typeof meta.archiveError).toBe("string");
    expect(meta.archiveError).not.toBe("");
  } finally {
    await db.case.deleteMany({ where: { id: c.id } });
    await db.organization.deleteMany({ where: { id: ORG_ID } });
  }
}, 60_000);

test("with no object store configured, nothing is PUT and the ingest still succeeds", async () => {
  const conv = `conv-archive-nostore-${RUN_ID}`;
  const c = await seedCase(conv, `SV-ARN-${RUN_ID.toUpperCase()}`);
  for (const k of [
    "R2_ENDPOINT",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_REGION",
  ]) {
    delete process.env[k];
  }
  try {
    const res = await ingest(audioPayload(conv));
    expect(res.status).toBe(200);

    const audit = await waitForAudit(c.caseRef);
    expect(audit, "the post_call_audio audit row never landed").not.toBeNull();
    expect(puts.find((p) => p.method === "PUT")).toBeUndefined();

    const meta = audit ? parseMeta(audit.meta) : {};
    expect(meta.archived).toBe(false);
    expect(meta.archiveError).toBe("storage_not_configured");
  } finally {
    await db.case.deleteMany({ where: { id: c.id } });
    await db.organization.deleteMany({ where: { id: ORG_ID } });
  }
}, 60_000);

test("an event with no audio archives nothing and blames nothing", async () => {
  const conv = `conv-archive-silent-${RUN_ID}`;
  const c = await seedCase(conv, `SV-ARS-${RUN_ID.toUpperCase()}`);
  try {
    const res = await ingest({
      type: "post_call_audio",
      event_timestamp: Math.floor(Date.now() / 1000),
      data: { agent_id: AGENT_ID, conversation_id: conv },
    });
    expect(res.status).toBe(200);

    const audit = await waitForAudit(c.caseRef);
    expect(audit, "the post_call_audio audit row never landed").not.toBeNull();
    expect(puts.find((p) => p.method === "PUT")).toBeUndefined();

    const meta = audit ? parseMeta(audit.meta) : {};
    // `archiveError` absent, not "audio_not_decodable": there was no audio to
    // fail on, and inventing a fault here would page someone over an empty call.
    expect(meta.archived).toBe(false);
    expect(meta.archiveError).toBeUndefined();
  } finally {
    await db.case.deleteMany({ where: { id: c.id } });
    await db.organization.deleteMany({ where: { id: ORG_ID } });
  }
}, 60_000);

// ── Erasure ───────────────────────────────────────────────────────────────────
//
// Archiving is only half of owning a recording. `eraseCase` already reached the
// two copies it knew about — the sealed columns (key destruction) and the Pinecone
// vectors — and the object in the bucket was a THIRD copy that neither reaches:
// shredding the data key does nothing to an MP3, and a retention sweep that leaves
// the customer's voice behind has not erased the case. These tests drive the real
// `eraseCase` against the real database with `fetch` replaced, so the DELETE that
// a PDPL response depends on is actually observed.

test("erasing a case deletes its archived recording", async () => {
  const conv = `conv-erase-${RUN_ID}`;
  const c = await seedCase(conv, `SV-ERE-${RUN_ID.toUpperCase()}`);
  try {
    const { eraseCase } = await import("@/lib/privacy/crypto-shred");
    await eraseCase(c.caseRef, { reason: "subject_request", legalBasis: "consent" });

    const del = puts.find((p) => p.method === "DELETE");
    expect(del, "erasure issued no object delete").toBeDefined();
    if (!del) return;
    expect(decodeURIComponent(new URL(del.url).pathname)).toBe(
      `/securevoice-recordings-test/${ORG_ID}/recordings/${conv}.mp3`,
    );
    expect(del.headers.authorization).toContain("AWS4-HMAC-SHA256");
  } finally {
    await db.case.deleteMany({ where: { id: c.id } });
    await db.organization.deleteMany({ where: { id: ORG_ID } });
  }
}, 60_000);

test("a recording the store refused to delete is audited, and the erasure still stands", async () => {
  const conv = `conv-erase-fail-${RUN_ID}`;
  const c = await seedCase(conv, `SV-ERF-${RUN_ID.toUpperCase()}`);
  try {
    // Refuse only the DELETE; the earlier PUT-style traffic is not involved here.
    const base = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      (init?.method ?? "GET") === "DELETE"
        ? new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })
        : base(input, init)) as typeof fetch;

    const { eraseCase } = await import("@/lib/privacy/crypto-shred");
    const result = await eraseCase(c.caseRef, { reason: "retention" });

    // The erasure is not rolled back by a storage fault — the key is destroyed and
    // the row is cleared, which is most of the obligation met.
    expect(result.alreadyErased).toBe(false);

    // The failure witness is appended with `{ fast: true }`, so it is awaited.
    let failed: { meta: string | null } | null = null;
    for (let i = 0; i < 40 && failed === null; i++) {
      failed = await db.auditLog.findFirst({
        where: { callRef: c.caseRef, intent: "recording_erase_failed" },
      });
      if (!failed) await new Promise((r) => setTimeout(r, 100));
    }
    expect(failed, "a refused recording delete was not recorded anywhere").not.toBeNull();
    const meta = parseMeta(failed?.meta ?? null);
    expect(String(meta.key)).toBe(`${ORG_ID}/recordings/${conv}.mp3`);
  } finally {
    await db.case.deleteMany({ where: { id: c.id } });
    await db.organization.deleteMany({ where: { id: ORG_ID } });
  }
}, 60_000);

test("with no object store configured, erasure issues no delete and claims none", async () => {
  const conv = `conv-erase-nostore-${RUN_ID}`;
  const c = await seedCase(conv, `SV-ERN-${RUN_ID.toUpperCase()}`);
  for (const k of [
    "R2_ENDPOINT",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_REGION",
  ]) {
    delete process.env[k];
  }
  try {
    const { eraseCase } = await import("@/lib/privacy/crypto-shred");
    const result = await eraseCase(c.caseRef, { reason: "retention" });
    expect(result.alreadyErased).toBe(false);
    expect(puts.find((p) => p.method === "DELETE")).toBeUndefined();
    const failed = await db.auditLog.findFirst({
      where: { callRef: c.caseRef, intent: "recording_erase_failed" },
    });
    expect(failed, "an unconfigured store must not be reported as a failed delete").toBeNull();
  } finally {
    await db.case.deleteMany({ where: { id: c.id } });
    await db.organization.deleteMany({ where: { id: ORG_ID } });
  }
}, 60_000);
