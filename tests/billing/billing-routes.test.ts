/**
 * The three billing routes, at the HTTP boundary.
 *
 * These were registered in TENANTED_MODELS, in the isolation matrix, and in the
 * route table's public-by-design / DB-backed registers — and had NO coverage at
 * all, which is what tipped the overall coverage gate below 65%. 252 lines of
 * public surface with no test is the exact thing that gate exists to prevent, so
 * these tests are the fix rather than a threshold edit.
 *
 * The interesting properties are the AUTHENTICATION BOUNDARIES, not the happy
 * path: Paddle is not available to a test runner, so the valuable assertions are
 * what happens when the session is absent, when the body is malformed, when the
 * gateway is unconfigured, and when Paddle throws. The Paddle SDK is mocked so
 * the mint paths can be asserted without a network.
 *
 * `requireOrg` is mocked rather than driven through Better Auth, because the
 * property under test is "the route refuses without a session" — and mocking the
 * one function that resolves the session is what makes that property expressible.
 * `tests/console/documents.test.ts` uses the same approach.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";

// The real modules, for `afterAll` to put back. `mock.module` is process-global;
// CI runs each file in its own process so this never matters there, but a local
// combined run needs restoring or the next file dies on a missing export.
import * as realRouteHelpers from "@/lib/route-helpers";
import * as realGateway from "@/lib/payments/gateway";
import * as realPaddleEvents from "@/lib/payments/paddle-events";
import * as realMirror from "@/lib/payments/mirror";
import * as realAccess from "@/lib/payments/access";

// ── The session the routes will see ─────────────────────────────────────────
const ORG = "org_billing_route_gate";
const OTHER_ORG = "org_someone_elses_bank";
const USER_EMAIL = "billing@securevoice.ae";

let sessionState: {
  ok: boolean;
  orgId: string | null;
  email: string | undefined;
  failure: { status: number; error: string };
} = { ok: true, orgId: ORG, email: USER_EMAIL, failure: { status: 401, error: "unauthenticated" } };

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

// ── Paddle, for the portal route ────────────────────────────────────────────
let clientState: {
  available: boolean;
  urls?: { general?: { overview?: string } };
  throws?: boolean;
} = {
  available: false,
};

let mirrorState: { customerId: string | null; subscriptionId: string | null } = {
  customerId: null,
  subscriptionId: null,
};

let minted: { customerId?: string; subscriptionIds?: string[]; throws?: string } = {};

mock.module("@/lib/route-helpers", () => ({
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

mock.module("@/lib/payments/paddle-events", () => ({
  paddleClient: () =>
    clientState.available
      ? {
          customerPortalSessions: {
            create: async (customerId: string, subscriptionIds: string[]) => {
              minted = { customerId, subscriptionIds };
              if (clientState.throws) {
                // Mirrors the route's own rule: throw a message that carries the
                // customer id, so the assertion can prove it is not echoed back.
                throw new Error(`customer ${customerId} not found`);
              }
              return { urls: clientState.urls ?? {} };
            },
          },
        }
      : null,
}));

mock.module("@/lib/payments/mirror", () => ({
  paddleCustomerIdFor: async () => mirrorState.customerId,
}));

mock.module("@/lib/payments/access", () => ({
  currentSubscription: async () =>
    mirrorState.subscriptionId === null
      ? null
      : { subscriptionId: mirrorState.subscriptionId, status: "active", orgId: ORG },
}));

// Import AFTER the mocks: these modules read `requireOrg` and the gateway at
// call time, but a mocked symbol is only visible once the importer has resolved
// it through the same registry mock.module installs into.
const { POST: checkout } = await import("@/app/api/billing/checkout/route");
const { POST: portal } = await import("@/app/api/billing/portal/route");

const req = (url: string, init?: RequestInit) =>
  new NextRequest(new Request(`http://localhost${url}`, init));

/** Explicit sign-in/sign-out, so no case depends on the one before it. */
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
 * The parameter is typed `CheckoutArgs` rather than left `unknown`, because the
 * whole point of two of the tests below is that the org id and the purpose come
 * from the SESSION and the route's own defaults — narrowing at the callback is
 * how that becomes an assertion rather than a comment.
 */
const GATEWAY = (
  createCheckout: (args: CheckoutArgs) => Promise<{ url: string; reference: string }>,
): GatewayShape => ({
  ok: true,
  name: "paddle",
  provider: { createCheckout: createCheckout as GatewayShape["provider"]["createCheckout"] },
});

