import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { tts as elevenTts, UpstreamError, DEV_VOICES, ELEVEN_VOICE_ENV, allowedVoices, isProdVoiceMode, type TtsLang } from "@/lib/elevenlabs/client";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";
import { getProfile } from "@/lib/credits";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/byok";

export const dynamic = "force-dynamic";

/**
 * Neural TTS — wrapped through the ElevenLabs client (cached, idempotent,
 * rate-limited). Server-side only (API keys never reach the browser).
 *
 * Voice request forms accepted (either works in either mode):
 *   - a language key "en" | "ar" | "hi" | "ur" → resolved to the configured
 *     voice for the current backend (dev slug, or ELEVENLABS_VOICE_* in prod)
 *   - an explicit voice id valid for the current backend (dev slugs in
 *     dry-run; configured ElevenLabs voice_ids in prod)
 */

const LANGS = new Set(["en", "ar", "hi", "ur", "fr", "sw"]);
const MAX_CHARS = 1024;

const schema = z.object({
  text: z.string().min(1).max(MAX_CHARS),
  voice: z.string().min(1).max(64),
  speed: z.number().min(0.5).max(2.0).optional(),
  lang: z.enum(["en", "ar", "hi", "ur", "fr", "sw"]).default("en"),
  callRef: z.string().min(3).max(64).optional(),
});

/** Dev-backend voice slugs → the language they represent (per voice-client.ts routing).
 *  In prod mode these arrive from the existing demo UI and alias to the
 *  language's configured ElevenLabs voice, so the same frontend works in
 *  both modes without changes. */
const DEV_SLUG_LANG: Record<string, TtsLang> = {
  jam: "en", kazi: "hi",
  tongtong: "ar", chuichui: "ar",
  douji: "hi", luodo: "ur", xiaochen: "ur",
};

/** Resolve the requested voice to the id sent upstream. */
function resolveVoice(voice: string, lang: TtsLang): string {
  // 1. Language key ("en"…) → configured voice for the current mode
  if (LANGS.has(voice)) {
    return isProdVoiceMode() ? ELEVEN_VOICE_ENV[voice as TtsLang] : defaultDevVoice(voice as TtsLang);
  }
  // 2. Explicit valid voice for this mode → pass through
  if (allowedVoices().has(voice)) return voice;
  // 3. Dev slug arriving while in prod mode → alias to the language's
  //    configured voice (existing demo UI keeps working on the real API)
  if (isProdVoiceMode() && DEV_SLUG_LANG[voice]) {
    return ELEVEN_VOICE_ENV[DEV_SLUG_LANG[voice]] || voice;
  }
  return voice; // unknown — rejected below
}

/** Dev-mode default agent voice per language (matches voice-client routing). */
function defaultDevVoice(lang: TtsLang): string {
  return { en: "jam", ar: "tongtong", hi: "kazi", ur: "luodo", fr: "jam", sw: "kazi" }[lang];
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  const callerId = req.headers.get("x-caller-id") || "anon";

  // 1. Body parse + validation
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid TTS request" }, { status: 422 });
  }
  const { text, speed, lang, callRef = `SV-T-${Math.random().toString(36).slice(2, 8).toUpperCase()}` } = parsed.data;

  // 2. Resolve + validate the voice against the current backend's registry
  const voice = resolveVoice(parsed.data.voice, lang);
  const allowed = allowedVoices();
  if (!allowed.has(voice)) {
    const hint = isProdVoiceMode()
      ? "voice must be a language key (en|ar|hi|ur) or a configured ElevenLabs voice_id (set ELEVENLABS_VOICE_EN/AR/HI/UR)"
      : `voice must be a language key (en|ar|hi|ur) or a dev voice (${[...DEV_VOICES].join(", ")})`;
    return NextResponse.json({ error: `Unknown voice '${parsed.data.voice}'. ${hint}` }, { status: 422 });
  }

  // 3. Rate-limit BEFORE the upstream call (the wrapper has its own, but a
  //    fast reject here keeps the audit log clean of "denied" entries)
  const rl = consumeRateLimit("tts", callerId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded; retry later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  // 4. Synthesize via the wrapper (cached + idempotent + upstream).
  //    Key logic (per org): BYOK first — an operator's own ElevenLabs key has
  //    NO limits. Without BYOK, the platform demo key is metered at 2,000
  //    chars/day/user so a scraped link can't drain the shared quota.
  let keyOverride: string | undefined;
  const profile = await getProfile();
  if (profile) {
    const row = await db.userProfile.findUnique({
      where: { clerkUserId: profile.clerkUserId },
      select: { elevenKeyEnc: true, ttsCharsDate: true, ttsCharsToday: true },
    });
    if (row?.elevenKeyEnc) {
      keyOverride = decryptSecret(row.elevenKeyEnc) ?? undefined;
    } else if (row && process.env.ELEVENLABS_DRY_RUN !== "true" && process.env.ELEVENLABS_API_KEY) {
      const today = new Date().toISOString().slice(0, 10);
      const used = row.ttsCharsDate === today ? row.ttsCharsToday : 0;
      if (used + text.length > 2000) {
        return NextResponse.json(
          { error: "Daily neural-voice limit reached on the platform key — add your own ElevenLabs key in Settings → API Keys for unlimited usage." },
          { status: 429, headers: { "Retry-After": "3600" } }
        );
      }
      await db.userProfile.update({
        where: { clerkUserId: profile.clerkUserId },
        data: { ttsCharsDate: today, ttsCharsToday: used + text.length },
      });
    }
  }

  try {
    const result = await elevenTts({
      text,
      voice,
      speed,
      lang,
      callerId,
      callRef,
    }, { keyOverride });

    // 5. Audit-chain append — redacted text only
    auditAppend({
      callRef,
      action: "tts",
      callerId,
      redactedText: redactText(text).slice(0, 200),
      meta: {
        lang,
        voice: result.voice,
        bytes: result.bytes,
        cached: result.cached,
        replayed: result.replayed,
        model: result.model,
        latencyMs: Date.now() - started,
      },
    }).catch((err) => {
      console.error("[tts] audit append failed:", err instanceof Error ? err.message : err);
    });

    return new NextResponse(new Uint8Array(result.audio), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Length": String(result.bytes),
        "Cache-Control": "private, max-age=86400",
        "X-Tts-Cached": result.cached ? "true" : "false",
        "X-Tts-Replayed": result.replayed ? "true" : "false",
        "X-Tts-Model": result.model,
      },
    });
  } catch (err) {
    if (err instanceof UpstreamError) {
      // Error generalization: the upstream detail (provider, key state, raw
      // body) stays in server logs — clients get a coarse, safe message.
      console.error("[tts] upstream error:", err.status, err.message);
      if (err.status === 429) {
        return NextResponse.json({ error: "Rate limit exceeded; retry later." }, { status: 429, headers: { "Retry-After": "60" } });
      }
      const generic =
        err.status === 401 || err.status === 403
          ? "Voice service authentication failed — contact the operator."
          : "Speech synthesis is temporarily unavailable — try again shortly.";
      return NextResponse.json({ error: generic }, { status: err.status === 401 || err.status === 403 ? 502 : 503 });
    }
    console.error("[tts] generation failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Speech generation unavailable" }, { status: 503 });
  }
}
