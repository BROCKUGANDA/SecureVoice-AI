/**
 * The Twilio `<Play>` voice ladder.
 *
 * This URL is fetched by the carrier INSIDE a live fraud call. Before the ladder
 * existed, every failure below returned `NextResponse.json(..., 503)` — and
 * `<Play>` does not play JSON, so the customer heard silence on a call whose
 * entire purpose is to be believable. The promise these checks hold is narrow and
 * absolute: once the request is authorised, the response is audio and 200, no
 * matter how many vendors are down.
 *
 * No vendor is ever called: the rungs are stubbed. A test that reached
 * ElevenLabs to prove failover would be measuring the network, not the ladder.
 *
 *   bun test tests/unit/twilio-audio-failover.test.ts
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

const TEXT = "Is this transaction yours?";
const LANG = "en";
const CALL_REF = "SV-A-ladder-test";
const SECRET = "ladder-test-webhook-secret";
process.env.WEBHOOK_SECRET = SECRET;
// The route resolves its per-language voice at import time, so this must be set
// before the dynamic import below or every request short-circuits to "no voice
// configured" and the ladder is never reached.
process.env.ELEVENLABS_VOICE_EN = "ladder-voice";

/** The same derivation src/lib/twilio.ts applies to an audio URL. */

type Rung = "ok" | "fail";
const state = {
  primary: "ok" as Rung,
  poolConfigured: false,
  pool: "ok" as Rung,
  playhtConfigured: false,
  playht: "ok" as Rung,
  poolKey: "key_2",
};

const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02]);

mock.module("@/lib/elevenlabs/client", () => ({
  tts: async () => {
    if (state.primary === "fail") throw new Error("ElevenLabs upstream 429");
    return {
      audio: MP3,
      contentType: "audio/mpeg",
      bytes: MP3.length,
      cached: false,
      voice: "v",
      model: "m",
    };
  },
  UpstreamError: class UpstreamError extends Error {},
  DEV_VOICES: new Set(),
  ELEVEN_VOICE_ENV: {},
  allowedVoices: () => new Set(["ladder-voice"]),
  isProdVoiceMode: () => true,
}));

mock.module("@/lib/elevenlabs/pool", () => ({
  isPoolConfigured: () => state.poolConfigured,
  generateAudioWithFailover: async () => {
    if (state.pool === "fail") throw new Error("pool exhausted");
    return {
      audio: MP3,
      contentType: "audio/mpeg",
      bytes: MP3.length,
      key: state.poolKey,
      attempts: 2,
      model: "m",
    };
  },
  PoolExhaustedError: class PoolExhaustedError extends Error {},
  getPoolStatus: () => [],
}));

mock.module("@/lib/elevenlabs/playht", () => ({
  isPlayhtConfigured: () => state.playhtConfigured,
  playhtVoice: () => (state.playhtConfigured ? "playht-voice-1" : undefined),
  generatePlayhtAudio: async () => {
    if (state.playht === "fail") throw new Error("playht unreachable");
    return { audio: MP3, contentType: "audio/mpeg", bytes: MP3.length, model: "PlayHT2.0" };
  },
  PlayhtError: class PlayhtError extends Error {},
}));

// The chain is written for its own suites; the ladder only needs to know an
// append was asked for, and which source it recorded.
const audits: Record<string, unknown>[] = [];
mock.module("@/lib/audit-chain", () => ({
  append: async (row: Record<string, unknown>) => {
    audits.push(row);
  },
}));

function metaOf(row: Record<string, unknown> | undefined): string {
  return JSON.stringify(row?.meta ?? {});
}

const { GET } = await import("@/app/api/twilio/audio/route");

/**
 * The route caches generated audio by `voice::lang::text` for an hour, in a
 * module-level Map that outlives a test. Every case therefore speaks its own
 * phrase — otherwise the first case warms the cache and the five rungs below it
 * are all "answered from cache", which would pass for the wrong reason.
 */
let phraseSeq = 0;

