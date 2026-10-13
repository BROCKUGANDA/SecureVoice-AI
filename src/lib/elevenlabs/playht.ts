import "server-only";
/**
 * PlayHT fallback TTS provider.
 *
 * ## Where this sits
 *
 * ElevenLabs is the primary voice. When the whole pool is down — every key
 * rate-limited or out of credits — the call still has to speak, and the answer
 * is a second vendor rather than silence. This module is that second vendor: a
 * single, self-contained PlayHT client the route can call when
 * `generateAudioWithFailover` (./pool.ts) throws.
 *
 * ## The API it speaks
 *
 *   POST https://api.play.ht/api/v2/tts
 *   Authorization: Bearer <PLAYHT_API_KEY>
 *   X-USER-ID:     <PLAYHT_USER_ID>
 *   Content-Type:  application/json
 *   { text, voice, voice_engine, output_format, sample_rate, quality, speed }
 *
 * The endpoint content-negotiates: `accept: audio/mpeg` returns raw audio bytes,
 * and `accept: text/event-stream` returns SSE whose final `completed` event
 * carries a signed URL to the audio. We ask for the audio, and parse the SSE as
 * a documented fallback so a deployment that gets the stream shape back still
 * gets audio instead of a confusing 200 with no bytes.
 *
 * ## Resilience — the same shape as the ElevenLabs egress guard
 *
 * PlayHT is a different vendor with different auth, so it cannot share
 * `guardedRequest` (that core is hardwired to `xi-api-key` and the ElevenLabs
 * base URL). It implements the SAME layers, in the same order, so a call site
 * reasons about one contract:
 *
 *   1. Per-caller egress throttle — `PLAYHT_EGRESS_PER_HOUR`, so a loop is
 *      refused before it reaches the vendor.
 *   2. A circuit breaker — after `PLAYHT_BREAKER_THRESHOLD` consecutive
 *      vendor-unavailable outcomes the breaker opens for
 *      `PLAYHT_BREAKER_OPEN_MS`; the next call after the cooldown is the probe,
 *      and it closes on success or re-opens on failure. A 4xx other than 429 is
 *      OUR bug, so it returns immediately and does NOT move the breaker.
 *   3. Retry with equal-jitter exponential backoff (reusing `backoffMs` from the
 *      egress guard) on 429/5xx and on transport errors, honouring a bounded
 *      `Retry-After`.
 *
 * It is deliberately NOT gated on `ELEVENLABS_COMMERCIAL_USE`: that attestation
 * is about the ElevenLabs account's terms, and PlayHT's terms are PlayHT's.
 */

import { backoffMs } from "@/lib/elevenlabs/egress";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { logWarn } from "@/lib/validation/safe-log";
import { voiceProfileFor, type VoicePace } from "@/lib/voice/presets";

/* ── Config (read per call, mirroring src/lib/config.ts's contract) ─────────── */

const playhtApiKey = (): string | undefined => process.env.PLAYHT_API_KEY?.trim() || undefined;
const playhtUserId = (): string | undefined => process.env.PLAYHT_USER_ID?.trim() || undefined;

/**
 * Has the operator attested that THIS vendor account may be used commercially?
 *
 * The ElevenLabs egress guard requires `ELEVENLABS_COMMERCIAL_USE=true` before
 * any billable byte leaves the process, because the free tier is non-commercial
 * only (ToS §1(c)(i)). A second vendor needs its own attestation and cannot
 * inherit that flag: saying "the operator attested ElevenLabs" is not a statement
 * about a PlayHT account, and a failover that silently spends an unattested
 * account is precisely the exposure the original guard exists to prevent.
 */
const commercialUseAttested = (): boolean => process.env.PLAYHT_COMMERCIAL_USE === "true";

/**
 * The voice the fallback speaks. There is no language map here: a cloned voice
 * is an operator decision with a real account behind it, and a failover that
 * invented one would be shipping a voice nobody chose. Unset means PlayHT is not
 * a usable rung and the caller moves on to the emergency cue.
 */
