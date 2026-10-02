import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { twilioMode, env, SUPPORTED_LANGS } from "@/lib/config";
import { requireOperator } from "@/lib/credits";

export const dynamic = "force-dynamic";

/** Live platform status — real numbers from this deployment.
 *  Operator-only: heap/rss/latency/provider details are fingerprinting data
 *  (and the DB ping would otherwise be a free query amplifier). The public
 *  probe is /api/health. */
export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
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
      version: process.env.npm_package_version ?? "0.2.1",
      region: process.env.DEPLOY_REGION ?? "self-hosted",
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
