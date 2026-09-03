import { NextResponse } from "next/server";
import { db } from "@/lib/db";

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

  return NextResponse.json(
    {
      ok: dbOk,
      service: "securevoice-api",
      version: "1.0.4",
      region: "me-central-1 · UAE",
      dbLatencyMs,
      uptimeSec: Math.round(process.uptime()),
      ts: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
