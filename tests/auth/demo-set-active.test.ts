/**
 * The demo account cannot switch its active organization.
 *
 * `getProfile()` confines a demo session to the demo role — but the
 * organization plugin's `set-active` endpoint is the one door that rewrites
 * `session.activeOrganizationId`, and several server paths read that column
 * DIRECTLY (recordings, user-authz, llm budget, tts-quota). A demo visitor who
 * switched to another org's membership would hand those paths a tenant id the
 * demo role was supposed to make unreachable. The guard in
 * `src/app/api/auth/[...all]/route.ts` refuses the switch; this suite pins the
 * refusal and, as a control, lets a real account through to Better Auth.
 */
import { describe, expect, mock, test } from "bun:test";

type SessionShape = { user: { id: string; email: string }; session: Record<string, unknown> };

const DEMO = "demo@example.test";
const OPERATOR = "operator@example.test";
let current: SessionShape | null = null;

// isDemoAccount() reads the configured demo addresses on every call; the
// predicate is the same one the sign-in page's one-click button keys off, so
// the exemption is configured exactly where the credential is.
process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL = DEMO;

// The route module calls `toNextJsHandler(auth)` at import time and
// `auth.api.getSession(...)` inside the guard, so the mock has to supply both
// shapes. The upstream handler stands in for Better Auth itself: if the guard
// lets a request through, this is what answers.
let upstreamCalled = false;
mock.module("@/lib/better-auth", () => ({
  auth: {
    api: {
      getSession: async () => current,
    },
    handler: async () => {
      upstreamCalled = true;
      return new Response("{}", { status: 200 });
    },
  },
}));

describe("POST /api/auth/organization/set-active", () => {
  test("a demo account is refused with 403 and Better Auth is never reached", async () => {
    current = { user: { id: "u-demo", email: DEMO }, session: {} };
    upstreamCalled = false;
    const { POST } = await import("@/app/api/auth/[...all]/route");
    const res = await POST(
      new Request("http://localhost/api/auth/organization/set-active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-other" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/demo/i);
    expect(upstreamCalled).toBe(false);
  });

  test("a real account reaches Better Auth untouched (control)", async () => {
    current = { user: { id: "u-op", email: OPERATOR }, session: {} };
    upstreamCalled = false;
    const { POST } = await import("@/app/api/auth/[...all]/route");
    const res = await POST(
      new Request("http://localhost/api/auth/organization/set-active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-real" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(upstreamCalled).toBe(true);
  });

  test("a signed-out caller is not demo-gated either way", async () => {
    current = null;
    upstreamCalled = false;
    const { POST } = await import("@/app/api/auth/[...all]/route");
    const res = await POST(
      new Request("http://localhost/api/auth/organization/set-active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-any" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(upstreamCalled).toBe(true);
  });
});
