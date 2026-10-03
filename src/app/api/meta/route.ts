import { NextResponse } from "next/server";

import "server-only";

export const dynamic = "force-dynamic";

/**
 * Public deployment metadata — the non-sensitive half of /api/status.
 *
 * /api/status carries heap usage, DB latency and provider modes, which is
 * fingerprinting material and is therefore operator-gated. The landing/docs
 * pages only need "which build, which region", so that is what is public here:
 * two non-sensitive strings, no telemetry, no dependency probe.
 */
export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      version: process.env.npm_package_version ?? "0.2.1",
      region: process.env.DEPLOY_REGION ?? "self-hosted",
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
