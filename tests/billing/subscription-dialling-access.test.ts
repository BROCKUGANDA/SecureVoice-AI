/**
 * A PAUSED TENANT STOPS DIALLING — the billing state that has to reach the dial
 * path, and the three states that deliberately do not.
 *
 * Two modules used to answer "does this subscription grant access?":
 * `src/lib/payments/access.ts` (documented, deliberate, and consulted only by the
 * billing portal) and a policy-gate helper that re-derived the answer from
 * `PaddleSubscription` directly. Two sources of truth on an access rule is how one
 * of them ends up wrong without anyone noticing, so there is now one module with
 * two named questions in it:
 *
 *   · `decideAccess`       — may they USE the product they paid for?
 *   · `diallingBlockedFor` — may we place a NEW carrier call that bills nobody?
 *
 * They disagree on `paused`, on purpose, and the disagreement lives in one file
 * rather than two. This suite pins the disagreement, because the failure mode of
 * an access rule is always a customer either locked out wrongly or served for
 * free — never a stack trace.
 *
 * Also pins the substrate the rule reads: the `subscription.paused` /
 * `.past_due` / `.resumed` webhooks must actually mirror. Before this, an event
 * the dispatcher did not know fell to the generic branch of the webhook schema,
 * was acknowledged with 200 as "seen, not ours", and the tenant's billing state
 * stayed whatever the last `subscription.updated` happened to say — while every
 * log line reported a healthy delivery.
 *
 * Runs against a real database, the same as `tests/billing/paddle-mirror.test.ts`:
 * `PaddleSubscription.customerId` is an FK to `PaddleCustomer`, so seeding a
 * subscription without its customer fails at the constraint rather than at an
 * assertion, which is the least informative way to learn the rule works.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import {
  decideAccess,
  diallingBlockedFor,
  mayDialFor,
  currentSubscription,
} from "@/lib/payments/access";
import { handlePaddleEvent, isHandledEvent } from "@/lib/payments/paddle-events";
import {
  KNOWN_PADDLE_EVENT_TYPES,
  isKnownPaddleEvent,
  validatePaddleWebhook,
} from "@/lib/validation/webhook-schema";

function uuid(slot: number): string {
  const h = createHash("sha256").update(`dialling-access:${slot}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const RUN = Date.now().toString(36);
const PAUSED_ORG = uuid(1);
const PAST_DUE_ORG = uuid(2);
const ACTIVE_ORG = uuid(3);
const UNKNOWN_STATUS_ORG = uuid(4);
const NO_ROW_ORG = uuid(5);
const MIRRORED_ORG = uuid(6);
const STALE_ORG = uuid(7);

const ORGS = [
  PAUSED_ORG,
  PAST_DUE_ORG,
  ACTIVE_ORG,
  UNKNOWN_STATUS_ORG,
  NO_ROW_ORG,
  MIRRORED_ORG,
  STALE_ORG,
];

async function seedOrg(id: string, name: string) {
  await db.organization.create({
    data: {
      id,
      name,
      slug: `access-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${RUN}`,
      createdAt: new Date(),
    },
  });
}

/** A tenant whose dialling state is decided by exactly one mirrored subscription. */
async function seedSubscription(
  orgId: string,
  subscriptionId: string,
  status: string,
  createdAt?: Date,
) {
  const customerId = `ctm_${subscriptionId}`;
  await db.paddleCustomer.create({
    data: { customerId, orgId, email: `${subscriptionId}@example.test`, name: null },
  });
  await db.paddleSubscription.create({
    data: {
      subscriptionId,
      customerId,
      orgId,
      status,
      priceId: "pri_test",
      productId: "pro_test",
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

beforeAll(async () => {
  for (const id of ORGS) await seedOrg(id, id.slice(0, 8));
  await seedSubscription(PAUSED_ORG, `sub_paused_${RUN}`, "paused");
  await seedSubscription(PAST_DUE_ORG, `sub_pastdue_${RUN}`, "past_due");
  await seedSubscription(ACTIVE_ORG, `sub_active_${RUN}`, "active");
  await seedSubscription(UNKNOWN_STATUS_ORG, `sub_weird_${RUN}`, "grace_period_v2");
  // MIRRORED_ORG and STALE_ORG get their subscription rows through the webhook
  // handlers and the last test below, because a seed that skipped the mirror
  // would not test the substrate.
}, 60_000);

afterAll(async () => {
  await db.paddleSubscription.deleteMany({ where: { orgId: { in: ORGS } } });
  await db.paddleCustomer.deleteMany({ where: { orgId: { in: ORGS } } });
  await db.organization.deleteMany({ where: { id: { in: ORGS } } });
}, 60_000);

describe("the two access questions, and where they differ", () => {
  test("a paused tenant keeps product access and loses the dialler", async () => {
    // The pause is the customer's own decision about BILLING; the product rule
    // honours it as "still theirs", and the dialling rule honours it as "stop
    // placing calls nobody is being billed for". Both readings are defensible;
    // having them in one file is what stops a future edit making them agree by
    // accident.
    expect(decideAccess("paused").granted).toBe(true);
    expect(decideAccess("paused").needsAttention).toBe(true);
    const dial = await diallingBlockedFor(PAUSED_ORG);
    expect(dial.allowed).toBe(false);
    if (!dial.allowed) expect(dial.status).toBe("paused");
    expect(await mayDialFor(PAUSED_ORG)).toBe(false);
  });

  test("a failed card does not silence a fraud line", async () => {
    // Paddle's dunning ladder runs for weeks. Cutting a bank off mid-incident
    // over a declined renewal is the worse of two bad options, and it is a
    // commercial call the rule makes explicitly rather than a default.
    expect(await mayDialFor(PAST_DUE_ORG)).toBe(true);
    expect(decideAccess("past_due").granted).toBe(true);
    expect(decideAccess("past_due").needsAttention).toBe(true);
  });

  test("an active tenant dials, and a cancelled one keeps spending what they paid for", () => {
    expect(decideAccess("active").granted).toBe(true);
    expect(decideAccess("active").needsAttention).toBe(false);
    // `canceled` revokes USE of the paid surface; it does not strand prepaid
    // credits, which is why the dialling rule allows it and the ledger is the
    // thing that eventually stops the calls.
    expect(decideAccess("canceled").granted).toBe(false);
  });

  test("a status this build has never seen fails closed for access and open for dialling", async () => {
    // `unknown_status` must never be "grant everything" — Paddle adding a status
    // is not an authorisation. But silently stopping a bank's fraud dialler
    // because a vendor renamed a state is the other failure, and the dialling
    // rule is allowed to prefer the customer's protection.
    expect(decideAccess("grace_period_v2")).toEqual({
      granted: false,
      reason: "unknown_status",
      needsAttention: false,
    });
    expect(await mayDialFor(UNKNOWN_STATUS_ORG)).toBe(true);
  });

  test("no Paddle row is not a revocation", async () => {
    // The reference deployment, a self-hosted pilot and a manual-invoice tenant
    // all have no mirror row by definition.
    expect(await mayDialFor(NO_ROW_ORG)).toBe(true);
    expect(await mayDialFor(null)).toBe(true);
    expect(await currentSubscription(NO_ROW_ORG)).toBeNull();
  });

  test("one tenant's pause cannot silence another's dialler", async () => {
    // The read is by `orgId`; a shared helper that resolved the newest row across
    // all tenants would take the platform down for everyone the first time one
    // customer pressed pause.
    expect(await mayDialFor(ACTIVE_ORG)).toBe(true);
    expect(await mayDialFor(PAUSED_ORG)).toBe(false);
  });

  test("the gate itself asks the question — a rule nothing calls is not a control", async () => {
    // The original defect was not the missing helper: `past_due` was already
    // mirrored and `hasPaidAccess` already existed, but the dial path never asked
    // billing anything. Asserting `diallingBlockedFor` in isolation would still
    // pass with step 5b deleted from `runPolicyGate`, so this drives the gate the
    // way the ingest route does.
    const { runPolicyGate } = await import("@/lib/policy-gate");
    const base = {
      phone: "+971500000077",
      consentRecordId: "consent-record-1",
      callerId: "operator-dialling-access",
      transactionRef: `TXN-DA-${RUN}`,
    };

    const paused = await runPolicyGate({
      ...base,
      orgId: PAUSED_ORG,
      caseRef: `SV-DA-PAUSED-${RUN}`,
    });
    expect(paused.ok).toBe(false);
    if (paused.ok) throw new Error("a paused tenant was allowed to dial");
    expect(paused.code).toBe("subscription_paused");
    expect(paused.reason).toContain("paused");

    // An active tenant gets PAST this gate. Asserting only that the paused tenant
    // is refused would also pass if step 5b refused everyone.
    const active = await runPolicyGate({
      ...base,
      orgId: ACTIVE_ORG,
      caseRef: `SV-DA-ACTIVE-${RUN}`,
    });
    if (!active.ok) expect(active.code).not.toBe("subscription_paused");
  }, 60_000);

  test("the refusal reaches the bank as a documented 409, not a 500", async () => {
    // The other seam that used to be missing: this gate now emits an eleventh
    // code, and `policyRefusal()` throws a RangeError on any code it has not been
    // told about. A refusal that crashes the boundary is a 500 telling the bank to
    // retry a decision that will be refused again — the envelope's own negative
    // control, broken by adding a correct feature.
    const { policyRefusal } = await import("@/lib/failures/envelope");
    const failure = policyRefusal(
      {
        ok: false,
        code: "subscription_paused",
        reason: "this organisation's subscription is paused",
      },
      { requestId: "req-dialling-access" },
    );
    expect(failure.status).toBe(409);
    expect(failure.body.code).toBe("policy_precondition");
  });

  test("the newest mirror row decides, not the first one written", async () => {
    // A tenant can cancel and then re-subscribe. Reading `findMany()[0]` without
    // an order, or reading `subscription.canceled`'s row forever after, would
    // keep a paid tenant blocked on a state they have already left.
    await seedSubscription(
      STALE_ORG,
      `sub_old_${RUN}`,
      "canceled",
      new Date("2026-01-01T00:00:00Z"),
    );
    await seedSubscription(STALE_ORG, `sub_new_${RUN}`, "active", new Date("2026-09-01T00:00:00Z"));
    expect(await currentSubscription(STALE_ORG)).toMatchObject({
      subscriptionId: `sub_new_${RUN}`,
      status: "active",
    });
    expect(await mayDialFor(STALE_ORG)).toBe(true);
  });
});

describe("the webhook that keeps the rule's input current", () => {
  test("paused, past_due and resumed are handled, mirrored, and believed", async () => {
    // The customer arrives first, exactly as it does in life: the subscription's
    // FK is what makes an out-of-order mirror impossible.
    await handlePaddleEvent(
      "customer.created",
      { id: `ctm_mirror_${RUN}`, email: "mirror@example.test", name: "Mirror Gate" },
      { orgId: ACTIVE_ORG },
    );

    for (const [event, status] of [
      ["subscription.paused", "paused"],
      ["subscription.past_due", "past_due"],
      ["subscription.resumed", "active"],
    ] as const) {
      expect(isHandledEvent(event), event).toBe(true);

      const res = await handlePaddleEvent(
        event,
        {
          id: `sub_direct_${RUN}`,
          status,
          customer_id: `ctm_mirror_${RUN}`,
          items: [{ price: { id: "pri_test", product: { id: "pro_test" } } }],
        },
        { orgId: ACTIVE_ORG },
      );
      expect(res.handled, event).toBe(true);

      const row = await db.paddleSubscription.findUnique({
        where: { subscriptionId: `sub_direct_${RUN}` },
        select: { status: true, orgId: true },
      });
      expect(row?.status, event).toBe(status);
      // The mirror is written under OUR tenancy, not anything the payload claimed.
      expect(row?.orgId).toBe(ACTIVE_ORG);
    }
  }, 60_000);

  test("a mirrored pause reaches the dial gate", async () => {
    // The end-to-end shape of the bug this slice fixes: the webhook wrote the row
    // and nothing read it. Asserting the handler and the reader separately would
    // still pass with the two never connected, so this drives the real sequence —
    // an event in, then the question the gate asks.
    await handlePaddleEvent(
      "customer.created",
      { id: `ctm_live_${RUN}`, email: "live@example.test", name: null },
      { orgId: MIRRORED_ORG },
    );
    expect(await mayDialFor(MIRRORED_ORG)).toBe(true);

    await handlePaddleEvent(
      "subscription.paused",
      {
        id: `sub_live_${RUN}`,
        status: "paused",
        customer_id: `ctm_live_${RUN}`,
        items: [{ price: { id: "pri_growth", product: { id: "pro_growth" } } }],
      },
      { orgId: MIRRORED_ORG },
    );
    expect(await mayDialFor(MIRRORED_ORG)).toBe(false);

    await handlePaddleEvent(
      "subscription.resumed",
      {
        id: `sub_live_${RUN}`,
        status: "active",
        customer_id: `ctm_live_${RUN}`,
        items: [{ price: { id: "pri_growth", product: { id: "pro_growth" } } }],
      },
      { orgId: MIRRORED_ORG },
    );
    expect(await mayDialFor(MIRRORED_ORG)).toBe(true);
  }, 60_000);

  test("a paused delivery is accepted as ITSELF, and a broken one is refused by name", () => {
    // Both directions, because a schema can fail this rule two ways. Accepting a
    // malformed `subscription.paused` as "generic, not ours" leaves the tenant's
    // state stale behind a 200 — the bug this slice fixes. Refusing a WELL-FORMED
    // one is worse: the route 400s, Paddle retries for days, and no tenant ever
    // appears paused while the dialler keeps calling. The second test is the one a
    // schema wired only to `KNOWN_PADDLE_EVENT_TYPES` would silently fail.
    expect(KNOWN_PADDLE_EVENT_TYPES).toContain("subscription.paused");

    const good = validatePaddleWebhook({
      event_id: "evt_03aaaaaaaaaaaaaaaaaaaaaaaaa",
      event_type: "subscription.paused",
      occurred_at: "2026-10-11T09:00:00+00:00",
      data: { id: "sub_01aaaaaaaaaaaaaaaaaaaaaaa", status: "paused" },
    });
    expect(good.ok).toBe(true);
    if (!good.ok) throw new Error(`paused delivery refused: ${JSON.stringify(good.issues)}`);
    expect(isKnownPaddleEvent(good.event)).toBe(true);

    const res = validatePaddleWebhook({
      event_id: "evt_03ddddddddddddddddddddddddd",
      event_type: "subscription.paused",
      occurred_at: "2026-10-11T09:00:00+00:00",
      data: {},
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("a paused event with no subscription id was accepted");
    expect(res.issues.map((i) => i.path)).toContain("data.id");
  });
});
