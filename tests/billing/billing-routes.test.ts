/**
 * The three billing routes, at the HTTP boundary.
 *
 * These routes were registered in TENANTED_MODELS, in the isolation matrix, and
 * in the route table's public-by-design / DB-backed registers — and had no
 * coverage at all, which is what tipped the overall coverage gate below 65%. 252
 * lines of public surface with no test is exactly what that gate exists to
 * prevent.
 *
 * ## What is mocked, and why so little of it
 *
 * `mock.module` in Bun is PROCESS-GLOBAL: it rewrites the binding every later
 * import sees, not only this file's. That is not a theoretical hazard. An earlier
 * revision of this file mocked `@/lib/payments/mirror` for the portal route and
 * `tests/billing/paddle-mirror.test.ts` then ran against the mock, so
 * `paddleCustomerIdFor` returned null for a row that existed. Mocking
 * `@/lib/payments/paddle-events` breaks `tests/billing/paddle-events.test.ts` the
 * same way — "Export named 'handlePaddleEvent' not found" — because that file
 * imports the real one. CI's "Hostile timezone suite" runs
 * `tests/timezone tests/billing tests/telemetry tests/contracts` in ONE process,
 * so both reproduced there even though each file is green alone.
 *
 * So only two modules are mocked:
 *
 *   `@/lib/route-helpers`    for the session — the property under test is "the
 *                            route refuses without one", and mocking the resolver
 *                            is what makes that expressible. Put back in
 *                            `afterAll` because tests/unit/route-helpers.test.ts
 *                            imports it too.
 *   `@/lib/payments/gateway` for the gateway, which only this file imports.
 *
 * Everything else is real. `mirror` and `access` run against the database, and
 * the Paddle SDK is driven by `PADDLE_API_KEY` alone — which is exactly how
 * `paddleClient()` decides, so the portal's "billing unavailable" branch is a
 * real 503 rather than a stubbed one.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";

import * as realRouteHelpers from "@/lib/route-helpers";
import { db } from "@/lib/db";

// `paddleClient()` returns null when this is unset and a real SDK client when it
// is set, so the portal branches are reachable by changing a variable rather
// than by replacing a module.
//
// ⚠️ Bun auto-loads `.env` into `process.env` before any test runs, so
// `PADDLE_API_KEY` may already be set. `DISABLE_PADDLE` therefore DELETES rather
// than restoring a captured value — capturing and restoring would leave the dev
// sandbox key in place and both Paddle branches would silently be unreachable.
// The original value is put back in `afterAll` only.
const ORIGINAL_PADDLE_KEY = process.env.PADDLE_API_KEY;
const ENABLE_PADDLE = () => {
  process.env.PADDLE_API_KEY = "pdl_sdbx_apikey_routes_gate_not_a_real_key";
};
const DISABLE_PADDLE = () => {
  delete process.env.PADDLE_API_KEY;
};

// ── The session the routes will see ─────────────────────────────────────────
const ORG = "0a1a0a0a-0000-4000-8000-000000000001";
const OTHER_ORG = "0b1b0b0b-0000-4000-8000-000000000002";
const USER_EMAIL = "billing@securevoice.ae";

let sessionState: {
  ok: boolean;
  orgId: string | null;
  email: string | undefined;
  failure: { status: number; error: string };
} = { ok: true, orgId: ORG, email: USER_EMAIL, failure: { status: 401, error: "unauthenticated" } };

function signIn(orgId = ORG) {
  sessionState = {
    ok: true,
    orgId,
    email: USER_EMAIL,
    failure: { status: 401, error: "unauthenticated" },
  };
}

function signOut() {
  sessionState = {
    ok: false,
    orgId: null,
    email: undefined,
    failure: { status: 401, error: "unauthenticated" },
  };
}

// ── The gateway the checkout route will see ─────────────────────────────────
type GatewayShape = {
  ok: boolean;
  reason?: string;
  name: string;
  provider: {
    createCheckout: (args: unknown) => Promise<{ url: string; reference: string }>;
  };
};

let gatewayState: GatewayShape = {
  ok: false,
  reason: "not_configured",
  name: "none",
  provider: { createCheckout: async () => ({ url: "", reference: "" }) },
};

/**
 * No gateway, the state a fresh deployment is in. Every failure-path case below
 * needs this so it is testing the ROUTE and not the gateway.
 */
const NO_GATEWAY: GatewayShape = {
  ok: false,
  reason: "PADDLE_API_KEY is not set",
  name: "none",
  provider: { createCheckout: async () => ({ url: "", reference: "" }) },
};

type CheckoutArgs = {
  orgId: string;
  purpose: string;
  money: { amountMinor: number; currency: string };
};

/**
 * Build a gateway whose `createCheckout` records what it was handed.
 *
 * The parameter is typed rather than left `unknown`, because two of the tests
 * below are precisely about the org id and the purpose coming from the SESSION
 * and the route's own defaults — narrowing at the callback is how that becomes
 * an assertion rather than a comment.
 */
