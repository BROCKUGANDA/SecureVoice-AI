import { NextResponse } from "next/server";

import "server-only";

import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

/**
 * Public deployment metadata — the non-sensitive half of /api/status.
 *
 * /api/status carries heap usage, DB latency and provider modes, which is
 * fingerprinting material and is therefore operator-gated. The landing/docs
 * pages only need "which build, which region", so that is what is public here:
 * two non-sensitive strings, no telemetry, no dependency probe.
 *
 * The version is read from package.json rather than process.env.npm_package_version.
 * That variable is set by npm/yarn while a *lifecycle script* runs, and the app
 * is started with `bun .next/standalone/server.js` — no package manager is
 * involved, so it is undefined in production and the old code silently fell back
 * to a hardcoded literal. That fallback matched package.json by coincidence and
 * would have gone stale at the next version:bump while still looking correct.
 */
export async function GET() {
  return NextResponse.json(
    {
      version: pkg.version,
      region: process.env.DEPLOY_REGION ?? "self-hosted",
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
