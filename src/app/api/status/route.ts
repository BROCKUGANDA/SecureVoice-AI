import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { twilioMode } from "@/lib/twilio";

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

  // Voice provider mode — operators need to know at a glance whether the
  // deployment is burning real ElevenLabs quota or serving the dev backend.
  const voiceProvider = process.env.ELEVENLABS_API_KEY
    ? process.env.ELEVENLABS_DRY_RUN === "true"
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
      languages: ["en", "ar", "hi", "ur"],
      ingest: process.env.WEBHOOK_SECRET ? "armed" : "unconfigured (set WEBHOOK_SECRET)",
      telephony: twilioMode(),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      rssMb: Math.round(mem.rss / 1048576),
      ts: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