const playhtVoiceId = (): string | undefined => process.env.PLAYHT_VOICE_ID?.trim() || undefined;

/** Vendor host; overridable so a gateway or proxy can sit in front of it. */
const playhtBaseUrl = (): string =>
  (process.env.PLAYHT_API_BASE_URL ?? "https://api.play.ht").trim().replace(/\/+$/, "");

/** The PlayHT engine. `PlayHT2.0` is the stable engine that voices cloned voices. */
const playhtVoiceEngine = (): string => process.env.PLAYHT_VOICE_ENGINE?.trim() || "PlayHT2.0";

/** Audio container requested from the vendor. Drives both the body and `accept`. */
const playhtOutputFormat = (): string =>
  (process.env.PLAYHT_OUTPUT_FORMAT?.trim() || "mp3").toLowerCase();

const playhtQuality = (): string => process.env.PLAYHT_QUALITY?.trim() || "medium";

const playhtSampleRate = (): number => {
  const raw = Number(process.env.PLAYHT_SAMPLE_RATE);
  return Number.isFinite(raw) && raw > 0 ? raw : 24_000;
};

const playhtTimeoutMs = (): number => {
  const raw = Number(process.env.PLAYHT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 25_000;
};

const playhtEgressPerHour = (): number => {
  const raw = Number(process.env.PLAYHT_EGRESS_PER_HOUR);
  return Number.isFinite(raw) && raw > 0 ? raw : 120;
};

const playhtMaxRetries = (): number => {
  const raw = Number(process.env.PLAYHT_MAX_RETRIES);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 2;
};

/** Content type for a requested container, so the caller can hand it to a player. */
const FORMAT_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mulaw: "audio/basic",
  ogg: "audio/ogg",
  flac: "audio/flac",
};
function contentTypeFor(format: string): string {
  return FORMAT_CONTENT_TYPE[format] ?? "audio/mpeg";
}

/* ── Result / error shapes ─────────────────────────────────────────────────── */

export type PlayhtAudio = {
  audio: Buffer;
  contentType: string;
  bytes: number;
  /** The engine that produced the audio (`PlayHT2.0` unless overridden). */
  model: string;
};

/** Thrown on every non-success path, with the upstream status and a short code. */
export class PlayhtError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "PlayhtError";
    this.status = status;
    this.code = code;
  }
}

/* ── Retry ladder (mirrors src/lib/elevenlabs/egress.ts) ───────────────────── */

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
/** A hostile or misconfigured `Retry-After` must not park a request for ever. */
const MAX_RETRY_WAIT_MS = Number(process.env.PLAYHT_MAX_RETRY_WAIT_MS) || 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** `Retry-After` as milliseconds, clamped to a wait the caller can honour. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_WAIT_MS);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_WAIT_MS);
  return null;
}

/** Errors meaning "the vendor was unreachable", and so worth retrying. */
function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  return (
    code === "ECONNRESET" || code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT"
  );
}

/* ── Circuit breaker (a local instance; the shared DEPENDENCIES list is fixed) ─ */

const breakerThreshold = (): number => {
  const raw = Number(process.env.PLAYHT_BREAKER_THRESHOLD);
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 5;
};
const breakerOpenMs = (): number => {
  const raw = Number(process.env.PLAYHT_BREAKER_OPEN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
};

let consecutiveFailures = 0;
let breakerOpenUntil = 0;

/** True while the breaker is open. The call after the cooldown is the probe. */
function breakerOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

/** Only a vendor-UNAVAILABLE outcome moves the breaker; a 4xx is our own bug. */
function recordBreakerFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= breakerThreshold()) {
    breakerOpenUntil = Date.now() + breakerOpenMs();
  }
}

