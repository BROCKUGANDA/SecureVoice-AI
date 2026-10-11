import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  tts as elevenTts,
  UpstreamError,
  DEV_VOICES,
  ELEVEN_VOICE_ENV,
  allowedVoices,
  isProdVoiceMode,
  resolveTtsModel,
  type TtsLang,
} from "@/lib/elevenlabs/client";
import { generateAudioWithFailover } from "@/lib/elevenlabs/pool";
import { generatePlayhtAudio, isPlayhtConfigured } from "@/lib/elevenlabs/playht";
import { getEmergencyAudio, EMERGENCY_AUDIO_CONTENT_TYPE } from "@/lib/elevenlabs/emergency-audio";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";
import { resolveTtsKey, consumeCharQuota, quotaExceededResponse } from "@/lib/tts-quota";
import { SUPPORTED_LANGS, maxTtsChars } from "@/lib/config";
import {
  badRequest,
  tooManyRequests,
  unprocessable,
  upstreamError,
  parseJson,
} from "@/lib/api-errors";
import { logError } from "@/lib/validation/safe-log";

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

const LANGS = new Set<string>(SUPPORTED_LANGS);
const MAX_CHARS = maxTtsChars();

const schema = z.object({
  text: z.string().min(1).max(MAX_CHARS),
  voice: z.string().min(1).max(64),
  speed: z.number().min(0.5).max(2.0).optional(),
  lang: z.enum(SUPPORTED_LANGS).default("en"),
  callRef: z.string().min(3).max(64).optional(),
});

/** Dev-backend voice slugs → the language they represent (per voice-client.ts routing).
 *  In prod mode these arrive from the existing demo UI and alias to the
 *  language's configured ElevenLabs voice, so the same frontend works in
 *  both modes without changes. */
const DEV_SLUG_LANG: Record<string, TtsLang> = {
  jam: "en",
  kazi: "hi",
  tongtong: "ar",
  chuichui: "ar",
  douji: "hi",
  luodo: "ur",
  xiaochen: "ur",
};

