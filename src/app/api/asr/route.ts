import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Real speech-to-text — accepts a base64-encoded recording (webm/opus, wav, mp3…)
 *  from the in-browser MediaRecorder and returns the transcript. */

const MAX_B64_CHARS = 24_000_000; // ≈ 18 MB raw audio

let zaiPromise: Promise<any> | null = null;
function getZAI() {
  if (!zaiPromise) {
    zaiPromise = import("z-ai-web-dev-sdk").then((m) => m.default.create());
  }
  return zaiPromise;
}

export async function POST(req: NextRequest) {
  let body: { audio?: unknown; mime?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const audio = typeof body.audio === "string" ? body.audio : "";
  const mime = typeof body.mime === "string" ? body.mime : "audio/webm";

  if (!audio) return NextResponse.json({ error: "audio (base64) is required" }, { status: 400 });
  if (audio.length > MAX_B64_CHARS) {
    return NextResponse.json({ error: "Recording too large (max ≈ 18 MB)" }, { status: 413 });
  }

  try {
    const zai = await getZAI();
    const res = (await Promise.race([
      zai.audio.asr.create({ file_base64: audio }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ASR timeout")), 30000)),
    ])) as { text?: string };

    const text = (res?.text ?? "").trim();
    if (!text) {
      return NextResponse.json({ error: "No speech detected — try again a little closer to the mic." }, { status: 422 });
    }
    return NextResponse.json({ ok: true, text, mime });
  } catch (err) {
    console.error("[asr] transcription failed:", err instanceof Error ? err.message : err);
    const msg = err instanceof Error && err.message === "ASR timeout"
      ? "Transcription timed out — please try a shorter recording."
      : "Transcription unavailable right now. You can type your answer instead.";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}
