/**
 * `src/lib/payments/mirror.ts` — the Paddle mirror, at the database.
 *
 * The file's own comment says idempotency is the whole design, and that claim is
 * testable directly: Paddle delivers AT-LEAST-ONCE and may deliver OUT OF ORDER,
 * so every write must be an upsert keyed on Paddle's id. An insert-first design
 * fails on the unique index the moment an event is re-sent, which is exactly what
 * these tests assert does not happen.
 *
 * The other property worth pinning is the one that is easy to break silently:
 * the `update` branch of `mirrorCustomer` deliberately does NOT write `orgId`.
 * A later event naming a different org is a bug, not an update — and a blind
 * `update: { ...input }` would move a paid subscription to another tenant.
 *
 * Runs against a real database, the same as `tests/tenancy/*`. Two orgs, so the
 * "never crosses orgs" assertions have something to cross.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { db } from "@/lib/db";
import { mirrorCustomer, mirrorSubscription, paddleCustomerIdFor } from "@/lib/payments/mirror";

const ORG_A = "0a1a0a0a-0000-4000-8000-000000000001";
const ORG_B = "0b1b0b0b-0000-4000-8000-000000000002";

const CUSTOMER = "ctm_mirror_gate_001";
const CUSTOMER_B = "ctm_mirror_gate_002";
const SUBSCRIPTION = "sub_mirror_gate_001";

beforeAll(async () => {
  // Two tenant rows, because several assertions below are about a mirror row
  // staying in the org that bought it.
  for (const id of [ORG_A, ORG_B]) {
    await db.organization.upsert({
      where: { id },
      create: {
        id,
        name: `Paddle mirror gate ${id.slice(0, 8)}`,
        slug: `mirror-gate-${id.slice(0, 8)}`,
        createdAt: new Date("2026-10-10T00:00:00.000Z"),
      },
      update: {},
    });
  }
}, 30_000);

afterAll(async () => {
  const orgs = {
    in: [
      ORG_A,
      ORG_B,
      "0c1c0c0c-0000-4000-8000-000000000003",
      "0e1e0e0e-0000-4000-8000-000000000005",
    ],
  };
  // Children before the tenant row: PaddleSubscription references
  // PaddleCustomer.customerId ON DELETE CASCADE, but explicit is clearer here
  // and the order survives a cascade being changed later.
  await db.paddleSubscription.deleteMany({ where: { orgId: orgs } });
  await db.paddleCustomer.deleteMany({ where: { orgId: orgs } });
  await db.organization.deleteMany({ where: { id: orgs } });
}, 30_000);

describe("mirrorCustomer", () => {
  test("a re-delivered customer is a NO-OP, not a duplicate row or a crash", async () => {
    const input = {
      customerId: CUSTOMER,
      orgId: ORG_A,
      email: "mirror@example.test",
      name: "Mirror Gate",
    };
    await mirrorCustomer(input);
    await mirrorCustomer(input);
    await mirrorCustomer(input);

    const rows = await db.paddleCustomer.findMany({
      where: { customerId: CUSTOMER },
      select: { id: true, email: true },
    });
    // Three deliveries, ONE row. Without the upsert this is a unique-index
    // violation on the third call and a 500 in the webhook handler.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe("mirror@example.test");
  });

  test("the update branch writes email and name but NEVER orgId", async () => {
    // The invariant that makes the mirror safe: the org that bought owns the
    // row. An event naming another org is a bug, and this assertion is what
    // turns that into a test rather than a comment.
    await mirrorCustomer({
      customerId: CUSTOMER,
      orgId: ORG_B,
      email: "attacker@example.test",
      name: "Renamed",
    });
    const row = await db.paddleCustomer.findUnique({
      where: { customerId: CUSTOMER },
      select: { orgId: true, email: true, name: true },
    });
    expect(row?.orgId).toBe(ORG_A);
    expect(row?.email).toBe("attacker@example.test");
    expect(row?.name).toBe("Renamed");
  });

  test("an empty customerId, orgId or email is a TypeError, not a silent write", async () => {
    // An org-less mirror row is an orphan: `paddleCustomerIdFor` could not
    // resolve it, so a subscription would exist that no portal can open.
    await expect(
      mirrorCustomer({ customerId: "", orgId: ORG_A, email: "x@example.test" }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      mirrorCustomer({ customerId: "ctm_x", orgId: "", email: "x@example.test" }),
    ).rejects.toThrow(/without an org is an orphan/);
    await expect(
      mirrorCustomer({ customerId: "ctm_x", orgId: ORG_A, email: "" }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("a null name is stored as null, not 'null'", async () => {
    await mirrorCustomer({
      customerId: "ctm_mirror_gate_named",
      orgId: ORG_A,
      email: "noname@example.test",
      name: null,
    });
    const row = await db.paddleCustomer.findUnique({
      where: { customerId: "ctm_mirror_gate_named" },
      select: { name: true },
    });
    expect(row?.name).toBeNull();
  });
});

describe("mirrorSubscription", () => {
  test("A MISSING customer gets a placeholder, not a failure", async () => {
    // `subscription.created` can arrive before its `customer.created`. The
    // subscription is the fact that matters, so the placeholder is written and
    // reconciled later by the event that carries a real email.
    await mirrorSubscription({
      subscriptionId: "sub_mirror_gate_orphan",
      customerId: "ctm_mirror_gate_orphan",
      orgId: ORG_A,
      status: "active",
      priceId: "pri_mirror_gate",
      productId: "pro_mirror_gate",
    });
    const placeholder = await db.paddleCustomer.findUnique({
      where: { customerId: "ctm_mirror_gate_orphan" },
      select: { orgId: true, email: true },
    });
    expect(placeholder?.orgId).toBe(ORG_A);
    expect(placeholder?.email).toBe("");

    const sub = await db.paddleSubscription.findUnique({
      where: { subscriptionId: "sub_mirror_gate_orphan" },
      select: { status: true },
    });
    expect(sub?.status).toBe("active");
  });

  test("a re-delivered subscription is a NO-OP", async () => {
    const input = {
      subscriptionId: SUBSCRIPTION,
      customerId: CUSTOMER,
      orgId: ORG_A,
      status: "trialing",
      priceId: "pri_mirror_gate",
      productId: "pro_mirror_gate",
    };
    await mirrorSubscription(input);
    await mirrorSubscription(input);
    await mirrorSubscription(input);
    const rows = await db.paddleSubscription.findMany({
      where: { subscriptionId: SUBSCRIPTION },
      select: { id: true, status: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("trialing");
  });

  test("an UPDATE after a CANCELLED row is applied — Paddle's own ordering answer", async () => {
    // This is the case the file's comment calls dangerous and says outright: a
    // `subscription.updated` carrying `active` arriving late WILL overwrite
    // `canceled`. Documented, not hidden, and pinned so the decision is
    // deliberate — a future monotonic-status rule would be a change HERE.
    await mirrorSubscription({
      subscriptionId: SUBSCRIPTION,
      customerId: CUSTOMER,
      orgId: ORG_A,
      status: "canceled",
      priceId: "pri_mirror_gate",
      productId: "pro_mirror_gate",
    });
    await mirrorSubscription({
      subscriptionId: SUBSCRIPTION,
      customerId: CUSTOMER,
      orgId: ORG_A,
      status: "active",
      priceId: "pri_mirror_gate",
      productId: "pro_mirror_gate",
    });
    const row = await db.paddleSubscription.findUnique({
      where: { subscriptionId: SUBSCRIPTION },
      select: { status: true },
    });
    expect(row?.status).toBe("active");
  });

  test("a CLEARED scheduled change is written as null, not left stale", async () => {
    // The exact bug `undefined` would cause: `scheduledChangeAction ?? null`
    // clears it, `scheduledChangeAction ?? undefined` would keep the stale
    // "pause" and revoke a customer who resumed.
    const at = new Date("2026-11-01T00:00:00.000Z");
    await mirrorSubscription({
      subscriptionId: SUBSCRIPTION,
      customerId: CUSTOMER,
      orgId: ORG_A,
      status: "active",
      priceId: "pri_mirror_gate",
      productId: "pro_mirror_gate",
      scheduledChangeAction: "pause",
      scheduledChangeAt: at,
    });
    const withScheduled = await db.paddleSubscription.findUnique({
      where: { subscriptionId: SUBSCRIPTION },
      select: { scheduledChangeAction: true, scheduledChangeAt: true },
    });
    expect(withScheduled?.scheduledChangeAction).toBe("pause");
    expect(withScheduled?.scheduledChangeAt?.toISOString()).toBe(at.toISOString());

    await mirrorSubscription({
      subscriptionId: SUBSCRIPTION,
      customerId: CUSTOMER,
      orgId: ORG_A,
      status: "active",
      priceId: "pri_mirror_gate",
      productId: "pro_mirror_gate",
    });
    const cleared = await db.paddleSubscription.findUnique({
      where: { subscriptionId: SUBSCRIPTION },
      select: { scheduledChangeAction: true, scheduledChangeAt: true },
    });
    expect(cleared?.scheduledChangeAction).toBeNull();
    expect(cleared?.scheduledChangeAt).toBeNull();
  });

  test("empty ids are TypeErrors", async () => {
    await expect(
      mirrorSubscription({
        subscriptionId: "",
        customerId: CUSTOMER,
        orgId: ORG_A,
        status: "active",
        priceId: "p",
        productId: "x",
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      mirrorSubscription({
        subscriptionId: "sub_x",
        customerId: "",
        orgId: ORG_A,
        status: "active",
        priceId: "p",
        productId: "x",
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("paddleCustomerIdFor", () => {
  // A dedicated org and customer for this block. The org-scoped assertions above
  // create several customers in ORG_A, so asserting on ORG_A here would make
  // this block depend on what ran before it.
  //
  // Every test below CREATES what it reads, immediately before reading it. A
  // `beforeAll` that writes and tests that read is a window another file's
  // `afterAll` cleanup can land in — and it does, when `tests/billing/billing.test.ts`
  // runs in the same process and truncates the mirror. CI runs each file in its
  // own process, so this is belt-and-braces; it costs nothing.
  const ORG_C = "0c1c0c0c-0000-4000-8000-000000000003";
  const SOLO = "ctm_mirror_gate_solo";
  // A SECOND org for the ordering test only, and that separation is the fix for
  // a flake that CI caught twice. `paddleCustomerIdFor` orders by createdAt desc,
  // and a row written by `mirrorCustomer` carries `now()`. Any hard-coded
  // "later" date LIES about which is newer the moment the clock passes it — first
  // with a June date on a CI runner in October, then with the `SOLO` row above
  // beating it. An org with only fixed-date rows removes the clock from the
  // comparison entirely.
  const ORG_D = "0e1e0e0e-0000-4000-8000-000000000005";

  beforeAll(async () => {
    for (const id of [ORG_C, ORG_D]) {
      await db.organization.upsert({
        where: { id },
        create: {
          id,
          name: `Paddle mirror gate ${id.slice(0, 8)}`,
          slug: `mirror-gate-${id.slice(0, 8)}`,
          createdAt: new Date("2026-10-10T00:00:00.000Z"),
        },
        update: {},
      });
    }
  }, 30_000);

  test("resolves the org's own customer id", async () => {
    await mirrorCustomer({ customerId: SOLO, orgId: ORG_C, email: "solo@example.test" });
    expect(await paddleCustomerIdFor(ORG_C)).toBe(SOLO);
  });

  test("does NOT resolve another org's customer", async () => {
    // The portal route mints a URL for whatever this returns, so a cross-org hit
    // here is a cross-org portal.
    await mirrorCustomer({ customerId: SOLO, orgId: ORG_C, email: "solo@example.test" });
    const forA = await paddleCustomerIdFor(ORG_A);
    expect(forA).not.toBe(SOLO);
    expect(forA === null || forA.startsWith("ctm_")).toBe(true);
  });

  test("an org with no mirror row is null", async () => {
    expect(await paddleCustomerIdFor(ORG_B)).toBeNull();
    expect(await paddleCustomerIdFor("0d1d0d0d-0000-4000-8000-000000000004")).toBeNull();
  });

  test("the LATEST customer wins when an org has several", async () => {
    // `paddleCustomerIdFor` orders by createdAt desc, which is what makes the
    // portal open the account that bought most recently rather than the first
    // one ever recorded.
    //
    // This test is on ORG_D, an org NOTHING else writes to, and both rows carry
    // fixed dates. Both of those are load-bearing, and CI caught it twice:
    //
    //   * the first version wrote FIRST through `mirrorCustomer` (`now()`) and a
    //     hard-coded SECOND in the past, so "latest" resolved to whichever was
    //     later in wall-clock terms;
    //   * the second version fixed both dates but kept them on ORG_C, where the
    //     test above writes a `now()` row — which beat them both.
    //
    // A dedicated org plus fixed dates removes the clock from the comparison
    // entirely, and removes the TIMESTAMP(3) hazard of two rows in the same
    // millisecond comparing equal.
    const FIRST = "ctm_mirror_gate_order_first";
    const SECOND = "ctm_mirror_gate_order_second";
    // `upsert` rather than `create`: the ids are fixed, so a re-run after a
    // cleanup that did not happen would otherwise fail on the unique index
    // rather than testing anything.
    await db.paddleCustomer.upsert({
      where: { customerId: FIRST },
      create: {
        customerId: FIRST,
        orgId: ORG_D,
        email: "first@example.test",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      update: { orgId: ORG_D, createdAt: new Date("2026-01-01T00:00:00.000Z") },
    });
    await db.paddleCustomer.upsert({
      where: { customerId: SECOND },
      create: {
        customerId: SECOND,
        orgId: ORG_D,
        email: "second@example.test",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      update: { orgId: ORG_D, createdAt: new Date("2026-06-01T00:00:00.000Z") },
    });
    expect(await paddleCustomerIdFor(ORG_D)).toBe(SECOND);
  });
});
