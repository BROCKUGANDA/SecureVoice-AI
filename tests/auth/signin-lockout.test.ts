/**
 * Failed-credential lockout on the live sign-in path.
 *
 * Better Auth's own limiter is a throughput ceiling (30/min), and `sentinel()`
 * is a connection to a hosted service that this deployment does not configure —
 * so before this wiring, nothing in the product stopped a password list against
 * a bank's admin console, however the docs read. These checks drive the real
 * route handler with a real ladder and a stubbed credential response, because a
 * guard that is only proven at the library seam is the failure class
 * `docs/GAP-REGISTER.md` was written to name.
 *
 *   bun test tests/auth/signin-lockout.test.ts
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { _resetBadActors } from "@/lib/abuse/bad-actor";

const LIMIT = 5;
process.env.AUTH_FAILED_LOGIN_MAX = String(LIMIT);

/** What the stubbed Better Auth answers on the next credential POST. */
let upstreamStatus = 401;
let botCheckPasses = true;

mock.module("@/lib/better-auth", () => ({ auth: {} }));
mock.module("better-auth/next-js", () => ({
  toNextJsHandler: () => ({
    GET: async () => new Response("{}", { status: 200 }),
    POST: async () =>
      new Response(JSON.stringify({ error: { message: "Invalid credentials" } }), {
        status: upstreamStatus,
        headers: { "content-type": "application/json" },
      }),
  }),
}));
mock.module("@/lib/compliance/turnstile", () => ({
  TURNSTILE_TOKEN_FIELD: "cf-turnstile-response",
  turnstileRequired: (pathname: string) => (pathname.endsWith("/sign-in/email") ? "sign-in" : null),
  verifyTurnstile: async () =>
    botCheckPasses ? { ok: true } : { ok: false, reason: "missing-token" },
}));

const { POST, GET } = (await import("@/app/api/auth/[...all]/route")) as unknown as {
  POST: (req: NextRequest) => Promise<Response>;
  GET: (req: NextRequest) => Promise<Response>;
};

const signIn = (ip: string) =>
  new NextRequest(
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "admin@bank.ae", password: "hunter2" }),
      // Proxied traffic: without the marker every source resolves "untrusted"
      // and shares one bucket, which turns per-source isolation assertions
      // into order-dependent failures. Production always carries it (Caddy).
      headers: {
        "content-type": "application/json",
        "x-securevoice-proxy": "1",
        "x-securevoice-client-ip": ip,
      },
    }),
  );

beforeEach(() => {
  _resetBadActors();
  upstreamStatus = 401;
  botCheckPasses = true;
});

test("the first five rejections pass through as rejections, not as lockouts", async () => {
  for (let i = 0; i < LIMIT; i++) {
    const res = await POST(signIn("203.0.113.10"));
    expect(res.status, `attempt ${i + 1}`).toBe(401);
  }
});

test("the sixth attempt from the same source is refused before the credentials are read", async () => {
  for (let i = 0; i < LIMIT; i++) await POST(signIn("203.0.113.11"));
  const res = await POST(signIn("203.0.113.11"));
  expect(res.status).toBe(429);
  expect((await res.json()).error).toBe("too_many_failed_signins");
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(Number.isFinite(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("a different source is not punished for another's attack", async () => {
  for (let i = 0; i < LIMIT; i++) await POST(signIn("203.0.113.12"));
  const innocent = await POST(signIn("198.51.100.7"));
  expect(innocent.status).toBe(401);
});

// The NAT case: five colleagues each mistype once inside an hour and the whole
// office is locked out. A verified credential has to reset the count.
test("a verified sign-in forgives the source's earlier typos", async () => {
  for (let i = 0; i < LIMIT - 1; i++) await POST(signIn("203.0.113.13"));
  upstreamStatus = 200;
  const ok = await POST(signIn("203.0.113.13"));
  expect(ok.status).toBe(200);

  upstreamStatus = 401;
  for (let i = 0; i < LIMIT - 1; i++) {
    const res = await POST(signIn("203.0.113.13"));
    expect(res.status, `post-forgiveness attempt ${i + 1}`).toBe(401);
  }
});

test("a failed bot check is not charged to the credential budget", async () => {
  botCheckPasses = false;
  for (let i = 0; i < 3; i++) {
    const res = await POST(signIn("203.0.113.14"));
    expect(res.status).toBe(403);
  }
  botCheckPasses = true;
  // A CAPTCHA misbehaving must not be what locks the office out.
  for (let i = 0; i < LIMIT; i++) {
    const res = await POST(signIn("203.0.113.14"));
    expect(res.status, `credential attempt ${i + 1}`).toBe(401);
  }
});

test("session reads on the same path are untouched", async () => {
  for (let i = 0; i < 10; i++) await POST(signIn("203.0.113.15"));
  // The lockout is on credential submissions. A GET on the same catch-all is a
  // cookie/session read; wrapping it would break Better Auth's own endpoints and
  // log real users out at the moment they are already locked out of signing in.
  const get = await GET(new NextRequest(new Request("http://localhost:3000/api/auth/get-session")));
  expect(get.status).toBe(200);
});