function recordBreakerSuccess(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

/* ── SSE fallback ──────────────────────────────────────────────────────────── */

/**
 * Pull the last audio URL out of a PlayHT SSE body. The stream is a sequence of
 * `event:`/`data:` frames ending in a `completed` event that carries a signed
 * `url`; non-JSON keep-alive lines are skipped. Returns null when there is none.
 */
function lastCompletedUrl(sse: string): string | null {
  let url: string | null = null;
  for (const line of sse.split(/\r?\n/)) {
    const m = /^data:\s*(.*)$/.exec(line);
    if (!m) continue;
    const data = (m[1] ?? "").trim();
    if (!data || data === "[DONE]") continue;
    try {
      const obj = JSON.parse(data) as { url?: unknown };
      if (typeof obj.url === "string" && /^https?:\/\//i.test(obj.url)) url = obj.url;
    } catch {
      // A keep-alive or a partial frame — nothing to read from it.
    }
  }
  return url;
}

/**
 * Read audio out of a 2xx response. `accept: audio/mpeg` yields raw bytes; if the
 * vendor answered with an SSE stream instead, follow the completed event's URL
 * (a signed object-store URL, so no auth is attached) and read the audio there.
 */
async function readAudio(res: Response): Promise<Buffer> {
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("text/event-stream")) {
    const url = lastCompletedUrl(await res.text());
    if (!url) {
      throw new PlayhtError("PlayHT stream ended with no completed audio event", 502, "sse_no_url");
    }
    const audioRes = await fetch(url, { method: "GET" });
    if (!audioRes.ok) {
      throw new PlayhtError(`PlayHT audio fetch failed (${audioRes.status})`, 502, "sse_fetch");
    }
    return Buffer.from(new Uint8Array(await audioRes.arrayBuffer()));
  }
  return Buffer.from(new Uint8Array(await res.arrayBuffer()));
}

/* ── Public surface ────────────────────────────────────────────────────────── */

/**
 * Is a PlayHT fallback actually usable? Credentials, attestation and a voice —
 * a rung that will throw when reached is not a rung, so callers ask this first.
 */
export function isPlayhtConfigured(): boolean {
  return !!(playhtApiKey() && playhtUserId() && commercialUseAttested() && playhtVoiceId());
}

/** The voice the fallback will speak, or undefined when none was chosen. */
export const playhtVoice = (): string | undefined => playhtVoiceId();

/**
 * Synthesise `text` in `voiceId` through PlayHT.
 *
 * @param text    The utterance.
 * @param voiceId A PlayHT voice id or manifest URL (e.g.
 *                `s3://voice-cloning-zero-shot/<id>/manifest.json`).
 * @param opts.callerId  Identity the egress throttle is keyed on.
 * @param opts.maxRetries  In-vendor retries. Defaults to `PLAYHT_MAX_RETRIES` (2).
 * @param opts.timeoutMs   Per-attempt timeout. Defaults to `PLAYHT_TIMEOUT_MS`.
 * @param opts.speed       Speech rate. Defaults to 1.
 * @returns The audio bytes plus their content type.
 * @throws  {PlayhtError} on every non-success path.
 */
export async function generatePlayhtAudio(
  text: string,
  voiceId: string,
  opts: {
    callerId?: string;
    maxRetries?: number;
    timeoutMs?: number;
    speed?: number;
    /** Named voice profile; see `@/lib/voice/presets`. */
    pace?: VoicePace;
    /** Per-language pacing multiplier, when targeting a specific language. */
    lang?: string;
  } = {},
): Promise<PlayhtAudio> {
  const apiKey = playhtApiKey();
  const userId = playhtUserId();
  if (!apiKey || !userId) {
    throw new PlayhtError(
      "PlayHT is not configured (set PLAYHT_API_KEY and PLAYHT_USER_ID)",
      503,
      "unconfigured",
    );
  }
  // Before any spend: an unattested account is not called, it is refused.
  if (!commercialUseAttested()) {
    throw new PlayhtError(
      "PlayHT is not attested for commercial use (set PLAYHT_COMMERCIAL_USE=true)",
      503,
      "unattested",
    );
  }

  const body = text ?? "";
  if (!body.trim()) throw new PlayhtError("no text to synthesise", 422, "empty_text");
  if (!voiceId) throw new PlayhtError("no voice id supplied", 422, "empty_voice");

  // 1. Throttle — before any spend, so a loop costs nothing but a refusal.
  const callerId = opts.callerId ?? "playht";
  const rl = await consumeRateLimit("playht-egress", callerId, 1, playhtEgressPerHour());
  if (!rl.ok) {
    throw new PlayhtError("PlayHT egress throttle exceeded", 429, "throttled");
  }

  // 2. Breaker — refuse fast while the vendor is known to be gone.
  if (breakerOpen()) {
    throw new PlayhtError("PlayHT circuit breaker is open", 503, "breaker_open");
  }

  const timeoutMs = opts.timeoutMs ?? playhtTimeoutMs();
  const maxRetries = opts.maxRetries ?? playhtMaxRetries();
  const format = playhtOutputFormat();
  const url = `${playhtBaseUrl()}/api/v2/tts`;
  const payload = JSON.stringify({
    text: body,
    voice: voiceId,
    voice_engine: playhtVoiceEngine(),
    output_format: format,
    sample_rate: playhtSampleRate(),
    quality: playhtQuality(),
    // PlayHT's request shape carries a rate and nothing else, so `speed` is the
    // only part of a preset that can travel here. That is also why this engine
    // is the one place the voice can audibly differ from the ElevenLabs path —
    // stability and speaker boost have no equivalent, and the two vendors will
    // not sound identical even at the same rate. Resolved from the same preset
    // module so at least the PACING agrees.
    speed: opts.speed ?? voiceProfileFor(opts.pace ?? "paced", opts.lang).speed,
  });
  const headers: Record<string, string> = {
    accept: contentTypeFor(format),
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "x-user-id": userId,
  };

  let last: { status: number; body: string } = { status: 0, body: "no attempt" };

  // 3. Retry. The ladder is INSIDE the guarded call, so one caller request moves
  // the breaker by one — not by its attempt count.
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
      });

      if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
        last = { status: res.status, body: (await res.text().catch(() => "")).slice(0, 300) };
        await sleep(retryAfterMs(res.headers.get("Retry-After")) ?? backoffMs(attempt));
        continue;
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        last = { status: res.status, body: txt.slice(0, 300) };
        // A 5xx/429 that survived the whole ladder is a vendor outage; fall
        // through to the failure accounting. A 4xx is our bad request — the
        // vendor answered correctly, so it must not move the breaker.
        if (RETRY_STATUS.has(res.status)) break;
        throw new PlayhtError(`PlayHT ${res.status}: ${txt.slice(0, 200)}`, res.status, "upstream");
      }

      const buf = await readAudio(res);
      if (buf.length < 512) {
        throw new PlayhtError("PlayHT returned empty audio", 502, "empty_audio");
      }
      recordBreakerSuccess();
      return {
        audio: buf,
        contentType: res.headers.get("content-type") ?? contentTypeFor(format),
        bytes: buf.length,
        model: playhtVoiceEngine(),
      };
    } catch (err) {
      // Our own typed errors (bad response shape) and programmer errors pass
      // straight through — they are not vendor unavailability.
      if (err instanceof PlayhtError) throw err;
      if (!isTransient(err)) throw err;
      last = {
        status: 0,
        body: err instanceof Error ? err.message.slice(0, 300) : "network error",
      };
      if (attempt >= maxRetries) break;
      await sleep(backoffMs(attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  recordBreakerFailure();
  logWarn("[elevenlabs/playht] vendor unavailable", {
    status: last.status,
    detail: last.body.slice(0, 160),
  });
  throw new PlayhtError(
    `PlayHT unavailable (${last.status || "network"}): ${last.body}`,
    last.status || 503,
    "unavailable",
  );
}

/** Reset the breaker's in-process state. Suites that drive failures need this. */
export function _resetPlayhtForTest(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}