describe("checkout refuses before it looks at the body", () => {
  test("an absent session is a 401, whatever the body says", async () => {
    signOut();
    // A complete, well-formed body: the refusal must come from the missing
    // session, not from anything about the request.
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
    // Currency must be exactly three letters. "us"/"USDD" are the wrong LENGTH
    // and "u5d" has a digit — NOT the wrong case: the regex is
    // `/^[A-Za-z]{3}$/`, which accepts `usd` as well as `USD`. Lowercase
    // passing the shape check is pinned in its own test below rather than
    // assumed away here.
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
    // `/^[A-Za-z]{3}$/` accepts `usd`. What happens next is the gateway's
    // business: with no gateway bound the route answers 503, which proves the
    // body was accepted and the failure is the deployment, not the caller.
    // Pinned so tightening the regex to uppercase-only later is a visible
    // decision rather than an accident of a rewrite.
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
        req("/api/billing/checkout", { body: JSON.stringify({ amountMinor, currency: "USD" }) }),
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
      // A message that names a price key and an org id - precisely what the
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
        reference: "org_billing_route_gate_subscription_01HQ0000000000000000ABCDEF",
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
    // The reference is OURS, and carries the org - that is what the webhook
    // decodes to settle. The browser receives it but is never trusted with it.
    expect(body.reference).toBe("org_billing_route_gate_subscription_01HQ0000000000000000ABCDEF");
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

describe("portal never honours the client's customerId", () => {
  test("an absent session is a 401", async () => {
    signOut();
    const res = await portal(req("/api/billing/portal", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  test("no Paddle client configured is 503", async () => {
    signIn();
    clientState = { available: false };
    const res = await portal(req("/api/billing/portal", { method: "POST" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "billing_unavailable" });
  });

  test("an org that has never bought is 404 no_billing_account", async () => {
    signIn();
    clientState = { available: true };
    mirrorState = { customerId: null, subscriptionId: null };
    const res = await portal(req("/api/billing/portal", { method: "POST" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_billing_account" });
  });

  test("a body's customerId is IGNORED - the portal URL is for the SESSION's org", async () => {
    signIn();
    clientState = {
      available: true,
      urls: { general: { overview: "https://paddle.com/portal/ours" } },
    };
    mirrorState = { customerId: "ctm_ours", subscriptionId: "sub_ours" };
    minted = {};
    const res = await portal(
      req("/api/billing/portal", { body: JSON.stringify({ customerId: "ctm_theirs" }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://paddle.com/portal/ours" });
    // The mint used OUR customer id. This is the whole point of the route: a
    // caller naming a different customer must open their own portal.
    expect(minted.customerId).toBe("ctm_ours");
    expect(minted.customerId).not.toBe("ctm_theirs");
    // And the subscription ids came from OUR mirror, not the body.
    expect(minted.subscriptionIds).toEqual(["sub_ours"]);
  });

  test("an org with no subscription yet still gets a session, scoped to nothing", async () => {
    // The mirror has a customer but no active subscription. A portal session is
    // still useful - it is where the customer manages their payment method - so
    // the empty list is correct and must not be treated as an error.
    signIn();
    clientState = {
      available: true,
      urls: { general: { overview: "https://paddle.com/portal/ours" } },
    };
    mirrorState = { customerId: "ctm_ours", subscriptionId: null };
    minted = {};
    const res = await portal(req("/api/billing/portal", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(minted.subscriptionIds).toEqual([]);
  });

  test("a portal session with no url is 502, not a silent success", async () => {
    signIn();
    clientState = { available: true, urls: {} };
    mirrorState = { customerId: "ctm_ours", subscriptionId: "sub_ours" };
    const res = await portal(req("/api/billing/portal", { method: "POST" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "portal_session_failed" });
  });

  test("a mint that throws is 502 and does not echo the customer id", async () => {
    signIn();
    clientState = { available: true, throws: true };
    mirrorState = { customerId: "ctm_ours_secret", subscriptionId: "sub_ours" };
    const res = await portal(req("/api/billing/portal", { method: "POST" }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("ctm_ours_secret");
  });
});

afterAll(() => {
  signIn();
  gatewayState = NO_GATEWAY;
  clientState = { available: false };
  mirrorState = { customerId: null, subscriptionId: null };
  minted = {};
  // `mock.module` is process-global, NOT scoped to this file. CI runs each suite
  // in its own process (scripts/run-tests.mjs), so this never bites there — but a
  // local `bun test tests/billing` runs these in one process, and the mocks above
  // replace the module registry entries for `paddle-events` and its friends, so
  // the NEXT file in that process fails with "Export named X not found". Put the
  // real modules back so the leak is contained to where it is deliberate.
  for (const [specifier, real] of [
    ["@/lib/route-helpers", realRouteHelpers],
    ["@/lib/payments/gateway", realGateway],
    ["@/lib/payments/paddle-events", realPaddleEvents],
    ["@/lib/payments/mirror", realMirror],
    ["@/lib/payments/access", realAccess],
  ] as const) {
    void mock.module(specifier, () => real);
  }
});
