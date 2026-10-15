import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { env } from "@/lib/config";
import { tts as elevenTts } from "@/lib/elevenlabs/client";
import { generateAudioWithFailover, isPoolConfigured } from "@/lib/elevenlabs/pool";
import { generatePlayhtAudio, isPlayhtConfigured, playhtVoice } from "@/lib/elevenlabs/playht";
import { EMERGENCY_AUDIO_CONTENT_TYPE, getEmergencyAudio } from "@/lib/elevenlabs/emergency-audio";
import { verifyAudioSignature } from "@/lib/twilio";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * ElevenLabs audio generation for Twilio `<Play>` — generates an MP3 from
 * text using the configured ElevenLabs voice for the given language, caches
 * it in-memory, and serves it as audio/mpeg.
 *
 * Twilio `<Play url="https://.../api/twilio/audio?...">` fetches this endpoint
 * during the call. The audio is pre-generated before the call is placed, so
 * the first bytes arrive instantly when Twilio requests them.
 *
 * Query params:
 *   text — the text to speak (URL-encoded, max 1024 chars)
 *   lang — language code (en|ar|hi|ur|fr|sw)
 *   callRef — audit chain reference
 */

const LANG_TO_VOICE: Record<string, string> = {
  en: env.voiceFor("en") ?? "",
  ar: env.voiceFor("ar") ?? "",
  hi: env.voiceFor("hi") ?? "",
  ur: env.voiceFor("ur") ?? "",
  fr: env.voiceFor("fr") ?? "",
  sw: env.voiceFor("sw") ?? "",
};

// Cache: generated audio survives across requests (TTL 1h, max 48 entries)
const audioCache = new Map<string, { buf: Buffer; at: number }>();
const CACHE_TTL = env.twilioAudioCacheTtlMs;
const CACHE_MAX = 48;

function cacheGet(key: string): Buffer | null {
  const hit = audioCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    audioCache.delete(key);
    return null;
  }
  return hit.buf;
}

function cacheSet(key: string, buf: Buffer) {
  if (audioCache.size >= CACHE_MAX) {
    let oldest = "";
    let oldestAt = Infinity;
    for (const [k, v] of audioCache) {
      if (v.at < oldestAt) {
        oldest = k;
        oldestAt = v.at;
      }
    }
    if (oldest) audioCache.delete(oldest);
  }
  audioCache.set(key, { buf, at: Date.now() });
}

/**
 * Everything this route hands Twilio is audio.
 *
 * `X-Voice-Source` names the rung that produced the bytes, so a call served from
 * cache, from a failover key, from a second vendor, or from a generated tone is
 * distinguishable in an operator's log without being distinguishable to the
 * customer.
 *
 * A degraded rung still answers 200. `<Play>` will not fetch audio behind an
 * error status, and the alternative is silence on a fraud call — which reads to
 * the customer exactly like a scammer hanging up. The degradation travels in the
 * headers and the audit row instead, where an operator can see it.
 */
function audioResponse(bytes: Uint8Array, contentType: string, source: string): NextResponse {
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=3600",
      "X-Voice-Source": source,
      ...(source === "elevenlabs" || source === "cache" ? {} : { "X-Voice-Degraded": "true" }),
    },
  });
}

