import "server-only";
/**
 * ElevenLabs client wrapper — the ONE place that talks to a neural-voice
 * provider. Vendor-neutral: the prod backend is ElevenLabs; the dev backend is
 * the existing z-ai-web-dev-sdk so the demo runs without burning quota.
 *
 * Voice routing (practical to run for real, not just as a demo):
 *   In DRY_RUN/dev mode, callers pass the z-ai voice slugs ("jam", "kazi"…)
 *   that voice-client.ts maps per language. In prod mode, the route layer
 *   resolves a language to one of the ELEVENLABS_VOICE_* env vars — a real
 *   ElevenLabs voice_id from the operator's own library (settings → Voices).
 *   That way a deployment only needs five env vars to go live, with no code
 *   change, and cloned-bank voices can be swapped per language.
 *
 * Safety nets layered in front of every call:
 *   1. Rate-limit by (scope, callerId) — refuses with 429 once budget is spent
 *   2. Idempotency key derived from canonical request bytes — replay returns
 *      the stored response without a second upstream call
 *   3. Response caching (1h TTL by default) — identical TTS requests dedupe
 *      inside the wrapper, so a hot demo path can't burn quota
 *   4. PII redaction on all log lines / audit rows / webhook payloads
 *   5. Dry-run mode (ELEVENLABS_DRY_RUN=true) — skips the upstream call
 *      entirely and returns a synthetic placeholder; CI + judges use this
 */

import { createHash } from "node:crypto";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { withIdempotency } from "@/lib/idempotency";
import { transcript as redactText } from "@/lib/redact";
import { env, isProdVoiceMode, TTS_CACHE_TTL_MS, TTS_CACHE_MAX } from "@/lib/config";

export type TtsLang = "en" | "ar" | "hi" | "ur" | "fr" | "sw";

export type TtsRequest = {
  text: string;
  voice: string;
  speed?: number;
  lang: TtsLang;
  callerId: string;
  callRef: string;
};

export type TtsResult = {
  audio: Buffer; // WAV bytes
  contentType: string; // "audio/wav"
  bytes: number;
  cached: boolean;
  replayed: boolean;
  voice: string;
  model: string;
};

type CacheEntry = { buf: Buffer; at: number; ct: string };
const TTS_CACHE = new Map<string, CacheEntry>();

// separate scope/bucket from the route-level limiter so one user request
// doesn't consume two tokens of the same 60/hour bucket
const TTS_SCOPE = "tts-upstream";
const TTS_BUCKET = "tts-upstream";

/** z-ai dev-backend voice slugs (dry-run mode only). */
export const DEV_VOICES = new Set([
  "tongtong",
  "chuichui",
  "xiaochen",
  "jam",
  "kazi",
  "douji",
  "luodo",
]);

/**
 * Resolve a TTS voice for prod (ElevenLabs) mode: language → operator-configured
 * voice_id via env. Falls back to the dev slug set so a misconfigured deployment
 * fails loudly at the route layer (422 unknown voice) rather than sending a
 * dev slug to the real API (which would 422 upstream anyway, but later and billably).
 */
export const ELEVEN_VOICE_ENV: Record<TtsLang, string> = {
  en: process.env.ELEVENLABS_VOICE_EN ?? "",
  ar: process.env.ELEVENLABS_VOICE_AR ?? "",
  hi: process.env.ELEVENLABS_VOICE_HI ?? "",
  ur: process.env.ELEVENLABS_VOICE_UR ?? "",
  fr: process.env.ELEVENLABS_VOICE_FR ?? "",
  sw: process.env.ELEVENLABS_VOICE_SW ?? "",
};

/** Some languages need a different model: Swahili ships in Flash v2.5 (32
 *  languages), not Multilingual v2 (29). French is native to v2. */
/**
 * Languages the default model cannot voice, and the model that can.
 *
 * `eleven_multilingual_v2` carries 29 languages and `eleven_flash_v2_5` carries
 * those same 29 plus hu/no/vi. NEITHER includes Urdu or Swahili, so routing
 * `sw` to flash v2.5 — which is what this map used to do — selects a model that
 * cannot synthesise the language it exists to support. Both languages are in
 * the v3 generation's 74, so they are pinned there.
 *
 * Availability of the v3 generation on a given account tier is NOT verified
 * here; it is asserted at runtime by the first synthesis. Override with
 * ELEVENLABS_TTS_MODEL_UR / _SW if the account needs a different model.
 */