const GATEWAY = (
  createCheckout: (args: CheckoutArgs) => Promise<{ url: string; reference: string }>,
): GatewayShape => ({
  ok: true,
  name: "paddle",
  provider: { createCheckout: createCheckout as GatewayShape["provider"]["createCheckout"] },
});

mock.module("@/lib/route-helpers", () => ({
  // `ok` and `fail` are kept real in shape: the routes compose a NextResponse
  // from them and hand it straight back. A `mock.module` call REPLACES the whole
  // module, so every symbol the routes import has to be listed — a missing `ok`
  // is a SyntaxError at import time, not a silent gap.
  ok: (data: unknown) => NextResponse.json(data),
  fail: (failure: { status?: number } & Record<string, unknown>) =>
    NextResponse.json(failure, { status: failure.status ?? 401 }),
  requireOrg: async () =>
    sessionState.ok
      ? {
          ok: true as const,
          orgId: sessionState.orgId as string,
          identity: { userId: "user_1", email: sessionState.email },
        }
      : { ok: false as const, failure: sessionState.failure },
}));

mock.module("@/lib/payments/gateway", () => ({
  resolvePaymentProvider: () => gatewayState,
}));

// Imported AFTER the mocks so the route's own view of `requireOrg` is the mocked
// one. `mirror`, `access` and `paddle-events` are NOT mocked.
const { POST: checkout } = await import("@/app/api/billing/checkout/route");
const { POST: portal } = await import("@/app/api/billing/portal/route");

const req = (url: string, init?: RequestInit) =>
  new NextRequest(new Request(`http://localhost${url}`, init));

// A REAL mirrored customer, so the portal route resolves through the real
// `paddleCustomerIdFor` rather than a stand-in.
const CUSTOMER = "ctm_routes_gate_001";
const SUBSCRIPTION = "sub_routes_gate_001";

beforeAll(async () => {
  for (const id of [ORG, OTHER_ORG]) {
    await db.organization.upsert({
      where: { id },
      create: {
        id,
        name: `Billing routes gate ${id.slice(0, 8)}`,
        slug: `routes-gate-${id.slice(0, 8)}`,
        createdAt: new Date("2026-10-10T00:00:00.000Z"),
      },
      update: {},
    });
  }
  await db.paddleCustomer.create({
    data: { customerId: CUSTOMER, orgId: ORG, email: USER_EMAIL },
  });
  await db.paddleSubscription.create({
    data: {
      subscriptionId: SUBSCRIPTION,
      customerId: CUSTOMER,
      orgId: ORG,
      status: "active",
      priceId: "pri_routes_gate",
      productId: "pro_routes_gate",
    },
  });
}, 30_000);

afterAll(async () => {
  signIn();
  gatewayState = NO_GATEWAY;
  // Restore the process's own key, whatever the suite did to it.
  if (ORIGINAL_PADDLE_KEY === undefined) delete process.env.PADDLE_API_KEY;
  else process.env.PADDLE_API_KEY = ORIGINAL_PADDLE_KEY;
  await db.paddleSubscription.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
  await db.paddleCustomer.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
  await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  // Put the one mock that another suite imports back.
  void mock.module("@/lib/route-helpers", () => realRouteHelpers);
}, 30_000);

