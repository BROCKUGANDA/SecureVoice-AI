/**
 * E2E — a pause made in the PADDLE PORTAL stops this tenant's dialler.
 *
 * `tests/billing/subscription-dialling-access.test.ts` proves the rule and the
 * mirror in isolation. This file proves the delivery, through the real route with
 * a real signature, because that is where the feature was actually missing:
 *
 *   · the route attributed an event ONLY from `custom_data.reference`, the token we
 *     mint at checkout;
 *   · a pause or resume performed in Paddle's own UI carries the subscription's
 *     `customer_id` and not necessarily that reference;
 *   · so the delivery was answered `200 { mirrored: false }`, the log said
 *     "unattributable", `PaddleSubscription.status` stayed `active`, and the tenant
 *     went on calling bank customers on a carrier account that had stopped billing
 *     them.
 *
 * Every case here is a signed POST to `src/app/api/billing/webhook/route.ts` — no
 * stubbed verifier. The signature is the SDK's own algorithm (HMAC-SHA256 over
 * `<ts>:<raw body>`, constant-time compare, five-minute tolerance) and the body is
 * signed as the exact bytes the route will read, which is the property the route
 * header insists on.
 *
 *   bun scripts/run-tests.mjs paddle-pause
 * (not a bare `bun test` — the shared database's round trips exceed bun's 5 000 ms
 *  default; see scripts/run-tests.mjs)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

import { db } from "@/lib/db";
import { mirrorCustomer } from "@/lib/payments/mirror";
import { buildReference } from "@/lib/payments/paddle";
import { mayDialFor } from "@/lib/payments/access";
import { POST } from "@/app/api/billing/webhook/route";

const SECRET = "pdl_notif_e2e_pause_secret";

// The route needs a client to verify with; `pdl_sdbx_` selects the sandbox
// environment. Verification is local crypto — nothing here reaches Paddle, and no
// live credential is involved.
process.env.PADDLE_API_KEY = "pdl_sdbx_e2e_pause_key";
process.env.PADDLE_WEBHOOK_SECRET = SECRET;

const RUN = Date.now().toString(36);
// `organization.id` is a `uuid` column, so the per-run discriminator has to be
// hex: a base36 `RUN` in the last group fails at the driver with `invalid input
// syntax for type uuid`, which is a fixture bug that reads like a schema one.
const HEX = (Date.now().toString(16) + "0".repeat(12)).slice(0, 12);
const ORG_A = `11111111-1111-4111-8111-${HEX}`;
const ORG_B = `22222222-2222-4222-8222-${HEX}`;

/**
 * Subscription ids are named per case rather than counted by a shared counter:
 * the resume case must write to the SAME row the pause case created, and an id
 * derived from how many events were delivered earlier makes that a test-ordering
 * dependency instead of a statement of intent.
 */
const SUB = (which: string) => `sub_e2e_${which}_${RUN}`;

let eventSeq = 0;

/** Sign with the SDK's own string-to-sign: `<ts>:<exact bytes>`, no re-serialising. */
function deliver(data: Record<string, unknown>, eventType: string) {
  eventSeq += 1;
  const body = JSON.stringify({
    event_id: `evt_01${RUN}${eventSeq}`,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    data,
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const h1 = createHmac("sha256", SECRET).update(`${ts}:`).update(body).digest("hex");
  return new NextRequest("http://localhost/api/billing/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Paddle-Signature": `ts=${ts};h1=${h1}` },
    body,
  });
}

beforeAll(async () => {
  for (const [id, name] of [
    [ORG_A, "Portal pause A"],
    [ORG_B, "Portal pause B"],
  ] as const) {
    await db.organization.create({
      data: {
        id,
        name,
        slug: `pause-${name.toLowerCase().replace(/ /g, "-")}-${RUN}`,
        createdAt: new Date(),
      },
    });
  }
  // The mirror rows arrive through the mirror's own function, the same one the
  // `customer.created` handler calls, so the FK the subscription needs is written
  // by the code that will later read it.
  await mirrorCustomer({
    customerId: `ctm_a_${RUN}`,
    orgId: ORG_A,
    email: "a@example.test",
    name: "Tenant A",
  });
  await mirrorCustomer({
    customerId: `ctm_b_${RUN}`,
    orgId: ORG_B,
    email: "b@example.test",
    name: "Tenant B",
  });
}, 60_000);

afterAll(async () => {
  const orgs = [ORG_A, ORG_B];
  await db.paddleSubscription.deleteMany({ where: { orgId: { in: orgs } } });
  await db.paddleCustomer.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
}, 60_000);

