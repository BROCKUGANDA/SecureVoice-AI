/**
 * The 30-day audio tier deletes the recording, or it says it did.
 *
 * `registerAudioStore()` existed with one caller in the whole repository:
 * `tests/privacy/privacy.test.ts`, which registers a fake. No production path
 * registered anything, so `src/worker/retention.ts` swept on schedule, reported
 * `audioStore: "none-configured"`, and left every archived MP3 in the bucket past
 * the deadline the policy names. The report was accurate about the seam and
 * nobody read the seam — they read the tier's `due` count.
 *
 * This file runs the real chain: `storeRecording()` into a stubbed S3-compatible
 * store, the REAL adapter (`retentionAudioStore`), and a real `runRetention()`
 * over a real row. Four claims are pinned, and the fourth is the one that would
 * otherwise rot back into the bug:
 *
 *   1. a due case's object is deleted, and `audioArtifactsPurged` counts it;
 *   2. a second sweep purges 0, because the count means "objects that were there",
 *      not "deletes attempted" — the store's DELETE is idempotent, so a count
 *      built from delete results would credit purges that never happened;
 *   3. a refusal from the store is an ERROR with the case reference, and the
 *      object survives — "could not delete" must never reach the same number as
 *      "there was nothing to delete";
 *   4. with no store registered, the object is still there afterwards. The tier
 *      honestly reports `none-configured`, and this is the proof that the wiring,
 *      not the tier, is what removes the recording.
 *
 * No network: the fetch stub IS the bucket.
 *
 *   bun test tests/privacy/retention-audio-store.test.ts
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  configureRetention,
  registerAudioStore,
  resetRetentionConfig,
  runRetention,
} from "@/lib/privacy/retention";
import { retentionAudioStore } from "@/lib/storage/retention-audio-store";
import { recordingKey, storeRecording } from "@/lib/storage/recordings";

const RUN = `mv${Date.now().toString(36)}`;
const BUCKET = "securevoice-recordings-test";
const DAY_MS = 86_400_000;

/**
 * One org per test, not one org for the file.
 *
 * The audio tier does not mutate the case row, so a 40-day-old case stays DUE for
 * every later sweep in the same run. Sharing one org across the five tests made
 * `due` a running total (it read 2, then 5) and turned an exact assertion into a
 * comparison against however many fixtures happened to have run first. Scoping the
 * sweep by org is what lets each test say `due === 1` and mean it.
 */
const orgFor = (tag: string) => `org-retention-audio-${RUN}-${tag}`;

// ── The bucket, as a Map ──────────────────────────────────────────────────────

let objects = new Map<string, Buffer>();
let calls: string[] = [];
let failDeletes = false;
let failNextDelete = false;

const realFetch = globalThis.fetch;

