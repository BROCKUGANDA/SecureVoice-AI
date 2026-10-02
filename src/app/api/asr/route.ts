import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";

export const dynamic = "force-dynamic";

/**
 * Speech-to-text — accepts a base64-encoded recording (webm/opus, wav, mp3…)
 * from the in-browser MediaRecorder and returns the transcript.
 *
 * When ELEVENLABS_API_KEY is set and ELEVENLABS_DRY_RUN is not, uses the
 * ElevenLabs Speech-to-Text endpoint. Otherwise falls back to z-ai for the
 * public demo (no quota burn).
 */

const MAX_B64_CHARS = 24_000_000; // ≈ 18 MB raw audio
// Reject oversize payloads before parsing — req.json() would otherwise buffer
// the whole body for an attacker regardless of the schema's max() check.
const MAX_BODY_BYTES = 34_000_000; // JSON/base64 overhead over MAX_B64_CHARS

const schema = z.object({
  audio: z.string().min(1).max(MAX_B64_CHARS),
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
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
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
  const { audio, mime, lang, callRef = `SV-A-${Math.random().toString(36).slice(2, 8).toUpperCase()}` } = parsed.data;

  try {
    const text = await transcribe(audio, mime, lang);
    if (!text) {
      return NextResponse.json(
        { error: "No speech detected — try again a little closer to the mic." },
        { status: 422 }
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
      console.error("[asr] audit append failed:", err instanceof Error ? err.message : err);
    });

    return NextResponse.json({ ok: true, text, mime, callRef });
  } catch (err) {
    console.error("[asr] transcription failed:", err instanceof Error ? err.message : err);
    const msg = err instanceof Error && err.message === "ASR timeout"
      ? "Transcription timed out — please try a shorter recording."
      : "Transcription unavailable right now. You can type your answer instead.";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}

async function transcribe(audioB64: string, mime: string, lang?: string): Promise<string> {
  // Vendor chain: ElevenLabs Scribe (if configured) → Deepgram nova-2 (fast,
  // independent vendor) → z-ai dev backend. First non-empty transcript wins.
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_DRY_RUN !== "true") {
    try {
      const text = await transcribeElevenLabs(audioB64, mime);
      if (text) return text;
    } catch {
      // fall through to the next vendor
    }
  }
  if (process.env.DEEPGRAM_API_KEY) {
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
  const params = new URLSearchParams({ model: "nova-2", smart_format: "true" });
  if (dgLang) params.set("language", dgLang);
  const r = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": mime || "audio/wav",
    },
    body: new Uint8Array(buf),
    signal: AbortSignal.timeout(30_000),
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
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ASR timeout")), 30_000)),
  ]);
  return (res as { text?: string }).text ?? "";
}

async function transcribeElevenLabs(audioB64: string, mime: string): Promise<string> {
  const key = process.env.ELEVENLABS_API_KEY!;
  // Default to scribe_v2 (current generation, matches the deck claim); pin
  // scribe_v1 via ELEVENLABS_STT_MODEL if the account tier requires it.
  const model = process.env.ELEVENLABS_STT_MODEL ?? "scribe_v2";
  // ElevenLabs STT expects multipart/form-data with a file field
  const buf = Buffer.from(audioB64, "base64");
  const blob = new Blob([buf], { type: mime });
  const form = new FormData();
  form.append("file", blob, "recording");
  form.append("model_id", model);
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`ElevenLabs STT ${r.status}: ${detail.slice(0, 200)}`);
  }
  const data = await r.json();
  return (data.text ?? "").toString().trim();
}