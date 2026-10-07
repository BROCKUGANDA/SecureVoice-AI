import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  DEV_VOICES,
  ELEVEN_VOICE_ENV,
  allowedVoices,
  isProdVoiceMode,
  resolveTtsModel,
  type TtsLang,
} from "@/lib/elevenlabs/client";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";
import { resolveTtsKey, consumeCharQuota, quotaExceededResponse } from "@/lib/tts-quota";
import { fetchUpstreamBinary } from "@/lib/elevenlabs/egress";

export const dynamic = "force-dynamic";

/**
 * Streaming neural TTS — pipes ElevenLabs' chunked audio straight to the
 * client (checklist #11: don't wait for the full render before playback).
 *
 * Same validation/voice resolution/audit as /api/tts, but the upstream body
 * streams through as it renders (optimize_streaming_latency=3). In dry-run
 * mode (z-ai dev backend has no stream API) it degrades to buffering the full
 * response — same contract, same status codes.
 */

const LANGS = new Set(["en", "ar", "hi", "ur", "fr", "sw"]);
const MAX_CHARS = 1024;

const schema = z.object({
  text: z.string().min(1).max(MAX_CHARS),
  voice: z.string().min(1).max(64),
  lang: z.enum(["en", "ar", "hi", "ur", "fr", "sw"]).default("en"),
  callRef: z.string().min(3).max(64).optional(),
});

const DEV_SLUG_LANG: Record<string, TtsLang> = {
  jam: "en",
  kazi: "hi",
  tongtong: "ar",
  chuichui: "ar",
  douji: "hi",
  luodo: "ur",
  xiaochen: "ur",
};

function resolveVoice(voice: string, lang: TtsLang): string {
  if (LANGS.has(voice)) {
    return isProdVoiceMode() ? ELEVEN_VOICE_ENV[voice as TtsLang] : devVoice(voice as TtsLang);
  }
  if (allowedVoices().has(voice)) return voice;
  if (isProdVoiceMode() && DEV_SLUG_LANG[voice]) {
    return ELEVEN_VOICE_ENV[DEV_SLUG_LANG[voice]] || voice;
  }
  return voice;
}

function devVoice(lang: TtsLang): string {
  return { en: "jam", ar: "tongtong", hi: "kazi", ur: "luodo", fr: "jam", sw: "kazi" }[lang];
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  const callerId = rateLimitId(req);

  const rl = consumeRateLimit("tts-stream", callerId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded; retry later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid TTS stream request" }, { status: 422 });
  }
  const {
    text,
    lang,
    callRef = `SV-S-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  } = parsed.data;
  const voice = resolveVoice(parsed.data.voice, lang);

  if (!allowedVoices().has(voice)) {
    return NextResponse.json({ error: `Unknown voice '${parsed.data.voice}'` }, { status: 422 });
  }

  if (!process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_DRY_RUN === "true") {
    // dev backend: no streaming — tell the client to use the buffered route
    return NextResponse.json(
      { error: "Streaming unavailable in dev mode — fall back to /api/tts", fallback: true },
      { status: 501 },
    );
  }

  // Same key rules as the buffered route: BYOK first, platform key metered at
  // 2,000 chars/day/user. (Previously the stream path bypassed metering and
  // ignored org keys — a free-tier quota leak.)
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
      return NextResponse.json(quotaExceededResponse(), {
        status: 429,
        headers: { "Retry-After": "3600" },
      });
    }
  }
  const apiKey = keyRes.mode === "byok" ? keyRes.keyOverride : process.env.ELEVENLABS_API_KEY;

  // Resolved from the same table the buffered route uses. This used to re-derive
  // the model locally (`sw` → flash v2.5), which ignored ELEVENLABS_MODEL for
  // every other language and picked a model that cannot speak Swahili.
  const model = resolveTtsModel(lang);

  const upstream = await fetchUpstreamBinary(
    "POST",
    `/v1/text-to-speech/${encodeURIComponent(voice)}/stream?optimize_streaming_latency=3`,
    {
      headers: { accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: true },
      }),
      // Only platform-key synthesis touches the shared 10k account budget; a
      // BYOK caller spends their own quota.
      billableChars: keyRes.mode === "platform" ? text.length : 0,
      apiKey,
      callerId,
      timeoutMs: 25_000,
      maxRetries: 2,
    },
  );

  if (!upstream.ok) {
    const detail = upstream.body.slice(0, 200);
    console.error("[tts-stream] upstream error:", upstream.status, detail);
    const auth = upstream.status === 401 || upstream.status === 403;
    // A guard refusal (budget, throttle, open breaker) is the platform degrading
    // on purpose; the client's fallback is the buffered route, then silence.
    return NextResponse.json(
      {
        error: auth
          ? "Voice service authentication failed — contact the operator."
          : "Speech streaming is temporarily unavailable — the client will fall back.",
        fallback: true,
        breakerOpen: upstream.breakerOpen,
        quotaExhausted: upstream.status === 429,
      },
      {
        status: auth ? 502 : 503,
        headers: upstream.status === 429 ? { "Retry-After": "60" } : undefined,
      },
    );
  }

  // Audit the stream event (bytes counted as chunks pass; recorded post-hoc
  // via content-length when known — streamed responses may not carry it).
  auditAppend({
    callRef,
    action: "tts",
    callerId,
    redactedText: redactText(text).slice(0, 200),
    meta: {
      lang,
      voice,
      streamed: true,
      model,
      latencyMs: Date.now() - started,
    },
  }).catch(() => {});

  return new Response(upstream.response.body, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Tts-Model": model,
      "X-Tts-Streamed": "true",
    },
  });
}
