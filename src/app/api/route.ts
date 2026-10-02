import { NextResponse } from "next/server";

/** API root — a small index instead of a default "Hello, world!" placeholder. */
export async function GET() {
  return NextResponse.json(
    {
      service: "securevoice-api",
      ok: true,
      endpoints: ["/api/health", "/api/interventions", "/api/enroll", "/api/console/me"],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