export async function GET(req: NextRequest) {
  const text = req.nextUrl.searchParams.get("text") ?? "";
  const lang = (req.nextUrl.searchParams.get("lang") ?? "en") as keyof typeof LANG_TO_VOICE;
  // Raw param ("" when absent) — the signature is computed over exactly this.
  const callRefParam = req.nextUrl.searchParams.get("callRef") ?? "";

  if (!text || text.length > 1024) {
    return NextResponse.json({ error: "text required (1–1024 chars)" }, { status: 400 });
  }

  // Signed-URL gate: this endpoint renders TTS on the shared platform key, so
  // it must only serve URLs interventionTwiml minted. An unsigned (or
  // mis-signed) request is someone synthesizing arbitrary audio on our bill.
  const sig = req.nextUrl.searchParams.get("sig") ?? "";
  if (!verifyAudioSignature(text, lang, callRefParam, sig)) {
    return NextResponse.json({ error: "Invalid audio URL signature" }, { status: 403 });
  }

  const callRef = callRefParam || `SV-A-${Date.now().toString(36)}`;
  const rl = await consumeRateLimit("twilio-audio", rateLimitId(req, callRef));
  if (!rl.ok) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const voice = LANG_TO_VOICE[lang] || LANG_TO_VOICE.en;
  if (!voice) {
    return NextResponse.json({ error: "No voice configured for language" }, { status: 500 });
  }

  const cacheKey = `${voice}::${lang}::${text}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return audioResponse(cached, "audio/mpeg", "cache");
  }

  /** Which rungs have already been tried, recorded so a total voice failure can
   *  be read afterwards without guessing. */
  const failed: string[] = [];

  try {
    const result = await elevenTts({
      text,
      voice,
      lang: lang as "en" | "ar" | "hi" | "ur" | "fr" | "sw",
      callerId: "twilio-audio",
      callRef,
    });
    cacheSet(cacheKey, result.audio);

    // Audit the generation
    auditAppend({
      callRef,
      action: "tts",
      callerId: "twilio-audio",
      redactedText: redactText(text).slice(0, 200),
      meta: { lang, voice, bytes: result.bytes, purpose: "twilio_play", source: "elevenlabs" },
    }).catch(() => {});

    return audioResponse(result.audio, result.contentType || "audio/mpeg", "elevenlabs");
  } catch (err) {
    failed.push("elevenlabs");
    logError("[twilio-audio] primary voice path failed — falling over", {
      callRef,
      lang,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Rung 2 — the same vendor on other credentials, so an exhausted or rate-
  // limited key stops being a customer-facing dead line. Deliberately not cached:
  // a rung that answered while the primary was down must not pin its voice for an
  // hour after the primary recovers.
  if (isPoolConfigured()) {
    try {
      const pooled = await generateAudioWithFailover(text, voice, { callerId: "twilio-audio" });
      auditAppend({
        callRef,
        action: "tts",
        callerId: "twilio-audio",
        redactedText: redactText(text).slice(0, 200),
        meta: {
          lang,
          voice,
          bytes: pooled.bytes,
          purpose: "twilio_play",
          source: `elevenlabs-pool:${pooled.key}`,
          attempts: pooled.attempts,
          failed_rungs: failed.join(","),
        },
      }).catch(() => {});
      return audioResponse(pooled.audio, pooled.contentType, `elevenlabs-pool:${pooled.key}`);
    } catch (err) {
      failed.push("elevenlabs-pool");
      logError("[twilio-audio] key pool exhausted — trying the backup vendor", {
        callRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Rung 3 — a different vendor. `isPlayhtConfigured()` is false until the account
  // is credentialed, attested for commercial use, and given a voice, so an
  // unconfigured backup is skipped rather than attempted and failed.
  const backupVoice = playhtVoice();
  if (backupVoice && isPlayhtConfigured()) {
    try {
      const alt = await generatePlayhtAudio(text, backupVoice, { callerId: "twilio-audio" });
      auditAppend({
        callRef,
        action: "tts",
        callerId: "twilio-audio",
        redactedText: redactText(text).slice(0, 200),
        meta: {
          lang,
          voice: backupVoice,
          bytes: alt.audio.length,
          purpose: "twilio_play",
          source: "playht",
          failed_rungs: failed.join(","),
        },
      }).catch(() => {});
      return audioResponse(alt.audio, alt.contentType, "playht");
    } catch (err) {
      failed.push("playht");
      logError("[twilio-audio] backup vendor unavailable — serving the emergency cue", {
        callRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Rung 4 — no vendor at all. A short, language-neutral tone whose whole message
  // is "the system is still here, this is not a dead line". This is the case the
  // cue was built for: a fallback that has to ask the vendor that just failed for
  // permission to speak is not a fallback.
  failed.push("emergency-cue");
  const cue = getEmergencyAudio("error");
  logError("[twilio-audio] every voice path failed — serving the emergency cue", {
    callRef,
    lang,
    failed_rungs: failed.join(","),
  });
  auditAppend({
    callRef,
    action: "tts",
    callerId: "twilio-audio",
    redactedText: redactText(text).slice(0, 200),
    meta: {
      lang,
      purpose: "twilio_play",
      outcome: "emergency_cue",
      failed_rungs: failed.join(","),
      bytes: cue.length,
    },
  }).catch(() => {});
  return audioResponse(cue, EMERGENCY_AUDIO_CONTENT_TYPE, "emergency-cue");
}
