import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  hashIp,
  heartbeat,
  joinQueue,
  rateLimitHeaders,
  releaseSeat,
  seatState,
  validDeviceId,
} from "@/lib/demo-queue";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * GET /api/demo/queue — where am I in line?
 *
 * `?seatId=` returns the seat's live state (promoting opportunistically, so a
 * poller learns about its promotion from this read rather than needing a
 * second call). Without a seat id, returns the public depth figures — enough
 * to render "N ahead of you" copy honestly without leaking who they are.
 */
export async function GET(req: NextRequest) {
  const seatId = req.nextUrl.searchParams.get("seatId");
  if (!seatId) {
    return NextResponse.json({ error: "seatId is required" }, { status: 422, headers: noStore });
  }
  const state = await seatState(seatId.slice(0, 64));
  if (!state) {
    // Gone: released, expired, or never existed. The client rejoins rather
    // than retrying a dead seat id forever.
    return NextResponse.json({ status: "gone" }, { status: 404, headers: noStore });
  }
  return NextResponse.json(state, { headers: noStore });
}

const joinSchema = z.object({
  action: z.enum(["join", "heartbeat", "leave"]),
  deviceId: z.string().min(8).max(64),
  seatId: z.string().min(1).max(64).optional(),
});

/**
 * POST /api/demo/queue — join, heartbeat, or leave.
 *
 * Rate-limited per (IP, device) BEFORE any write: the join budget is the
 * anti-spam control, and capacity is enforced inside `joinQueue`, not here.
 * The device id is validated to a tight alphabet so it cannot smuggle
 * structure into keys, rows, or logs.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: noStore });
  }
  const parsed = joinSchema.safeParse(body);
  if (!parsed.success || !validDeviceId(parsed.data.deviceId)) {
    return NextResponse.json({ error: "deviceId is required" }, { status: 422, headers: noStore });
  }

  // The seat is keyed on the canonicalised, trust-gated address (see hashIp), not on
  // `rateLimitId` — that helper may return `cid:<x-caller-id>`, which is spoofable,
  // and a queue keyed on it can be multiplied by rotating one header value.
  const ipHash = hashIp(req.headers);
  const { action, deviceId, seatId } = parsed.data;

  if (action === "leave") {
    if (seatId) await releaseSeat(seatId);
    return NextResponse.json({ ok: true }, { headers: noStore });
  }

  if (action === "heartbeat") {
    if (!seatId) {
      return NextResponse.json({ error: "seatId is required" }, { status: 422, headers: noStore });
    }
    const alive = await heartbeat(seatId);
    if (!alive) {
      return NextResponse.json({ status: "gone" }, { status: 404, headers: noStore });
    }
    return NextResponse.json({ status: "active" }, { headers: noStore });
  }

  // join
  const joined = await joinQueue(ipHash, deviceId, `${ipHash}:${deviceId}`);
  if (!joined.ok) {
    return NextResponse.json(
      { status: "rate_limited", retryAfterMs: joined.retryAfterMs },
      {
        status: 429,
        headers: {
          ...noStore,
          ...rateLimitHeaders({
            ok: false,
            limit: joined.limit,
            retryAfterMs: joined.retryAfterMs,
            remaining: 0,
            resetMs: joined.retryAfterMs,
          }),
        },
      },
    );
  }
  return NextResponse.json(joined.state, { headers: noStore });
}
