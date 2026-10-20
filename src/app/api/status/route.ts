import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { twilioMode, env, SUPPORTED_LANGS, voiceProviderLabel } from "@/lib/config";
import { UI_LANGS } from "@/lib/i18n/registry";
import { deployedVersion } from "@/lib/release-version";
import { APP_VERSION } from "@/lib/version";
import { requireOperator } from "@/lib/credits";
import { admissionSnapshot } from "@/lib/admission";
import { pilotStatus } from "@/lib/pilot/mode";

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

  // Names the rung that will answer, not the credential that exists — see
  // `voiceProviderLabel`. A key with no commercial-use attestation streams the
  // emergency cue, and saying "elevenlabs" about that is the overclaim.
  const voiceProvider = voiceProviderLabel();

  return NextResponse.json(
    {
      ok: dbOk,
      service: "securevoice-api",
      // Env-derived, not hardcoded: a status endpoint that reports a fixed
      // version and region is worse than none, because it looks current.
      //
      // `deployedVersion()` resolves the promoted release tag first and the
      // build-time package.json version second. It deliberately does NOT read
      // `npm_package_version`: that is set by NPM, this app runs under bun, so in
      // production it was always undefined and this field fell through to the
      // hardcoded literal below — the status page reported one frozen version
      // across every release.
      version: deployedVersion(APP_VERSION),
      region: process.env.DEPLOY_REGION ?? "self-hosted",
      // Environment posture, so a deployment's blast radius is visible
      // from outside instead of being implicit in the branch name.
      appEnv: env.appEnv,
      canContactRealNumbers: env.canContactRealNumbers,
      dbLatencyMs,
      voiceProvider,
      // Two fields, because the two sets answer different questions and a single
      // `languages` key read as "the product speaks six and shows six". The
      // interface is English and Arabic; a call and an SMS are delivered in six.
      interfaceLanguages: [...UI_LANGS],
      deliveryLanguages: [...SUPPORTED_LANGS],
      ingest: env.webhookSecret ? "armed" : "unconfigured (set WEBHOOK_SECRET)",
      webhookIngest: {
        configured: Boolean(process.env.ELEVENLABS_WEBHOOK_SECRET),
        lastWebhookAt,
        fresh24h: webhookFresh,
        pending: pendingWebhooks,
      },
      telephony: twilioMode(),
      capacity: await admissionSnapshot(),
      // The pilot's operating mode, its ceilings and its kill switch.
      //
      // On this surface — which is operator-gated — rather than only on the
      // public probe, because these are the numbers a bank asks for during a
      // pilot review: the mode the deployment is in, the contracted daily
      // volume against the volume used, and whether dialling is stopped.
      //
      // `pilotStatus` never throws and never fabricates a count: a ceiling it
      // could not read is null, which reads as "unknown" rather than as "there
      // is room".
      pilot: await pilotStatus(guard.profile.orgId),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      rssMb: Math.round(mem.rss / 1048576),
      ts: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
