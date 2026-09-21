import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { twilioMode, env, isProdVoiceMode, SUPPORTED_LANGS } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Live platform status — real numbers from this deployment. */
export async function GET() {
  const started = Date.now();
  let dbLatencyMs: number | null = null;
  let dbOk = true;

  try {
    await db.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - started;
  } catch {
    dbOk = false;
  }

  const mem = process.memoryUsage();

  const voiceProvider = env.elevenLabsApiKey
    ? env.elevenLabsDryRun
      ? "z-ai-dev (dry-run)"
      : "elevenlabs"
    : "z-ai-dev (no key configured)";

  return NextResponse.json(
    {
      ok: dbOk,
      service: "securevoice-api",
      version: "1.2.0",
      region: "me-central-1 · UAE",
      dbLatencyMs,
      voiceProvider,
      languages: [...SUPPORTED_LANGS],
      ingest: env.webhookSecret ? "armed" : "unconfigured (set WEBHOOK_SECRET)",
      telephony: twilioMode(),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      rssMb: Math.round(mem.rss / 1048576),
      ts: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
