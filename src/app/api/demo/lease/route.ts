import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/better-auth";
import { leaseForUser } from "@/lib/demo-queue";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * GET /api/demo/lease — does this signed-in demo session hold a live seat?
 *
 * Powers the Demo view's heartbeat loop and its "seat lost" screen. Answers
 * only for the caller's own session: the lease is looked up by the session's
 * user id, never by a client-supplied one — a caller cannot ask about anyone
 * else's seat.
 */
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ held: false }, { status: 401, headers: noStore });
  }
  try {
    const lease = await leaseForUser(session.user.id);
    if (!lease) return NextResponse.json({ held: false }, { headers: noStore });
    return NextResponse.json({ held: true, seatId: lease.id }, { headers: noStore });
  } catch {
    // Degraded, not dead: the view keeps its last known state and retries
    // rather than signing the operator out over a telemetry read.
    return NextResponse.json({ held: false, degraded: true }, { headers: noStore });
  }
}
