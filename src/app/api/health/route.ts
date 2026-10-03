import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness probe — 200 OK while the process is up. Deliberately cheap (no DB),
 *  for uptime monitors; /api/status carries the deep diagnostics. */
export async function GET() {
  return NextResponse.json(
    { ok: true, uptimeSec: Math.round(process.uptime()) },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