function signFor(text: string, callRef = CALL_REF): string {
  return createHmac("sha256", `sv-audio:${SECRET}`)
    .update(`${LANG}.${callRef}.${text}`)
    .digest("base64url");
}

function ask(text = `${TEXT} case-${phraseSeq++}`): Promise<Response> {
  const url =
    `http://localhost/api/twilio/audio?text=${encodeURIComponent(text)}` +
    `&lang=${LANG}&callRef=${CALL_REF}&sig=${signFor(text)}`;
  return GET(new NextRequest(new Request(url)));
}

beforeEach(() => {
  state.primary = "ok";
  state.poolConfigured = false;
  state.pool = "ok";
  state.playhtConfigured = false;
  state.playht = "ok";
  audits.length = 0;
});

test("an authorised request is served by the primary voice", async () => {
  const res = await ask();
  expect(res.status).toBe(200);
  expect(res.headers.get("x-voice-source")).toBe("elevenlabs");
  expect(res.headers.get("x-voice-degraded")).toBeNull();
  expect(res.headers.get("content-type")).toBe("audio/mpeg");
});

test("an exhausted key falls over to the pool, and the customer still hears audio", async () => {
  state.primary = "fail";
  state.poolConfigured = true;
  const res = await ask();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("audio/");
  expect(res.headers.get("x-voice-source")).toBe("elevenlabs-pool:key_2");
  expect(res.headers.get("x-voice-degraded")).toBe("true");
  // The failed rung is on the record, so the degradation is attributable.
  expect(audits.some((a) => metaOf(a).includes("elevenlabs"))).toBe(true);
});

test("a dead vendor falls through to the backup vendor", async () => {
  state.primary = "fail";
  state.poolConfigured = true;
  state.pool = "fail";
  state.playhtConfigured = true;
  const res = await ask();
  expect(res.status).toBe(200);
  expect(res.headers.get("x-voice-source")).toBe("playht");
  expect(res.headers.get("x-voice-degraded")).toBe("true");
});

test("when every vendor is down the caller hears a tone, not silence", async () => {
  state.primary = "fail";
  state.poolConfigured = true;
  state.pool = "fail";
  state.playhtConfigured = true;
  state.playht = "fail";
  const res = await ask();
  const body = new Uint8Array(await res.arrayBuffer());
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("audio/wav");
  expect(res.headers.get("x-voice-source")).toBe("emergency-cue");
  // Bytes, not an empty body: a dropped line and a dead one sound the same.
  expect(body.length).toBeGreaterThan(44);
  expect(audits.some((a) => metaOf(a).includes("emergency_cue"))).toBe(true);
});

test("unconfigured rungs are skipped rather than attempted", async () => {
  state.primary = "fail";
  const res = await ask();
  expect(res.status).toBe(200);
  expect(res.headers.get("x-voice-source")).toBe("emergency-cue");
  const meta = metaOf(audits.at(-1));
  expect(meta).toContain("elevenlabs");
  expect(meta).not.toContain("elevenlabs-pool");
  expect(meta).not.toContain("playht");
});

test("a bad signature is still refused with JSON — only authorised traffic gets audio", async () => {
  const res = await GET(
    new NextRequest(
      new Request(
        `http://localhost/api/twilio/audio?text=${encodeURIComponent(TEXT)}&lang=${LANG}&sig=nonsense`,
      ),
    ),
  );
  expect(res.status).toBe(403);
  expect(res.headers.get("content-type")).toContain("json");
});

test("a cached phrase reports the cache, and is not marked degraded", async () => {
  state.primary = "ok";
  const phrase = `${TEXT} cached-${phraseSeq++}`;
  const first = await ask(phrase);
  expect(first.headers.get("x-voice-source")).toBe("elevenlabs");
  const second = await ask(phrase);
  expect(second.status).toBe(200);
  expect(second.headers.get("x-voice-source")).toBe("cache");
  expect(second.headers.get("x-voice-degraded")).toBeNull();
});
