/**
 * UNIT — recording keys and signed downloads (`src/lib/storage/recordings.ts`).
 *
 * Everything else in this file follows from one property:
 *
 *   **two orgs can never produce the same key for one conversation.**
 *
 * There is no per-object ACL in the bucket. R2 sees one flat namespace and a
 * bearer URL. The `{orgId}` prefix on the key IS the tenant boundary, so if
 * two tenants could ever collide on a key, or a tenant id could be crafted to
 * name another tenant's prefix, the isolation is gone and no downstream check
 * would notice — the store would just hand the bytes over.
 *
 * That makes these assertions load-bearing rather than decorative:
 *
 *  - The key is tenant-prefixed, and the prefix is one path segment.
 *  - A missing or hostile `orgId` is refused, not sanitised. `org_a/../org_b`
 *    normalises to `org_b` at the server; the whole point is to never make that
 *    string reachable.
 *  - A download URL is derived from a server-derived tenant. Possession of the
 *    URL IS the authorization — there is no session check between the browser
 *    and the store — so the URL must be short-lived and must never be logged.
 *  - Unconfigured storage DEGRADES. It returns `storage_not_configured` or
 *    `false`; it never throws. A fraud intervention must not fail because an
 *    object store is absent, and `RecordingPlayer` already renders `src === null`
 *    as a designed "sealed" state rather than an error.
 *
 * The clock and `fetch` are injected, so the expiry assertion is exact rather
 * than approximate and nothing here touches a network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_DOWNLOAD_TTL_SECONDS,
  MAX_DOWNLOAD_TTL_SECONDS,
  RECORDING_CACHE_CONTROL,
  RECORDING_CONTENT_TYPE,
  hasRecording,
  recordRecording,
  recordingDownloadUrl,
  recordingKey,
  recordingPrefix,
  storeRecording,
  tryRecordingKey,
} from "@/lib/storage/recordings";
import { StorageError, type StorageConfig } from "@/lib/storage/s3";

const SECRET = "unit-test-recording-secret-0123456789";
const CONFIG: StorageConfig = {
  endpoint: "https://acct123.r2.cloudflarestorage.com",
  region: "auto",
  accessKeyId: "AKIARECORDINGTEST001",
  secretAccessKey: SECRET,
  bucket: "securevoice-recordings",
  forcePathStyle: true,
};

const FIXED_NOW = new Date("2026-10-11T09:30:15.000Z");

const ENV_KEYS = [
  "S3_ENDPOINT",
  "R2_ENDPOINT",
  "S3_REGION",
  "R2_REGION",
  "S3_ACCESS_KEY_ID",
  "R2_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "R2_SECRET_ACCESS_KEY",
  "S3_BUCKET",
  "R2_BUCKET",
] as const;

/**
 * Point the module at a stub store for the duration of a test.
 *
 * Deliberately done through the ENVIRONMENT rather than by handing a config
 * object to `recordingDownloadUrl`: the tenant and the endpoint both come from
 * outside the caller, so a route must not be able to point this module at a
 * bucket of its own choosing. A test that could do that is a test that would
 * let a route do it too.
 */
