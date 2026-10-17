import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/better-auth";
import { claimSeat, demoCapacity, hashIp, validDeviceId } from "@/lib/demo-queue";
import { consume as consumeRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { isRealIp, resolveClientIp } from "@/lib/ip-normalize";
import { TURNSTILE_TOKEN_FIELD, verifyTurnstile } from "@/lib/compliance/turnstile";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

const enterSchema = z.object({
  deviceId: z.string().min(8).max(64),
});

/**
 * POST /api/demo/enter — claim a queue seat and sign the demo user in.
 *
 * This is the ONLY path that mints a demo session with a lease. The client
 * never handles the demo password here: the server reads it from the same
 * variables the sign-in page uses and signs in on the caller's behalf, AFTER
 * the queue admits them. The password stays public (it is still in the client
 * bundle for the manual form), but a manual-form sign-in mints a session with
 * no lease — and `getProfile()` requires a live lease for demo emails, so
 * that session resolves to signed-out until the holder joins the line.
 *
 * Order: rate limit → seat check → Turnstile → sign-in → bind. The sign-in
 * goes through `auth.api.signInEmail` with `asResponse`, and the upstream
 * response (status, body, cookies) is relayed verbatim — this endpoint adds
 * the queue gate and nothing else, so its behaviour on bad credentials is
 * exactly Better Auth's.
 */
export async function POST(req: NextRequest) {
  const demoEmail = process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL?.trim();
  const demoPassword = process.env.NEXT_PUBLIC_DEMO_LOGIN_PASSWORD ?? "";
  if (!demoEmail || !demoPassword) {
    return NextResponse.json(
      { error: "Demo sign-in is not configured on this deployment." },
      { status: 503, headers: noStore },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: noStore });
  }
  const parsed = enterSchema.safeParse(body);
  if (!parsed.success || !validDeviceId(parsed.data.deviceId)) {
    return NextResponse.json({ error: "deviceId is required" }, { status: 422, headers: noStore });
  }
  const { deviceId } = parsed.data;

  // Keyed from the HEADERS, through the trust gate — NOT from `rateLimitId`. That
  // helper may return `cid:<x-caller-id>`, which is spoofable, and hashing it would
  // let anyone mint an unlimited number of demo seats by rotating one header value.
  const ipHash = hashIp(req.headers);

  // Enter attempts are budgeted separately from joins and lower: a join is
  // cheap polling, an enter mints a session.
  const rl = await consumeRateLimit("demo-enter", `${ipHash}:${deviceId}`, 1, 10);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many sign-in attempts — retry shortly.", status: "rate_limited" },
      { status: 429, headers: { ...noStore, ...rateLimitHeaders(rl) } },
    );
  }

  // The seat must already be active for this pair: enter claims, it never
  // queues. The body of the 409 tells the client exactly that.
  const { db } = await import("@/lib/db");
  const live = await db.demoSeat.findFirst({
    where: { ipHash, deviceId, status: "active" },
    select: { id: true, lastSeenAt: true },
  });
  const ttlMs =
    Number(process.env.DEMO_LEASE_TTL_SEC) > 0
      ? Number(process.env.DEMO_LEASE_TTL_SEC) * 1000
      : 180_000;
  if (!live || live.lastSeenAt.getTime() < Date.now() - ttlMs) {
    return NextResponse.json(
      {
        error: "No active demo seat for this device — join the queue first.",
        status: "no_seat",
        capacity: demoCapacity(),
      },
      { status: 409, headers: noStore },
    );
  }

  // Same bot gate as the direct sign-in path (the catch-all verifies
  // `cf-turnstile-response` for /api/auth/sign-in/email; this relay bypasses
  // that wrapper, so it verifies here instead with identical semantics).
  //
  // The `remoteip` is the RESOLVED address, and only when there is one. Previously
  // this sliced `identity` back out of an `ip:` prefix, which meant a caller that
  // reached the origin without the proxy sent Turnstile the literal string
  // `untrusted` as its remote IP — a value that matches nothing in Turnstile's
  // logs and makes a real visitor's challenge unfalsifiable.
  const resolved = resolveClientIp(req.headers);
  const turnstile = await verifyTurnstile(
    req.headers.get(TURNSTILE_TOKEN_FIELD),
    "login",
    isRealIp(resolved) ? resolved : undefined,
  );
  if (!turnstile.ok) {
    return NextResponse.json(
      { error: "Bot verification failed — retry the sign-in." },
      { status: 403, headers: noStore },
    );
  }

  // Relay the credential check to Better Auth and hand back exactly what it
  // returned: status, body, and every Set-Cookie. Nothing is reinterpreted —
  // a wrong password here answers exactly as a wrong password there.
  let upstream: Response;
  try {
    const forward = new Headers();
    req.headers.forEach((value, key) => {
      if (key.toLowerCase() === "host" || key.toLowerCase() === "content-length") return;
      forward.set(key, value);
    });
    upstream = (await auth.api.signInEmail({
      body: { email: demoEmail, password: demoPassword },
      headers: forward,
      asResponse: true,
    })) as unknown as Response;
  } catch (err) {
    logError("[demo] sign-in relay failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Sign-in is temporarily unavailable." },
      { status: 503, headers: noStore },
    );
  }

  const text = await upstream.text().catch(() => "");
  let userId: string | null = null;
  let sessionId: string | null = null;
  try {
    const parsedBody = JSON.parse(text) as {
      user?: { id?: unknown };
      session?: { id?: unknown };
    };
    if (typeof parsedBody?.user?.id === "string") userId = parsedBody.user.id;
    if (typeof parsedBody?.session?.id === "string") sessionId = parsedBody.session.id;
  } catch {
    // Non-JSON (should not happen): no binding, the lease stays with the pair
    // and getProfile will refuse the session until it is bound.
  }
  if (upstream.ok && userId) {
    // The seat is bound to the SESSION, not to the user. The demo credential is
    // one published account, so a user-keyed lease admits every browser once any
    // one of them is in — which is exactly the capacity bound this queue exists
    // to hold. Without a session id in the response we cannot bind, and refusing
    // here is the fail-closed direction: an unbound seat means getProfile refuses
    // the session and the holder rejoins the line.
    if (!sessionId) {
      logError("[demo] sign-in returned no session id; seat not bound", { deviceId });
    }
    const bound = sessionId ? await claimSeat(ipHash, deviceId, userId, sessionId) : null;
    if (!bound) {
      // The seat lapsed between the check and the sign-in (milliseconds), or the
      // session id was absent. The session exists but has no lease, so getProfile
      // resolves it to signed-out and the holder rejoins — fail closed,
      // self-healing.
      logError("[demo] seat lapsed during sign-in; session minted without a lease", { deviceId });
    }
  }

  const out = new NextResponse(text, {
    status: upstream.status,
    headers: {
      ...noStore,
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
  for (const cookie of upstream.headers.getSetCookie()) out.headers.append("set-cookie", cookie);
  return out;
}
