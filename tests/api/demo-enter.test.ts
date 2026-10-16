/**
 * POST /api/demo/enter — queue claim plus sign-in relay.
 *
 * The relay hands the credential check to Better Auth untouched and relays
 * status, body and cookies verbatim; this suite proves the WIRING (gate order,
 * refusal shapes, cookie relay, lease binding) with a stubbed upstream, plus
 * the real queue underneath. It deliberately does NOT prove Better Auth
 * accepts the demo password — that is verified live post-deploy, because only
 * the deployment holds the seeded credential.
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { hashIp } from "@/lib/demo-queue";
import { joinQueue } from "@/lib/demo-queue";

const RUN = `e-${Date.now().toString(36)}`;
process.env.AUTH_SECRET ||= "test-only-demo-enter-hmac-secret-not-a-credential";
process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL = "demo-enter@example.test";
process.env.NEXT_PUBLIC_DEMO_LOGIN_PASSWORD = "test-only-demo-password-not-a-credential";
process.env.DEMO_SEAT_CAPACITY = "10";
process.env.DEMO_JOIN_PER_HOUR = "1000";

let octet = 200;
const addrFor = () => `203.0.113.${octet++}`;
const hdrsFor = (addr: string) => {
  const h = new Headers();
  h.set("x-securevoice-proxy", "1");
  h.set("x-securevoice-client-ip", addr);
  return h;
};

const DEV = `${RUN}-dev-enter-01`.slice(0, 32);

mock.module("@/lib/better-auth", () => ({
  auth: {
    api: {
      signInEmail: async () =>
        new Response(JSON.stringify({ user: { id: "user-enter-1" } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "better-auth.session_token=stub-session; Path=/; HttpOnly",
          },
        }),
    },
  },
}));

beforeEach(async () => {
  await db.demoSeat.updateMany({
    where: { status: { in: ["active", "queued"] } },
    data: { status: "released" },
  });
});

afterAll(async () => {
  await db.demoSeat.deleteMany({ where: { deviceId: { startsWith: RUN } } }).catch(() => undefined);
  delete process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL;
  delete process.env.NEXT_PUBLIC_DEMO_LOGIN_PASSWORD;
});

async function post(deviceId: string, headers?: Headers) {
  const { POST } = await import("@/app/api/demo/enter/route");
  const h = new Headers(headers);
  h.set("content-type", "application/json");
  return POST(
    new NextRequest("http://localhost/api/demo/enter", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ deviceId }),
    }),
  );
}

test("enter without a seat is refused with 409, never signed in", async () => {
  const res = await post(DEV, hdrsFor(addrFor()));
  expect(res.status).toBe(409);
  const body = (await res.json()) as { status?: string };
  expect(body.status).toBe("no_seat");
});

test("enter with a malformed device id is 422", async () => {
  const res = await post("x", hdrsFor(addrFor()));
  expect(res.status).toBe(422);
});

test("enter with an active seat relays the session and binds the lease", async () => {
  const addr = addrFor();
  const ipHash = hashIp(hdrsFor(addr));
  const joined = await joinQueue(ipHash, DEV, `${ipHash}:${DEV}`);
  expect(joined.ok).toBe(true);
  if (!joined.ok || joined.state.status !== "active") throw new Error("unreachable");

  const res = await post(DEV, hdrsFor(addr));
  expect(res.status).toBe(200);
  // Cookies relayed verbatim: without Set-Cookie there is no session, and a
  // relay that drops them is a sign-in that silently did nothing.
  const cookies = res.headers.getSetCookie();
  expect(cookies.some((c) => c.startsWith("better-auth.session_token=stub-session"))).toBe(true);
  const body = (await res.json()) as { user?: { id?: string } };
  expect(body.user?.id).toBe("user-enter-1");

  // The lease is bound to the freshly signed-in user: getProfile's check will
  // find it.
  const lease = await db.demoSeat.findFirst({
    where: { id: joined.state.seatId },
    select: { userId: true },
  });
  expect(lease?.userId).toBe("user-enter-1");
});
