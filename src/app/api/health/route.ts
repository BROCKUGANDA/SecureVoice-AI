import { NextResponse } from "next/server";
import { deployedVersion } from "@/lib/version";

export const dynamic = "force-dynamic";

/**
 * Liveness probe — 200 OK while the process is up. Deliberately cheap (no DB),
 * for uptime monitors; /api/status carries the deep diagnostics.
 *
 * It reports the release too, and that is load-bearing for a blue/green deploy:
 * `docker-compose.bluegreen.yml` sets `SECUREVOICE_RELEASE` to the promoted image
 * tag, so a rollback can prove WHICH build is answering instead of trusting the
 * tag written in a compose file. The field costs one env read and no dependency,
 * so it stays a pure liveness probe.
 */
export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      version: deployedVersion(),
      release: process.env.SECUREVOICE_RELEASE ?? null,
      // Public-safe region label. This is the one field the public Security page
      // needs that the operator-only /api/status also carries; the rest of that
      // payload (heap, rss, DB latency, provider posture) stays behind the
      // operator guard, because it is fingerprinting data and the DB ping is a
      // free query amplifier.
      region: process.env.DEPLOY_REGION ?? null,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