function configureStore() {
  process.env.S3_ENDPOINT = CONFIG.endpoint;
  process.env.S3_REGION = CONFIG.region;
  process.env.S3_ACCESS_KEY_ID = CONFIG.accessKeyId;
  process.env.S3_SECRET_ACCESS_KEY = CONFIG.secretAccessKey;
  process.env.S3_BUCKET = CONFIG.bucket;
}

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("recordingKey — the tenant prefix is the whole isolation mechanism", () => {
  test("the key is {orgId}/recordings/{conversationId}.mp3", () => {
    expect(recordingKey("org_123", "conv-abc")).toBe("org_123/recordings/conv-abc.mp3");
  });

  test("it is deterministic, so a re-delivered webhook overwrites rather than duplicates", () => {
    expect(recordingKey("org_123", "conv-abc")).toBe(recordingKey("org_123", "conv-abc"));
  });

  test("the org id is the FIRST path segment, always", () => {
    // Not "somewhere in the key". If the prefix ever moved, a prefix-stripping
    // bug elsewhere would silently start addressing the wrong tenant.
    for (const org of ["org_1", "org-2", "acme-bank"]) {
      expect(recordingKey(org, "conv-1").split("/")[0]).toBe(org);
    }
  });

  test("TWO orgs can never produce the same key for one conversation", () => {
    // The property the module header says everything else rests on. If this ever
    // fails, one bank can play another bank's recording, which is a reportable
    // PDPL incident rather than a bug ticket.
    const a = recordingKey("org_a", "conv-shared");
    const b = recordingKey("org_b", "conv-shared");
    expect(a).not.toBe(b);
    expect(a).toBe("org_a/recordings/conv-shared.mp3");
    expect(b).toBe("org_b/recordings/conv-shared.mp3");
  });

  test("an org id cannot be crafted to name another tenant's prefix", () => {
    // These all normalise at the server to something under a different tenant.
    // Refusing them is what stops the normalisation from ever being reachable.
    for (const hostile of [
      "org_a/../org_b",
      "../org_b",
      "/org_b",
      "org_a/../../org_b",
      "org_a/",
      "org_a//org_b",
      "./org_b",
      "..",
    ]) {
      expect(() => recordingKey(hostile, "conv-1")).toThrow(StorageError);
    }
  });

  test("a missing or empty org id is refused", () => {
    // "No tenant" has no degraded form: a caller that cannot name a tenant has
    // nothing to fall back to, and must not be allowed to address a key anyway.
    for (const missing of ["", "   ", undefined as unknown as string, null as unknown as string]) {
      expect(() => recordingKey(missing, "conv-1")).toThrow(StorageError);
    }
    expect(tryRecordingKey("", "conv-1")).toBeNull();
    expect(tryRecordingKey("org_a", "conv-1")).toBe("org_a/recordings/conv-1.mp3");
  });

  test("a missing conversation id is refused too", () => {
    for (const missing of ["", "  ", "../escape", "a/b"]) {
      expect(() => recordingKey("org_a", missing)).toThrow(StorageError);
    }
  });

  test("the refusal names the rule and never echoes the value", () => {
    // An org id is a customer identifier; an error message is a log line.
    try {
      recordingKey("../org_b", "conv-1");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("invalid_key");
      expect((err as Error).message).not.toContain("org_b");
    }
  });

  test("recordingPrefix gives a sweep one tenant's whole namespace", () => {
    expect(recordingPrefix("org_a")).toBe("org_a/recordings");
    expect(recordingKey("org_a", "conv-1").startsWith(`${recordingPrefix("org_a")}/`)).toBe(true);
    expect(recordingPrefix("org_a")).not.toBe(recordingPrefix("org_b"));
    expect(() => recordingPrefix("org_a/../org_b")).toThrow(StorageError);
  });
});

