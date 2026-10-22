import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { recordHoneypotHit } from "@/lib/abuse/honeypot";

export const dynamic = "force-dynamic";

/**
 * The canary endpoint.
 *
 * It looks like a leaked configuration route. Nothing on this platform serves
 * keys from a URL, so any request here is a probe — a scraper that found the
 * path in a repository, a rogue employee looking for a backdoor, or an
 * automated scanner. The caller is blocked for 24h (shared Redis when
 * configured, local memory otherwise), the hit is appended to the audit chain,
 * and the response is indistinguishable from a database failure.
 *
 * The response body must never contain a real secret or a hint that this is a
 * trap. A 403 would tell the attacker they found something; a fake 500 keeps
 * them guessing.
 */

function sourceIp(req: NextRequest): string {
  const proxied = req.headers.get("x-securevoice-client-ip");
  if (proxied) return proxied;
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "untrusted";
}

async function trap(req: NextRequest): Promise<NextResponse> {
  await recordHoneypotHit(
    sourceIp(req),
    `${req.method} ${req.nextUrl.pathname} ua=${req.headers.get("user-agent") ?? "unknown"}`,
  );
  return NextResponse.json({ error: "Database connection failed" }, { status: 500 });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return trap(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return trap(req);
}
