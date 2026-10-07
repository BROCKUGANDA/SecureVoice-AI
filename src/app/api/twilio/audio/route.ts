import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { env } from "@/lib/config";
import { tts as elevenTts } from "@/lib/elevenlabs/client";
import { verifyAudioSignature } from "@/lib/twilio";

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
  const rl = consumeRateLimit("twilio-audio", rateLimitId(req, callRef));
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
    return new NextResponse(new Uint8Array(cached), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(cached.length),
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

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
      meta: { lang, voice, bytes: result.bytes, purpose: "twilio_play" },
    }).catch(() => {});

    return new NextResponse(new Uint8Array(result.audio), {
      headers: {
        "Content-Type": result.contentType || "audio/mpeg",
        "Content-Length": String(result.bytes),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error(
      "[twilio-audio] TTS generation failed:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "Audio generation unavailable" }, { status: 503 });
  }
}
