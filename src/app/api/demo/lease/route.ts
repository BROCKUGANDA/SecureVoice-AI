import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/better-auth";
import { leaseForSession } from "@/lib/demo-queue";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * GET /api/demo/lease — does this signed-in demo session hold a live seat?
 *
 * Powers the Demo view's heartbeat loop and its "seat lost" screen. Answers only
 * for the caller's OWN session: the seat is looked up by the session id the
 * session was minted with, never by anything client-supplied and never by the user
 * id — every admitted browser shares that one, so a user-keyed lookup would report
 * the first judge's seat to the second judge and tell them they are fine.
 */
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ held: false }, { status: 401, headers: noStore });
  }
  try {
    const lease = await leaseForSession(session.session.id);
    if (!lease) return NextResponse.json({ held: false }, { headers: noStore });
    return NextResponse.json({ held: true, seatId: lease.id }, { headers: noStore });
  } catch {
    // Degraded, not dead: the view keeps its last known state and retries
    // rather than signing the operator out over a telemetry read.
    return NextResponse.json({ held: false, degraded: true }, { headers: noStore });
  }
}
