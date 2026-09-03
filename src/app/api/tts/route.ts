import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";

export const dynamic = "force-dynamic";

/** Neural TTS proxy — server-side only (API keys never reach the browser).
 *  Returns WAV audio (24 kHz). Results are cached in-memory per text+voice+speed. */

const VOICES = new Set(["tongtong", "chuichui", "xiaochen", "jam", "kazi", "douji", "luodo"]);
const MAX_CHARS = 1024;

type CacheEntry = { buf: Buffer; at: number };
const CACHE = new Map<string, CacheEntry>();
const CACHE_MAX = 48;

let zaiPromise: Promise<any> | null = null;
function getZAI() {
  if (!zaiPromise) {
    zaiPromise = import("z-ai-web-dev-sdk").then((m) => m.default.create());
  }
  return zaiPromise;
}

function cacheKey(text: string, voice: string, speed: number) {
  return createHash("sha1").update(`${voice}·${speed}·${text}`).digest("hex");
}

export async function POST(req: NextRequest) {
  let body: { text?: unknown; voice?: unknown; speed?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });
  if (text.length > MAX_CHARS) {
    return NextResponse.json({ error: `text exceeds ${MAX_CHARS} characters` }, { status: 413 });
  }

  const voice = typeof body.voice === "string" && VOICES.has(body.voice) ? body.voice : "tongtong";
  let speed = typeof body.speed === "number" ? body.speed : 1.0;
  if (!Number.isFinite(speed)) speed = 1.0;
  speed = Math.min(2.0, Math.max(0.5, speed));

  const key = cacheKey(text, voice, speed);
  const hit = CACHE.get(key);
  if (hit) {
    hit.at = Date.now();
    return audioResponse(hit.buf);
  }

  try {
    const zai = await getZAI();
    const res = (await Promise.race([
      zai.audio.tts.create({
        input: text,
        voice,
        speed,
        response_format: "wav",
        stream: false,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("TTS timeout")), 25000)),
    ])) as Response;

    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(new Uint8Array(arrayBuffer));
    if (buf.length < 512) throw new Error("TTS returned empty audio");

    // simple LRU eviction
    if (CACHE.size >= CACHE_MAX) {
      let oldestKey = "";
      let oldest = Infinity;
      for (const [k, v] of CACHE) {
        if (v.at < oldest) {
          oldest = v.at;
          oldestKey = k;
        }
      }
      if (oldestKey) CACHE.delete(oldestKey);
    }
    CACHE.set(key, { buf, at: Date.now() });

    return audioResponse(buf);
  } catch (err) {
    console.error("[tts] generation failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Speech generation unavailable" }, { status: 503 });
  }
}

function audioResponse(buf: Buffer) {
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(buf.length),
      "Cache-Control": "private, max-age=86400",
    },
  });
}