describe("recordingDownloadUrl — possession of the URL IS the authorization", () => {
  test("degrades with a typed reason when storage is not configured", async () => {
    // The "storage is optional" contract, at the level a caller actually hits.
    // It must not throw: `RecordingPlayer` renders `src === null` as a designed
    // "sealed" state, and that screen is the correct answer here.
    const res = await recordingDownloadUrl({ orgId: "org_a", conversationId: "conv-1" });
    expect(res).toEqual({ ok: false, error: "storage_not_configured" });
  });

  test("degrades with org_id_required_or_invalid for a missing tenant", async () => {
    configureStore();
    const res = await recordingDownloadUrl({ orgId: "", conversationId: "conv-1" });
    expect(res).toEqual({ ok: false, error: "org_id_required_or_invalid" });
  });

  test("expires in the configured window, measured from the signing clock", async () => {
    configureStore();
    const res = await recordingDownloadUrl({
      orgId: "org_a",
      conversationId: "conv-1",
      expiresInSeconds: 120,
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const q = new URL(res.url).searchParams;
    expect(q.get("X-Amz-Expires")).toBe("120");
    // X-Amz-Date is ISO-BASIC (`20261011T093015Z`) — not ISO 8601, so `Date`
    // cannot parse it directly. Reassembling it is what turns "a number in the
    // URL" into a real expiry worth asserting on.
    const iso = q.get("X-Amz-Date")!;
    expect(iso).toBe("20261011T093015Z");
    const signedAt = new Date(
      `${iso.slice(0, 4)}-${iso.slice(4, 6)}-${iso.slice(6, 8)}T` +
        `${iso.slice(9, 11)}:${iso.slice(11, 13)}:${iso.slice(13, 15)}Z`,
    );
    expect(signedAt.getTime()).toBe(FIXED_NOW.getTime());
    expect(res.expiresAt.getTime()).toBe(FIXED_NOW.getTime() + 120_000);
    expect(res.expiresInSeconds).toBe(120);
  });

  test("defaults to a short life — five minutes, not forever", async () => {
    configureStore();
    const res = await recordingDownloadUrl({
      orgId: "org_a",
      conversationId: "conv-1",
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.expiresInSeconds).toBe(DEFAULT_DOWNLOAD_TTL_SECONDS);
    expect(DEFAULT_DOWNLOAD_TTL_SECONDS).toBe(300);
    expect(new URL(res.url).searchParams.get("X-Amz-Expires")).toBe("300");
  });

  test("clamps an over-long life rather than honouring or crashing", async () => {
    configureStore();
    // A link that is slightly too short is a nuisance; a crash while building a
    // page is an outage. And a quarter-of-an-hour ceiling means a leaked URL is
    // never a durable credential.
    const res = await recordingDownloadUrl({
      orgId: "org_a",
      conversationId: "conv-1",
      expiresInSeconds: 60 * 60 * 24 * 7,
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.expiresInSeconds).toBe(MAX_DOWNLOAD_TTL_SECONDS);
    expect(MAX_DOWNLOAD_TTL_SECONDS).toBe(900);
    expect(new URL(res.url).searchParams.get("X-Amz-Expires")).toBe("900");
  });

  test("the URL is scoped to the requesting tenant and carries the right key", async () => {
    configureStore();
    const res = await recordingDownloadUrl({ orgId: "org_a", conversationId: "conv-1", now: () => FIXED_NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.key).toBe("org_a/recordings/conv-1.mp3");
    expect(res.url).toContain(`${CONFIG.endpoint}/${CONFIG.bucket}/org_a/recordings/conv-1.mp3?`);
    // Another tenant's prefix must not appear anywhere in the link.
    expect(res.url).not.toContain("org_b");
  });

  test("the response overrides are signed into the URL, not appended to it", async () => {
    configureStore();
    const res = await recordingDownloadUrl({ orgId: "org_a", conversationId: "conv-1", now: () => FIXED_NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const q = new URL(res.url).searchParams;
    // `inline` because the consumer is <audio src>; `attachment` would download.
    expect(q.get("response-content-disposition")).toBe('inline; filename="conv-1.mp3"');
    expect(q.get("response-content-type")).toBe(RECORDING_CONTENT_TYPE);
    expect(q.get("X-Amz-SignedHeaders")).toBe("host");
    expect(q.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the bucket secret never appears in a download link", async () => {
    configureStore();
    const res = await recordingDownloadUrl({ orgId: "org_a", conversationId: "conv-1", now: () => FIXED_NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.url).not.toContain(SECRET);
    expect(decodeURIComponent(res.url)).not.toContain(SECRET);
  });

  test("recordings are declared no-store, because a PDPL erasure cannot reach a cache", async () => {
    // A recording left in a shared CDN cache or a browser disk cache outlives
    // both the URL's expiry and the 30-day retention window, and nothing a
    // customer asks for afterwards can reach it.
    expect(RECORDING_CACHE_CONTROL).toBe("no-store");
  });
});

describe("storing a recording", () => {
  test("degrades rather than throwing when storage is off", async () => {
    const res = await storeRecording({
      orgId: "org_a",
      conversationId: "conv-1",
      audio: Buffer.from("fake-mp3"),
    });
    expect(res).toEqual({ ok: false, error: "storage_not_configured" });
  });

  test("reports a bad tenant separately from a missing store", async () => {
    // "the case row had no orgId" and "the conversation id was a traversal
    // attempt" are different bugs in different places; collapsing them into one
    // string is how the second hides behind the first.
    configureStore();
    expect(
      await storeRecording({ orgId: "", conversationId: "conv-1", audio: Buffer.from("x") }),
    ).toEqual({ ok: false, error: "org_id_required_or_invalid" });
    expect(
      await storeRecording({ orgId: "org_a", conversationId: "", audio: Buffer.from("x") }),
    ).toEqual({ ok: false, error: "conversation_id_required_or_invalid" });
  });

  test("writes under the tenant prefix with no-store and an audio content type", async () => {
    configureStore();
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (url: unknown, init: unknown) => {
      capturedUrl = String(url);
      capturedHeaders = (init as RequestInit).headers as Record<string, string>;
      return new Response("", { status: 200, headers: { etag: '"e1"' } });
    }) as unknown as typeof fetch;

    const res = await storeRecording({
      orgId: "org_a",
      conversationId: "conv-1",
      audio: Buffer.from("fake-mp3"),
      fetchImpl,
      now: () => FIXED_NOW,
    });
    expect(res).toEqual({ ok: true, key: "org_a/recordings/conv-1.mp3", etag: '"e1"' });
    expect(capturedUrl).toContain("/org_a/recordings/conv-1.mp3");
    expect(capturedHeaders["content-type"]).toBe("audio/mpeg");
    expect(capturedHeaders["cache-control"]).toBe("no-store");
    expect(capturedHeaders.authorization).toContain("AWS4-HMAC-SHA256");
  });

  test("a failed upload is a result object, never a thrown error", async () => {
    // A failed upload must not become a failed case transition. The caller
    // records the outcome in the audit chain either way.
    configureStore();
    const fetchImpl = (async () => new Response("<Error>nope</Error>", { status: 500 })) as typeof fetch;
    const res = await storeRecording({
      orgId: "org_a",
      conversationId: "conv-1",
      audio: Buffer.from("x"),
      fetchImpl,
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("500");
    expect(res.error).not.toContain(SECRET);
  });

  test("recordRecording is the same function as storeRecording", async () => {
    // Two vocabularies — "the product now HAS a recording" and "bytes are in a
    // bucket" — must not drift into two behaviours.
    expect(recordRecording).toBe(storeRecording);
  });
});

describe("hasRecording", () => {
  test("a well-formed key with no store configured reads as 'no recording'", async () => {
    // The console renders all three — no recording, no store, store unreachable —
    // as the same `sealed` chip, so collapsing them here is exactly what the UI
    // already assumes.
    expect(await hasRecording("org_a/recordings/conv-1.mp3")).toBe(false);
  });

  test("a hostile key is false, and never reaches the network", async () => {
    expect(await hasRecording("org_a/../org_b/recordings/conv-1.mp3")).toBe(false);
    expect(await hasRecording("/org_b/recordings/conv-1.mp3")).toBe(false);
  });

  test("with a store configured it probes the exact tenant key", async () => {
    configureStore();
    let probed = "";
    // `hasRecording(key)` takes only a key, so the seam here is the global fetch
    // rather than an injected stub. Stubbing it is also what keeps this test off
    // the network: without it the probe really does try to reach the bucket.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      probed = String(url);
      expect((init as RequestInit).method).toBe("HEAD");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      expect(await hasRecording(recordingKey("org_a", "conv-1"))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(probed).toContain("/org_a/recordings/conv-1.mp3");
    // A HEAD, not a ranged GET: the check costs one header round trip and moves
    // zero audio bytes. And a header-signed request carries no signature in the
    // URL, because there is no bearer URL to leak.
    expect(probed).not.toContain("X-Amz-Signature");
  });
});