const MODEL_FOR_LANG: Partial<Record<TtsLang, string>> = {
  ur: process.env.ELEVENLABS_TTS_MODEL_UR ?? "eleven_v3",
  sw: process.env.ELEVENLABS_TTS_MODEL_SW ?? "eleven_v3",
};

/**
 * Which TTS model can voice which caller language. Exported so the docs and the
 * gate are checked against the same table the client uses, rather than a claim
 * restated in markdown.
 */
export const TTS_LANGUAGE_SUPPORT: Record<TtsLang, { multilingual_v2: boolean; v3: boolean }> = {
  en: { multilingual_v2: true, v3: true },
  ar: { multilingual_v2: true, v3: true },
  hi: { multilingual_v2: true, v3: true },
  fr: { multilingual_v2: true, v3: true },
  ur: { multilingual_v2: false, v3: true },
  sw: { multilingual_v2: false, v3: true },
};

/** Prod mode = a real key configured AND dry-run disabled. */
export { isProdVoiceMode };

/** The set of voices the /api/tts route accepts in the current mode. */
export function allowedVoices(): Set<string> {
  if (!isProdVoiceMode()) return DEV_VOICES;
  const ids = new Set<string>();
  for (const v of Object.values(ELEVEN_VOICE_ENV)) if (v) ids.add(v);
  return ids;
}

/** Map a requested voice (dev slug or language) to the voice_id actually sent upstream. */
export function resolveVoice(voice: string): string {
  if (!isProdVoiceMode()) return voice; // dev slugs pass through to z-ai
  // Already a configured ElevenLabs voice_id → use as-is
  if (Object.values(ELEVEN_VOICE_ENV).includes(voice)) return voice;
  return voice; // unknown — route layer rejects before we get here
}

function ttsCacheKey(req: TtsRequest): string {
  return createHash("sha1")
    .update(`${req.voice}|${(req.speed ?? 1).toFixed(2)}|${redactText(req.text)}`)
    .digest("hex");
}

function ttsCacheGet(req: TtsRequest): CacheEntry | null {
  const key = ttsCacheKey(req);
  const hit = TTS_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTS_CACHE_TTL_MS) {
    TTS_CACHE.delete(key);
    return null;
  }
  return hit;
}