describe("checkout refuses before it looks at the body", () => {
  test("an absent session is a 401, whatever the body says", async () => {
    signOut();
    const res = await checkout(
      new NextRequest(
        new Request("http://localhost/api/billing/checkout", {
          method: "POST",
          body: JSON.stringify({ amountMinor: 9900, currency: "USD" }),
        }),
      ),
    );
    expect(res.status).toBe(401);
  });

  test("malformed JSON is a 400 malformed_json, not a 500", async () => {
    signIn();
    const r = await checkout(
      new NextRequest(
        new Request("http://localhost/api/billing/checkout", {
          method: "POST",
          body: "this is not json",
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "malformed_json" });
  });

  test("a body that fails the schema is 400 invalid_request and names the field", async () => {
    signIn();
    gatewayState = NO_GATEWAY;
    for (const currency of ["us", "USDD", "u5d"]) {
      const r = await checkout(
        req("/api/billing/checkout", {
          body: JSON.stringify({ amountMinor: 9900, currency }),
        }),
      );
      expect(r.status, `currency ${JSON.stringify(currency)}`).toBe(400);
    }
    const r = await checkout(
      req("/api/billing/checkout", {
        body: JSON.stringify({ amountMinor: 9900, currency: "us" }),
      }),
    );
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues).toContain("currency");
  });

  test("a lowercase three-letter currency passes the SHAPE check", async () => {
    signIn();
    gatewayState = NO_GATEWAY;
    const r = await checkout(
      req("/api/billing/checkout", {
        body: JSON.stringify({ amountMinor: 9900, currency: "usd" }),
      }),
    );
    expect(r.status).toBe(503);
  });

  test("a non-positive, fractional or oversized amount is refused", async () => {
    signIn();
    gatewayState = NO_GATEWAY;
    for (const amountMinor of [0, -1, 99.5, 100_000_001]) {
      const r = await checkout(
        req("/api/billing/checkout", {
          body: JSON.stringify({ amountMinor, currency: "USD" }),
        }),
      );
      expect(r.status, `amount ${amountMinor}`).toBe(400);
    }
  });

  test("a session with no org is refused, not allowed through as orgless", async () => {
    sessionState = {
      ok: false,
      orgId: null,
      email: USER_EMAIL,
      failure: { status: 409, error: "no_organization" },
    };
    const res = await checkout(
      req("/api/billing/checkout", {
        body: JSON.stringify({ amountMinor: 9900, currency: "USD" }),
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("checkout reports a DEPLOYMENT problem as 503, not a customer problem", () => {
  test("no gateway bound is billing_unavailable", async () => {
    signIn();
    gatewayState = NO_GATEWAY;
    const r = await checkout(
      req("/api/billing/checkout", {
        body: JSON.stringify({ amountMinor: 9900, currency: "USD" }),
      }),
    );
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "billing_unavailable" });
  });

  test("a gateway that throws is 502 checkout_failed, without echoing the message", async () => {
    signIn();
    gatewayState = GATEWAY(async () => {
      // A message that names a price key and an org id — precisely what the
      // route's comment says must not reach the browser.
      throw new Error("no price for usd_9900_month on org_secret_bank");
    });
    const r = await checkout(
      req("/api/billing/checkout", {
        body: JSON.stringify({ amountMinor: 9900, currency: "USD" }),
      }),
    );
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body).toEqual({ error: "checkout_failed" });
    expect(JSON.stringify(body)).not.toContain("org_secret_bank");
    expect(JSON.stringify(body)).not.toContain("usd_9900_month");
  });

  test("a successful mint returns the url and the reference", async () => {
    signIn();
    let seenOrgId: string | undefined;
    gatewayState = GATEWAY(async (args: CheckoutArgs) => {
      seenOrgId = args.orgId;
      return {
        url: "https://sandbox-checkout.paddle.com/xyz",
        reference: `${ORG}_subscription_01HQ0000000000000000ABCDEF`,
      };
    });
    const r = await checkout(
      req("/api/billing/checkout", {
        body: JSON.stringify({ amountMinor: 9900, currency: "USD" }),
      }),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.url).toBe("https://sandbox-checkout.paddle.com/xyz");
    // The reference is OURS, and carries the org — that is what the webhook
    // decodes to settle. The browser receives it but is never trusted with it.
    expect(body.reference).toBe(`${ORG}_subscription_01HQ0000000000000000ABCDEF`);
    expect(body.provider).toBe("paddle");
    // The org handed the gateway is the SESSION's, never anything in the body.
    expect(seenOrgId).toBe(ORG);
  });

  test("a body carrying someone else's orgId cannot scope the purchase", async () => {
    signIn();
    let seenOrgId: string | undefined;
    let seenPurpose: string | undefined;
    gatewayState = GATEWAY(async (args: CheckoutArgs) => {
      seenOrgId = args.orgId;
      seenPurpose = args.purpose;
      return { url: "https://sandbox-checkout.paddle.com/xyz", reference: "ref" };
    });
    const r = await checkout(
      req("/api/billing/checkout", {
        body: JSON.stringify({ amountMinor: 9900, currency: "USD", orgId: OTHER_ORG }),
      }),
    );
    expect(r.status).toBe(200);
    expect(seenOrgId).toBe(ORG);
    expect(seenOrgId).not.toBe(OTHER_ORG);
    expect(seenPurpose).toBe("subscription");
  });
});

describe("portal", () => {
  test("an absent session is a 401, before anything else runs", async () => {
    signOut();
    DISABLE_PADDLE();
    const res = await portal(req("/api/billing/portal", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  test("no Paddle client configured is 503", async () => {
    signIn();
    DISABLE_PADDLE();
    const res = await portal(req("/api/billing/portal", { method: "POST" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "billing_unavailable" });
  });

  test("an org that has never bought is 404 no_billing_account", async () => {
    // A DIFFERENT org, signed in, with Paddle configured. The real
    // `paddleCustomerIdFor` returns null for them, which is the portal's safety
    // property: another org's session cannot reach this customer's portal.
    signIn(OTHER_ORG);
    ENABLE_PADDLE();
    const res = await portal(req("/api/billing/portal", { method: "POST" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_billing_account" });
    DISABLE_PADDLE();
  });

  test("a REAL mint failure is 502 portal_session_failed, and echoes no customer id", async () => {
    // No mock here, and that is the point. `PADDLE_API_KEY` holds a value that
    // is not a real credential, so `paddleClient()` builds a real SDK client and
    // `customerPortalSessions.create` genuinely fails against Paddle. The route
    // must turn that into a 502 that says nothing about which customer was
    // involved — asserted on the response text rather than on a stub.
    signIn();
    ENABLE_PADDLE();
    const res = await portal(
      req("/api/billing/portal", { body: JSON.stringify({ customerId: "ctm_somebody_else" }) }),
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(CUSTOMER);
    expect(text).not.toContain("ctm_somebody_else");
    DISABLE_PADDLE();
  }, 30_000);
});
