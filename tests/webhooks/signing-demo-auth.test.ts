/**
 * REGRESSION — `/api/webhooks` must not be an anonymous signing oracle.
 *
 * This route mints a valid HMAC signature AND returns the secret that minted it.
 * It used to do both with no authentication, and the secret it returned was
 * `HMAC-SHA256(WEBHOOK_SECRET, "sv-webhook-demo")` — i.e. derived from the LIVE
 * inbound ingest secret that `api/interventions` and `api/v1/interventions`
 * verify producer signatures against.
 *
 * The combination mattered more than either half:
 *
 *   · anonymous      ⇒ anyone could call it at all;
 *   · derived        ⇒ the response published production-derived key material;
 *   · `action:"verify"` ⇒ a remote oracle that tells an attacker whether a
 *     guess of the ingest secret is correct, turning an unbrute-forceable secret
 *     into a remotely testable one.
 *
 * Both halves are now gone independently, and both are pinned here, because
 * fixing either alone leaves the finding intact.
 */
import { describe, expect, test, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import * as realCredits from "@/lib/credits";

const ROUTE_SRC = fileURLToPath(new URL("../../src/app/api/webhooks/route.ts", import.meta.url));

const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000042";

/** Mutable so each test decides whether the caller has a session. */
const session = { signedIn: true };

// The identity seam this repo stubs in every other route. `requireSignedIn`
// reads `getProfile`, so null here is exactly "signed out".
mock.module("@/lib/credits", () => ({
  ...realCredits,
  getProfile: async () =>
    session.signedIn
      ? {
          userId: USER_ID,
          email: "operator@example.test",
          name: "Ada Lovelace",
          role: "operator" as const,
          orgId: ORG,
          credits: 500,
        }
      : null,
}));

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/webhooks — authentication", () => {
  test("an unauthenticated caller is refused, and gets no secret", async () => {
    session.signedIn = false;
    const savedSecret = process.env.WEBHOOK_SECRET;
    const savedDemo = process.env.WEBHOOK_DEMO_SECRET;
    process.env.WEBHOOK_SECRET = "whsec_live_ingest_secret_value_for_test";
    delete process.env.WEBHOOK_DEMO_SECRET;
    try {
      const { POST } = await import("@/app/api/webhooks/route");
      const res = await POST(post({ action: "sign", event: "case.closed" }));

      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.secret).toBeUndefined();
      // The refusal must not leak the secret through any other field either.
      expect(JSON.stringify(body)).not.toContain("whsec_");
    } finally {
      if (savedSecret === undefined) delete process.env.WEBHOOK_SECRET;
      else process.env.WEBHOOK_SECRET = savedSecret;
      if (savedDemo !== undefined) process.env.WEBHOOK_DEMO_SECRET = savedDemo;
      session.signedIn = true;
    }
  });

  test("the verify branch is refused too — an oracle needs no session", async () => {
    session.signedIn = false;
    try {
      const { POST } = await import("@/app/api/webhooks/route");
      const res = await POST(
        post({ action: "verify", payload: '{"a":1}', header: "t=1,v1=" + "0".repeat(64) }),
      );
      expect(res.status).toBe(401);
    } finally {
      session.signedIn = true;
    }
  });

  test("an authenticated caller still gets a working demo", async () => {
    // The endpoint has a product purpose (teaching the signing scheme), so the
    // fix must not be "break it". This is the flip side of the tests above.
    session.signedIn = true;
    const savedDemo = process.env.WEBHOOK_DEMO_SECRET;
    process.env.WEBHOOK_DEMO_SECRET = "whsec_demo_fixed_for_test";
    try {
      const { POST } = await import("@/app/api/webhooks/route");
      const signed = await POST(post({ action: "sign", event: "case.closed" }));
      expect(signed.status).toBe(200);

      const body = (await signed.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(typeof body.secret).toBe("string");
      expect(typeof body.header).toBe("string");

      // And the signature it minted verifies against the secret it returned —
      // otherwise the demo teaches a scheme that does not work.
      const verified = await POST(
        post({ action: "verify", payload: body.payload, header: body.header }),
      );
      const verdict = (await verified.json()) as Record<string, unknown>;
      expect(verdict.valid).toBe(true);
    } finally {
      if (savedDemo === undefined) delete process.env.WEBHOOK_DEMO_SECRET;
      else process.env.WEBHOOK_DEMO_SECRET = savedDemo;
    }
  });
});

describe("POST /api/webhooks — the demo secret is not the production secret", () => {
  /**
   * Source-level, because the runtime value is random per boot and cannot be
   * asserted directly. This is the assertion that actually holds the finding
   * closed: if anyone re-derives the demo secret from WEBHOOK_SECRET, this goes
   * red regardless of what the auth gate does.
   */
  test("the route never reads WEBHOOK_SECRET", () => {
    const src = readFileSync(ROUTE_SRC, "utf8");
    expect(src).not.toContain("process.env.WEBHOOK_SECRET");
  });

  test("the route uses a dedicated, overridable demo secret", () => {
    const src = readFileSync(ROUTE_SRC, "utf8");
    expect(src).toContain("WEBHOOK_DEMO_SECRET");
  });

  test("the route requires a session before it does anything else", () => {
    const src = readFileSync(ROUTE_SRC, "utf8");
    // The gate must appear in the handler, not merely be imported: an import
    // with no call is exactly the shape this finding had.
    expect(src).toContain("requireSignedIn");
    const handlerAt = src.indexOf("export async function POST");
    const gateAt = src.indexOf("requireOperator()", handlerAt);
    expect(handlerAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(handlerAt);
  });
});