/** Resolve the requested voice to the id sent upstream. */
function resolveVoice(voice: string, lang: TtsLang): string {
  // 1. Language key ("en"…) → configured voice for the current mode
  if (LANGS.has(voice)) {
    const v = voice as TtsLang;
    return isProdVoiceMode() ? ELEVEN_VOICE_ENV[v] : defaultDevVoice(v);
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

/**
 * Synthesize speech with a fallback ladder.
 *
 * A fraud call cannot afford silence. If the primary TTS provider fails, the
 * call must still speak — even if the voice is different, the quality is lower,
 * or the content is a pre-recorded cue. This function tries each rung in order:
 *
 *   1. Primary: `elevenTts()` with the resolved key (BYOK or platform).
 *   2. Fallback 1 (platform only): `generateAudioWithFailover()` — the ElevenLabs
 *      key pool. Only used when the caller is on the PLATFORM key, because a
 *      BYOK tenant is entitled to bill themselves and must not spend the
 *      platform's shared quota.
 *   3. Fallback 2: `generatePlayhtAudio()` — PlayHT, a separate vendor with
 *      its own credentials and rate limits.
 *   4. Fallback 3: `getEmergencyAudio("error")` — a pre-recorded WAV cue that
 *      tells the caller "the system is still here, this is not a dead line".
 *
 * Each rung is tried only if the previous one failed. The function returns the
 * audio bytes, content type, and metadata about which rung succeeded. If every
 * rung fails, the last error is re-thrown.
 *
 * The `failed` array is accumulated across rungs and returned to the caller so
 * the audit log can record which rungs were attempted and why they failed.
 */
async function synthesizeWithLadder(args: {
  text: string;
  voice: string;
  lang: TtsLang;
  speed?: number;
  callerId: string;
  callRef: string;
  keyOverride?: string;
  model?: string;
}): Promise<{
  audio: Buffer;
  contentType: string;
  bytes: number;
  source: string;
  degraded: boolean;
  failed: Array<{ rung: string; error: string }>;
}> {
  const { text, voice, lang, speed, callerId, callRef, keyOverride, model } = args;
  const failed: Array<{ rung: string; error: string }> = [];

  // Rung 1: primary ElevenLabs (BYOK or platform key).
  try {
    const result = await elevenTts(
      { text, voice, speed, lang, callerId, callRef },
      { keyOverride },
    );
    return {
      audio: result.audio,
      contentType: result.contentType,
      bytes: result.bytes,
      source: keyOverride ? "byok" : "elevenlabs",
      degraded: false,
      failed,
    };
  } catch (err) {
    failed.push({
      rung: "elevenlabs",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Rung 2: ElevenLabs key pool (platform key only).
  //
  // A BYOK tenant has their own ElevenLabs account with its own quota. Sending
  // their traffic through the platform's key pool would spend the platform's
  // shared monthly quota on a call the tenant is entitled to bill themselves —
  // precisely the confusion the BYOK path exists to prevent.
  if (!keyOverride) {
    try {
      const result = await generateAudioWithFailover(text, voice, {
        callerId,
        model: model ?? resolveTtsModel(lang),
        speed,
      });
      return {
        audio: result.audio,
        contentType: result.contentType,
        bytes: result.bytes,
        source: "elevenlabs-pool",
        degraded: true,
        failed,
      };
    } catch (err) {
      failed.push({
        rung: "elevenlabs-pool",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Rung 3: PlayHT.
  const playhtVoiceId = process.env.PLAYHT_VOICE_ID;
  if (isPlayhtConfigured() && playhtVoiceId) {
    try {
      const result = await generatePlayhtAudio(text, playhtVoiceId, {
        callerId,
        speed,
      });
      return {
        audio: result.audio,
        contentType: result.contentType,
        bytes: result.bytes,
        source: "playht",
        degraded: true,
        failed,
      };
    } catch (err) {
      failed.push({
        rung: "playht",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Rung 4: emergency audio.
  //
  // The last resort. A short, recognisable cue that tells the caller the system
  // is still here. It is not speech — it cannot convey the transaction details
  // — but it prevents the silence that a scammer's hangup would produce.
  const emergency = getEmergencyAudio("error");
  return {
    audio: emergency,
    contentType: EMERGENCY_AUDIO_CONTENT_TYPE,
    bytes: emergency.length,
    source: "emergency",
    degraded: true,
    failed,
  };
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  const callerId = rateLimitId(req);

  // 1. Body parse + validation
  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return unprocessable("Invalid TTS request");
  }
  const {
    text,
    speed,
    lang,
    callRef = `SV-T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  } = parsed.data;

  // 2. Resolve + validate the voice against the current backend's registry
  const voice = resolveVoice(parsed.data.voice, lang);
  const allowed = allowedVoices();
  if (!allowed.has(voice)) {
    const hint = isProdVoiceMode()
      ? "voice must be a language key (en|ar|hi|ur|fr|sw) or a configured ElevenLabs voice_id (set ELEVENLABS_VOICE_EN/AR/HI/UR)"
      : `voice must be a language key (en|ar|hi|ur|fr|sw) or a dev voice (${[...DEV_VOICES].join(", ")})`;
    return NextResponse.json(
      { error: `Unknown voice '${parsed.data.voice}'. ${hint}` },
      { status: 422 },
    );
  }

  // 3. Rate-limit BEFORE the upstream call (the wrapper has its own, but a
  //    fast reject here keeps the audit log clean of "denied" entries)
  const rl = consumeRateLimit("tts", callerId);
  if (!rl.ok) {
    return tooManyRequests("Rate limit exceeded; retry later.", Math.ceil(rl.retryAfterMs / 1000));
  }

  // 4. Synthesize via the wrapper (cached + idempotent + upstream).
  //    Key logic (per org): BYOK first — an operator's own ElevenLabs key has
  //    NO limits. Without BYOK, the platform demo key is metered at 2,000
  //    chars/day/user so a scraped link can't drain the shared quota.
  const keyRes = await resolveTtsKey();
  if (keyRes.mode === "anonymous") {
    // Refuse BEFORE any vendor call. An unauthenticated caller must not be able
    // to spend the platform's ElevenLabs key: there is no profile row to charge,
    // so the daily quota cannot be enforced and every request is free.
    return NextResponse.json({ error: keyRes.reason }, { status: 401 });
  }
  if (keyRes.mode === "platform") {
    const charged = await consumeCharQuota(keyRes, text);
    if (!charged.ok) {
      return tooManyRequests(quotaExceededResponse().error, 3600);
    }
  }
  const keyOverride = keyRes.mode === "byok" ? keyRes.keyOverride : undefined;

  try {
    const result = await synthesizeWithLadder({
      text,
      voice,
      lang,
      speed,
      callerId,
      callRef,
      keyOverride,
    });

    // 5. Audit-chain append — redacted text only
    auditAppend({
      callRef,
      action: "tts",
      callerId,
      redactedText: redactText(text).slice(0, 200),
      meta: {
        lang,
        voice: result.source,
        bytes: result.bytes,
        cached: false,
        replayed: false,
        model: result.source,
        latencyMs: Date.now() - started,
        degraded: result.degraded,
        failed_rungs: result.failed,
      },
    }).catch((err) => {
      logError("[tts] audit append failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return new NextResponse(new Uint8Array(result.audio), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Length": String(result.bytes),
        "Cache-Control": "private, max-age=86400",
        "X-Voice-Source": result.source,
        "X-Voice-Degraded": result.degraded ? "true" : "false",
      },
    });
  } catch (err) {
    if (err instanceof UpstreamError) {
      // Error generalization: the upstream detail (provider, key state, raw
      // body) stays in server logs — clients get a coarse, safe message.
      logError("[tts] upstream error", { status: err.status, error: err.message });
      if (err.status === 429) {
        return NextResponse.json(
          { error: "Rate limit exceeded; retry later." },
          { status: 429, headers: { "Retry-After": "60" } },
        );
      }
      const generic =
        err.status === 401 || err.status === 403
          ? "Voice service authentication failed — contact the operator."
          : "Speech synthesis is temporarily unavailable — try again shortly.";
      return NextResponse.json(
        { error: generic },
        { status: err.status === 401 || err.status === 403 ? 502 : 503 },
      );
    }
    logError("[tts] generation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Speech generation unavailable" }, { status: 503 });
  }
}
