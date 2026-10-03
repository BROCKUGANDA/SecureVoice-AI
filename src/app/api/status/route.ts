import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { twilioMode, env, SUPPORTED_LANGS } from "@/lib/config";
import { requireOperator } from "@/lib/credits";
import { admissionSnapshot } from "@/lib/admission";

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

  // Post-call evidence pipeline freshness (WP-4). A delivery that has not
  // arrived in 24h means the evidence pipeline is silently dead — the same
  // failure mode as hazard H8 (webhook auto-disabled after repeated failures).
  let lastWebhookAt: string | null = null;
  let pendingWebhooks = 0;
  if (dbOk) {
    try {
      const last = await db.webhookEvent.findFirst({
        orderBy: { receivedAt: "desc" },
        select: { receivedAt: true },
      });
      lastWebhookAt = last?.receivedAt.toISOString() ?? null;
      pendingWebhooks = await db.webhookEvent.count({ where: { processed: false } });
    } catch {
      // leave nulls; the freshness check below reports "unknown"
    }
  }
  const webhookFresh =
    lastWebhookAt !== null && Date.now() - Date.parse(lastWebhookAt) < 24 * 3600 * 1000;

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
      webhookIngest: {
        configured: Boolean(process.env.ELEVENLABS_WEBHOOK_SECRET),
        lastWebhookAt,
        fresh24h: webhookFresh,
        pending: pendingWebhooks,
      },
      telephony: twilioMode(),
      capacity: await admissionSnapshot(),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      rssMb: Math.round(mem.rss / 1048576),
      ts: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
