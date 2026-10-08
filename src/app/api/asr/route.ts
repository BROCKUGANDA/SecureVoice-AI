import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { env, MAX_ASR_B64_CHARS, MAX_ASR_BODY_BYTES } from "@/lib/config";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * Speech-to-text — accepts a base64-encoded recording (webm/opus, wav, mp3…)
 * from the in-browser MediaRecorder and returns the transcript.
 *
 * When ELEVENLABS_API_KEY is set and ELEVENLABS_DRY_RUN is not, uses the
 * ElevenLabs Speech-to-Text endpoint. Otherwise falls back to z-ai for the
 * public demo (no quota burn).
 */

const schema = z.object({
  audio: z.string().min(1).max(MAX_ASR_B64_CHARS),
  mime: z.string().min(1).max(64).default("audio/webm"),
  lang: z.string().min(2).max(8).optional(),
  callRef: z.string().min(3).max(64).optional(),
});

export async function POST(req: NextRequest) {
  const started = Date.now();
  const callerId = rateLimitId(req);

  // 1. Rate limit BEFORE touching the (potentially huge) body — cheapest
  //    possible reject; an exhausted caller can't make us buffer 18MB.
  const rl = consumeRateLimit("asr", callerId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded; retry later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  // Reject oversize payloads before parsing — req.json() would otherwise buffer
  // the whole body for an attacker regardless of the schema's max() check.
  // JSON/base64 overhead over MAX_ASR_B64_CHARS
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_ASR_BODY_BYTES) {
    return NextResponse.json({ error: "Audio payload too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid ASR request" }, { status: 422 });
  }
  const {
    audio,
    mime,
    lang,
    callRef = `SV-A-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  } = parsed.data;

  try {
    const text = await transcribe(audio, mime, lang);
    if (!text) {
      return NextResponse.json(
        { error: "No speech detected — try again a little closer to the mic." },
        { status: 422 },
      );
    }

    // Audit-chain append — redacted transcript only
    auditAppend({
      callRef,
      action: "asr",
      callerId,
      redactedText: redactText(text).slice(0, 200),
      meta: { mime, lang: lang ?? null, latencyMs: Date.now() - started },
    }).catch((err) => {
      logError("[asr] audit append failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return NextResponse.json({ ok: true, text, mime, callRef });
  } catch (err) {
    logError("[asr] transcription failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    const msg =
      err instanceof Error && err.message === "ASR timeout"
        ? "Transcription timed out — please try a shorter recording."
        : "Transcription unavailable right now. You can type your answer instead.";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}

async function transcribe(audioB64: string, mime: string, lang?: string): Promise<string> {
  // Vendor chain: ElevenLabs Scribe (if configured) → Deepgram nova-2 (fast,
  // independent vendor) → z-ai dev backend. First non-empty transcript wins.
  if (env.elevenLabsApiKey && !env.elevenLabsDryRun) {
    try {
      const text = await transcribeElevenLabs(audioB64, mime);
      if (text) return text;
    } catch {
      // fall through to the next vendor
    }
  }
  if (env.deepgramApiKey) {
    try {
      const text = await transcribeDeepgram(audioB64, mime, lang);
      if (text) return text;
    } catch {
      // fall through to the dev backend
    }
  }
  try {
    return await transcribeZai(audioB64);
  } catch {
    // Last-resort: return an empty transcript. Caller (the route) will 422
    // on empty text, telling the user to type their answer — the standard
    // ASR failure UX. In prod with vendor keys set, this path is unreachable.
    return "";
  }
}

/** Deepgram nova-2 — low-latency fallback with a language hint when we know
 *  it. nova-2 has NO Swahili/Urdu model: pinning an unsupported code errors
 *  the whole request, so those (and anything unmapped) fall to `multi`
 *  (code-switching detection) instead of a hard failure. */
const DEEPGRAM_LANGS = new Set(["en", "ar", "fr", "hi", "es", "de", "it", "pt", "nl", "ru"]);

async function transcribeDeepgram(audioB64: string, mime: string, lang?: string): Promise<string> {
  const buf = Buffer.from(audioB64, "base64");
  const dgLang = lang ? (DEEPGRAM_LANGS.has(lang) ? lang : "multi") : undefined;
  const params = new URLSearchParams({ model: env.deepgramSttModel, smart_format: "true" });
  if (dgLang) params.set("language", dgLang);
  const r = await fetch(`${env.deepgramBaseUrl}/listen?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${env.deepgramApiKey}`,
      "Content-Type": mime || "audio/wav",
    },
    body: new Uint8Array(buf),
    signal: AbortSignal.timeout(env.deepgramTimeoutMs),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`Deepgram ${r.status}: ${detail.slice(0, 120)}`);
  }
  const data = (await r.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  return (data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
}

async function transcribeZai(audioB64: string): Promise<string> {
  const mod = await import("z-ai-web-dev-sdk");
  const zai = await mod.default.create();
  const res = await Promise.race([
    zai.audio.asr.create({ file_base64: audioB64 }),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("ASR timeout")), env.asrTimeoutMs),
    ),
  ]);
  return (res as { text?: string }).text ?? "";
}

async function transcribeElevenLabs(audioB64: string, mime: string): Promise<string> {
  // Hardened path: same breaker + retry as every other ElevenLabs call. The
  // multipart form is rebuilt per attempt inside `elevenLabsStt` because a
  // consumed stream cannot be re-sent.
  const { elevenLabsStt } = await import("@/lib/elevenlabs/egress");
  // Default to scribe_v2 (current generation, matches the deck claim); pin
  // scribe_v1 via ELEVENLABS_STT_MODEL if the account tier requires it.
  const model = env.elevenLabsSttModel;
  const buf = Buffer.from(audioB64, "base64");
  const r = await elevenLabsStt(buf, mime, model);
  if (!r.ok) {
    throw new Error(`ElevenLabs STT ${r.status}: ${r.body.slice(0, 200)}`);
  }
  const data = (await r.response.json()) as { text?: unknown };
  return (data.text ?? "").toString().trim();
}