function keyFromUrl(raw: string): string {
  // Path-style addressing, as `src/lib/storage/s3.ts` signs it:
  //   https://<endpoint>/<bucket>/<object key>
  const path = decodeURIComponent(new URL(raw).pathname);
  const prefix = `/${BUCKET}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path.replace(/^\//, "");
}

function installBucket() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const key = keyFromUrl(url);
    calls.push(`${method} ${key}`);

    if (method === "PUT") {
      const body = init?.body;
      const bytes =
        Buffer.isBuffer(body) || body instanceof Uint8Array
          ? Buffer.from(body)
          : Buffer.from(String(body ?? ""));
      objects.set(key, bytes);
      return new Response("", { status: 200, headers: { etag: '"stub-etag"' } });
    }
    if (method === "HEAD") {
      const found = objects.get(key);
      // A real HEAD answers 200 with a content-length. The storage layer keeps
      // only the boolean, which is why `AudioArtifact.bytes` is nullable — this
      // stub is where that decision is visible.
      return found
        ? new Response(null, { status: 200, headers: { "content-length": String(found.length) } })
        : new Response(null, { status: 404 });
    }
    if (method === "DELETE") {
      if (failDeletes || failNextDelete) {
        if (failNextDelete) failNextDelete = false;
        return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      }
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    // GET is not on any path this gate takes (download is
    // `tests/unit/recording-download.test.ts`). Answering the shape rather than
    // the bytes keeps the stub from becoming a second object-store implementation.
    const found = objects.get(key);
    return found
      ? new Response(null, { status: 200 })
      : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
  }) as typeof fetch;
}

const R2_ENV = [
  "R2_ENDPOINT",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_REGION",
] as const;

function configureStore() {
  process.env.R2_ENDPOINT = "https://acct.test.r2.cloudflarestorage.com";
  process.env.R2_BUCKET = BUCKET;
  process.env.R2_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
  process.env.R2_SECRET_ACCESS_KEY = "wJalrXUtnFEMI-KODE-MdspF+HEXAMPLEACUV";
  process.env.R2_REGION = "auto";
}

function clearStoreEnv() {
  for (const k of R2_ENV) delete process.env[k];
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const caseRefs: string[] = [];

/** A closed case old enough to be due for the audio tier, with its conversation. */
async function seedAgedCase(
  tag: string,
  ageDays: number,
  orgId: string,
): Promise<{ caseRef: string; conversationId: string }> {
  const caseRef = `SV-RA-${RUN}-${tag}`.toUpperCase();
  const conversationId = `conv-retention-${RUN}-${tag}`;
  const createdAt = new Date(Date.now() - ageDays * DAY_MS);
  await db.case.create({
    data: {
      caseRef,
      orgId,
      state: "CLOSED",
      createdAt,
      updatedAt: createdAt,
      postCallAt: createdAt,
      conversationId,
    },
    select: { id: true },
  });
  caseRefs.push(caseRef);
  return { caseRef, conversationId };
}

async function archive(orgId: string, conversationId: string): Promise<string> {
  const result = await storeRecording({
    orgId,
    conversationId,
    audio: Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]),
  });
  if (!result.ok) throw new Error(`fixture upload refused: ${result.error}`);
  return result.key;
}

/**
 * Run the sweep for THIS org only.
 *
 * The policy is pinned per org rather than trusted to the defaults: 30/90/2555
 * means a 40-day case is due for audio and for nothing else, so an assertion
 * about `audioArtifactsPurged` cannot be satisfied by a transcript shred or a
 * case delete happening for an unrelated reason.
 */
async function sweepAudioTier(orgId: string) {
  configureRetention(orgId, { audioDays: 30, transcriptDays: 90, caseRecordDays: 2555 });
  return runRetention(new Date(), { orgIds: [orgId] });
}

beforeEach(() => {
  objects = new Map();
  calls = [];
  failDeletes = false;
  failNextDelete = false;
  installBucket();
  configureStore();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  registerAudioStore(null);
  resetRetentionConfig();
  clearStoreEnv();
  if (caseRefs.length > 0) {
    await db.case.deleteMany({ where: { caseRef: { in: caseRefs } } });
  }
  // The tier's own footprint: nothing named for this run may outlive it.
  const left = await db.case.count({ where: { caseRef: { contains: RUN } } });
  expect(left).toBe(0);
});

// ── 1. The wiring deletes ─────────────────────────────────────────────────────

test("a due case's recording is archived, then purged by the sweep", async () => {
  const org = orgFor("due");
  const { caseRef, conversationId } = await seedAgedCase("due", 40, org);
  const key = await archive(org, conversationId);
  expect(key).toBe(recordingKey(org, conversationId));
  expect(objects.has(key)).toBe(true);

  registerAudioStore(retentionAudioStore);
  const report = await sweepAudioTier(org);

  expect(report.audioStore).toBe("configured");
  expect(report.errors.map((e) => e.error)).toEqual([]);
  expect(report.tiers.audio.due).toBe(1);
  expect(report.tiers.audio.acted).toBe(1);
  expect(report.tiers.audio.caseRefs).toContain(caseRef);
  expect(report.audioArtifactsPurged).toBe(1);
  // The object is gone from the store, which is the only evidence that matters.
  expect(objects.has(key)).toBe(false);
});

test("a second sweep purges nothing, and says nothing", async () => {
  const org = orgFor("twice");
  const { conversationId } = await seedAgedCase("twice", 40, org);
  const key = await archive(org, conversationId);

  registerAudioStore(retentionAudioStore);
  await sweepAudioTier(org);
  expect(objects.has(key)).toBe(false);

  // The case row is still there (the audio tier does not mutate it), so the tier
  // still finds it due. A count that rose again here would be counting deletes
  // issued, not objects removed — and the store's DELETE succeeds on an absent
  // key, so nothing else would catch it.
  const second = await sweepAudioTier(org);
  expect(second.tiers.audio.due).toBe(1);
  expect(second.audioArtifactsPurged).toBe(0);
  expect(second.tiers.audio.acted).toBe(0);
});

// ── 2. The refusal path keeps its own number ─────────────────────────────────

test("a store that refuses is reported as an error, and the recording survives", async () => {
  const org = orgFor("refused");
  const { caseRef, conversationId } = await seedAgedCase("refused", 40, org);
  const key = await archive(org, conversationId);

  failDeletes = true;
  registerAudioStore(retentionAudioStore);
  const report = await sweepAudioTier(org);

  expect(report.audioArtifactsPurged).toBe(0);
  expect(report.tiers.audio.acted).toBe(0);
  const failure = report.errors.find((e) => e.caseRef === caseRef);
  expect(
    failure,
    `no error was reported for ${caseRef}: ${JSON.stringify(report.errors)}`,
  ).toBeDefined();
  expect(failure?.stage).toBe("act");
  expect(failure?.error).toContain("audio purge refused");
  // The point of the whole assertion: a refusal is not a purge.
  expect(objects.has(key)).toBe(true);
});

// ── 3. The adapter on its own terms ──────────────────────────────────────────

test("the adapter reports the artifact it can prove, without inventing a size", async () => {
  const org = orgFor("list");
  const { caseRef, conversationId } = await seedAgedCase("list", 40, org);
  const key = await archive(org, conversationId);

  const listed = await retentionAudioStore.listForCase(caseRef);
  expect(listed).toEqual([{ id: key, caseRef, bytes: null }]);

  // A case with no conversation cannot have an object, and saying so is not an
  // error: signals that never became calls are ordinary rows.
  const orphanRef = `SV-RA-${RUN}-ORPHAN`.toUpperCase();
  await db.case.create({
    data: { caseRef: orphanRef, orgId: org, state: "CLOSED", conversationId: null },
    select: { id: true },
  });
  caseRefs.push(orphanRef);
  expect(await retentionAudioStore.listForCase(orphanRef)).toEqual([]);
  expect(await retentionAudioStore.deleteForCase(orphanRef)).toBe(0);

  // And a reference to a case that does not exist deletes nothing rather than
  // reaching a key built from somebody's guess.
  expect(await retentionAudioStore.deleteForCase(`SV-RA-${RUN}-NOPE`.toUpperCase())).toBe(0);
});

// ── 4. The bug this file was written for ─────────────────────────────────────

test("with no store registered, the tier runs and the recording stays", async () => {
  const org = orgFor("unwired");
  const { conversationId } = await seedAgedCase("unwired", 40, org);
  const key = await archive(org, conversationId);

  registerAudioStore(null);
  const report = await sweepAudioTier(org);

  // Honest, and still a leak: the sweep is not lying here. It reports the seam it
  // has, which is none, and the object outlives the deadline anyway. This is why
  // the worker registers the adapter at boot, and why the claim lives in a report
  // field rather than in a tier that can only count what it was given.
  expect(report.audioStore).toBe("none-configured");
  expect(report.audioArtifactsPurged).toBe(0);
  expect(report.tiers.audio.due).toBe(1);
  expect(report.errors).toEqual([]);
  expect(objects.has(key)).toBe(true);
});