function ttsCacheSet(req: TtsRequest, buf: Buffer, ct: string) {
  if (TTS_CACHE.size >= TTS_CACHE_MAX) {
    // LRU-ish: drop oldest
    let oldestKey = "";
    let oldest = Infinity;
    for (const [k, v] of TTS_CACHE) {
      if (v.at < oldest) {
        oldest = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) TTS_CACHE.delete(oldestKey);
  }
  TTS_CACHE.set(ttsCacheKey(req), { buf, at: Date.now(), ct });
}

/**
 * Synthesize speech. Returns the audio bytes plus provenance metadata. The
 * upstream provider is selected by env: ELEVENLABS_DRY_RUN=true → z-ai SDK,
 * else → real ElevenLabs HTTP API.
 */
export async function tts(req: TtsRequest, opts?: { keyOverride?: string }): Promise<TtsResult> {
  // 1. Rate-limit (cheap; runs first). Distinct scope from the route-level
  //    limiter so a single request doesn't burn two tokens of the same bucket.
  const rl = consumeRateLimit(TTS_BUCKET, req.callerId);
  if (!rl.ok) {
    throw new UpstreamError(
      `Rate limit exceeded for caller ${req.callerId}; retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`,
      429,
      "rate_limited",
    );
  }

  // 2. Process-local cache (free)
  const cached = ttsCacheGet(req);
  if (cached) {
    return {
      audio: cached.buf,
      contentType: cached.ct,
      bytes: cached.buf.length,
      cached: true,
      replayed: false,
      voice: req.voice,
      model: env.elevenLabsDryRun ? "z-ai:dev" : "elevenlabs:prod",
    };
  }

  // 3. Idempotent upstream call. The payload is persisted as base64 (not
  //    JSON.stringify(Buffer), which would not survive the round-trip as a
  //    Buffer and would corrupt replays for 24h).
  const result = await withIdempotency<TtsResult>({
    scope: TTS_SCOPE,
    key: JSON.stringify({ text: redactText(req.text), voice: req.voice, speed: req.speed ?? 1 }),
    callerId: req.callerId,
    fn: async () => {
      const { buf, ct } = await callUpstreamTts(req, opts?.keyOverride);
      ttsCacheSet(req, buf, ct);
      return {
        audio: buf,
        contentType: ct,
        bytes: buf.length,
        cached: false,
        replayed: false,
        voice: req.voice,
        model: process.env.ELEVENLABS_DRY_RUN === "true" ? "z-ai:dev" : "elevenlabs:prod",
      };
    },
    serialize: (v) =>
      JSON.stringify({
        a: v.audio.toString("base64"),
        ct: v.contentType,
        m: v.model,
        voice: v.voice,
        bytes: v.bytes,
      }),
    deserialize: (s) => {
      const o = JSON.parse(s) as { a: string; ct: string; m: string; voice: string; bytes: number };
      return {
        audio: Buffer.from(o.a, "base64"),
        contentType: o.ct,
        bytes: o.bytes,
        cached: false,
        replayed: true,
        voice: o.voice,
        model: o.m,
      };
    },
  });
  return result.value;
}

async function callUpstreamTts(
  req: TtsRequest,
  keyOverride?: string,
): Promise<{ buf: Buffer; ct: string }> {
  if (!env.elevenLabsDryRun && keyOverride) {
    return { buf: await callElevenLabsTts(req, keyOverride), ct: "audio/mpeg" };
  }
  if (env.elevenLabsDryRun) {
    return { buf: await callZaiTts(req), ct: "audio/wav" };
  }
  if (env.elevenLabsApiKey) {
    return { buf: await callElevenLabsTts(req), ct: "audio/mpeg" };
  }
  // Safe default in dev: use z-ai so the demo always works.
  try {
    return { buf: await callZaiTts(req), ct: "audio/wav" };
  } catch {
    return { buf: SILENT_WAV, ct: "audio/wav" };
  }
}

/** 1-second mono 16 kHz 16-bit PCM silence with a valid WAV header.
 *  Used only when both ElevenLabs and the z-ai dev backend are unavailable
 *  (e.g. local demo without a configured SDK key). Recognizably silent. */
const SILENT_WAV: Buffer = (() => {
  const sampleRate = 16000;
  const samples = sampleRate; // 1s
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  // samples are already zero → silence
  return buf;
})();

async function callZaiTts(req: TtsRequest): Promise<Buffer> {
  const mod = await import("z-ai-web-dev-sdk");
  const zai = await mod.default.create();
  const res = await Promise.race([
    zai.audio.tts.create({
      input: req.text,
      voice: req.voice,
      speed: req.speed ?? 1.0,
      response_format: "wav",
      stream: false,
    }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("TTS timeout")), 25_000)),
  ]);
  const ab = await (res as Response).arrayBuffer();
  const buf = Buffer.from(new Uint8Array(ab));
  if (buf.length < 512) throw new UpstreamError("TTS returned empty audio", 502, "empty_audio");
  return buf;
}

async function callElevenLabsTts(req: TtsRequest, keyOverride?: string): Promise<Buffer> {
  // Every billable byte goes through the shared egress guard: egress throttle,
  // monthly account budget, conversation-plane breaker, jittered retry.
  const { fetchUpstreamBinary } = await import("@/lib/elevenlabs/egress");
  const model = MODEL_FOR_LANG[req.lang] ?? env.elevenLabsModel;

  // A BYOK caller spends their own quota, not the platform's 10k, so nothing is
  // reserved — but the key must be THEIRS. Passing it through `apiKey` is what
  // keeps the guard from quietly synthesising on the platform key instead.
  const res = await fetchUpstreamBinary(
    "POST",
    `/v1/text-to-speech/${encodeURIComponent(req.voice)}`,
    {
      headers: { "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text: req.text,
        model_id: model,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          use_speaker_boost: true,
          speed: req.speed ?? 1.0,
        },
      }),
      billableChars: keyOverride ? 0 : req.text.length,
      apiKey: keyOverride,
      callerId: req.callerId,
      timeoutMs: 25_000,
      maxRetries: 2,
    },
  );
  if (!res.ok) {
    throw new UpstreamError(
      `ElevenLabs ${res.status}: ${res.body.slice(0, 200)}`,
      res.status,
      "upstream",
    );
  }
  const ab = await res.response.arrayBuffer();
  const buf = Buffer.from(new Uint8Array(ab));
  if (buf.length < 512)
    throw new UpstreamError("ElevenLabs returned empty audio", 502, "empty_audio");
  return buf;
}

export class UpstreamError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
  }
}

/** Test helper. */
export function _resetCaches(): void {
  TTS_CACHE.clear();
}