describe("POST /api/billing/webhook — subscription state the gate reads", () => {
  test("a bad signature is refused before anything is mirrored", async () => {
    const body = JSON.stringify({
      event_id: "evt_01forged",
      event_type: "subscription.paused",
      occurred_at: new Date().toISOString(),
      data: { id: SUB("forged"), status: "paused", customer_id: `ctm_a_${RUN}` },
    });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await POST(
      new NextRequest("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Paddle-Signature": `ts=${ts};h1=${"0".repeat(64)}`,
        },
        body,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
    expect(await mayDialFor(ORG_A)).toBe(true);
  }, 60_000);

  test("a portal pause with no custom_data still stops the dialler", async () => {
    const subscriptionId = SUB("pause");
    const res = await POST(
      deliver(
        {
          id: subscriptionId,
          status: "paused",
          customer_id: `ctm_a_${RUN}`,
          // NO custom_data: this is the shape Paddle's own portal produces.
          items: [{ price: { id: "pri_growth", product: { id: "pro_growth" } } }],
        },
        "subscription.paused",
      ),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    // `mirrored: true` is the assertion that the fix is load-bearing: with
    // reference-only attribution this response said `mirrored: false` and the
    // tenant's dialler kept running.
    expect(json.mirrored).toBe(true);

    const row = await db.paddleSubscription.findUnique({
      where: { subscriptionId },
      select: { status: true, orgId: true },
    });
    expect(row?.status).toBe("paused");
    // Attributed to the org that owns the customer — not to an org the payload
    // named, and not to nobody.
    expect(row?.orgId).toBe(ORG_A);
    expect(await mayDialFor(ORG_A)).toBe(false);
  }, 60_000);

  test("a resumed subscription hands the dialler back", async () => {
    const res = await POST(
      deliver(
        {
          id: SUB("pause"),
          status: "active",
          customer_id: `ctm_a_${RUN}`,
          items: [{ price: { id: "pri_growth", product: { id: "pro_growth" } } }],
        },
        "subscription.resumed",
      ),
    );
    expect(res.status).toBe(200);
    expect(await mayDialFor(ORG_A)).toBe(true);
  }, 60_000);

  test("one tenant's pause never lands in another tenant's mirror", async () => {
    const subscriptionId = SUB("other");
    const res = await POST(
      deliver(
        { id: subscriptionId, status: "paused", customer_id: `ctm_b_${RUN}` },
        "subscription.paused",
      ),
    );
    expect(res.status).toBe(200);
    expect(await mayDialFor(ORG_B)).toBe(false);
    expect(await mayDialFor(ORG_A)).toBe(true);

    const row = await db.paddleSubscription.findUnique({
      where: { subscriptionId },
      select: { orgId: true },
    });
    expect(row?.orgId).toBe(ORG_B);
  }, 60_000);

  test("a customer we have never mirrored is ignored with 200", async () => {
    // Not a 400: Paddle did nothing wrong, and a 4xx makes it retry an event that
    // will never be attributable. But it must not create an orphan either.
    const subscriptionId = SUB("orphan");
    const res = await POST(
      deliver(
        { id: subscriptionId, status: "paused", customer_id: "ctm_never_seen" },
        "subscription.paused",
      ),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).mirrored).toBe(false);
    expect(await db.paddleSubscription.findUnique({ where: { subscriptionId } })).toBeNull();
  }, 60_000);

  test("a re-delivered pause is idempotent", async () => {
    const subscriptionId = SUB("replay");
    const data = { id: subscriptionId, status: "paused", customer_id: `ctm_a_${RUN}` };
    await POST(deliver(data, "subscription.paused"));
    const second = await POST(deliver(data, "subscription.paused"));
    expect(second.status).toBe(200);
    const rows = await db.paddleSubscription.findMany({ where: { subscriptionId } });
    expect(rows).toHaveLength(1);
    expect(await mayDialFor(ORG_A)).toBe(false);
  }, 60_000);

  test("a minted reference wins over the customer it also names", async () => {
    // Precedence, stated. The reference is the stronger claim: it is a token we
    // minted for THIS checkout, whereas a `PaddleCustomer` row can be re-pointed by
    // a later `customer.updated`. A delivery that names tenant B's customer while
    // carrying tenant A's reference is a mis-minted checkout or a vendor mixup, and
    // the route logs the conflict rather than picking silently.
    //
    // Last in the file on purpose: it deliberately writes a row under ORG_A for a
    // customer belonging to ORG_B, and every earlier case reads those orgs' state.
    const subscriptionId = SUB("conflict");
    const res = await POST(
      deliver(
        {
          id: subscriptionId,
          status: "paused",
          customer_id: `ctm_b_${RUN}`,
          custom_data: { reference: buildReference(ORG_A, "portal") },
        },
        "subscription.paused",
      ),
    );
    expect(res.status).toBe(200);
    const row = await db.paddleSubscription.findUnique({
      where: { subscriptionId },
      select: { orgId: true },
    });
    expect(row?.orgId).toBe(ORG_A);
    // The same event must not ALSO have been booked to B: one delivery, one row,
    // under one org. Two rows would mean two tenants' dial gates driven by a single
    // customer's pause.
    expect(
      await db.paddleSubscription.findFirst({ where: { subscriptionId, orgId: ORG_B } }),
    ).toBeNull();
  }, 60_000);

  test("a delivery that breaks the declared shape is logged, never refused", async () => {
    // The schema runs on every authenticated delivery as a DIAGNOSTIC. If it gated,
    // a field Paddle starts omitting would turn into a 4xx, Paddle would stop
    // retrying, and a completed payment would never be credited — the trap this
    // route's header documents for `unmarshal`, which is why the typed constructor
    // is not allowed to decide anything here.
    //
    // `status` is required by the contract and absent from this payload: the route
    // must still take the delivery, and the drift still has to reach the database in
    // a form an operator can see (`unknown`, not a silent guess at `active`).
    const subscriptionId = SUB("shapedrift");
    const res = await POST(
      deliver({ id: subscriptionId, customer_id: `ctm_a_${RUN}` }, "subscription.updated"),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).mirrored).toBe(true);
    const row = await db.paddleSubscription.findUnique({
      where: { subscriptionId },
      select: { status: true },
    });
    expect(row?.status).toBe("unknown");
  }, 60_000);
});
