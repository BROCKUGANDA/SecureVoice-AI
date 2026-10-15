/**
 * THE EVIDENCE A PAYMENT PATH CAN LOSE, IT MUST BE ABLE TO REBUILD.
 *
 * Two properties, both against the real chain writer and the real database:
 *
 * ## 1. A redelivery repairs the record an outage destroyed
 *
 * `money-audit-loss.test.ts` proves that a settlement whose append failed
 * answers 500 and keeps Paddle retrying. The retry is only worth the design if
 * it actually restores the evidence, and the honest problem is that a replay
 * cannot describe itself usefully: the second delivery truthfully reports
 * `applied: false, unitsCredited: 0`, so a chain that records only the replay
 * would hold "a payment we cannot prove" and a row that says nothing was
 * credited.
 *
 * So the settled facts are recovered from the row the failed attempt wrote —
 * `PaymentRecord` is the primary record, and it survived — and re-filed as a
 * `payment_settled` entry marked `reconstructed`. Marked, not disguised: the
 * chain never claims it watched money arrive.
 *
 * ## 2. A real payment reference does not silently fall off the chain
 *
 * `audit-chain` truncates `callRef` to 64 characters instead of rejecting it,
 * and `buildReference()` produces `org_<uuid>_<purpose>_<ULID>` — 66+
 * characters. `PAY-<reference>` therefore loses its ULID tail on write, and a
 * verifier querying the string it believes it stored matches ZERO rows, which
 * `verifyChain` reports as `{ ok: true, rows: 0 }`. Money moving with no
 * evidence and a green checkmark saying otherwise is the exact failure this
 * path exists to close, so it is pinned here rather than explained in a comment:
 * the reference goes through `moneyChainRef()`, which hashes the overflow, and
 * the naive lookup is asserted to find nothing so the trap stays visible.
 *
 *   bun scripts/run-tests.mjs money-audit-repair
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { verifyChain } from "@/lib/audit-chain";
import { balance } from "@/lib/billing/ledger";
import { settlePayment, encodeEntitlements, type StoredEntitlement } from "@/lib/payments/provider";
import { auditMoney, moneyChainRef } from "@/lib/payments/audit";
import { buildReference } from "@/lib/payments/paddle";

const RUN = Date.now().toString(36);
const HEX = (Date.now().toString(16) + "0".repeat(12)).slice(0, 12);
const ORG = `55555555-5555-4555-8555-${HEX}`;

/** A payment that settled while the chain was down: money committed, no rows. */
const ORPHAN = `AUD_ORPHAN_${RUN}`;
/** A real-shaped reference — 66+ characters — for the truncation case. */
const LONG = buildReference(ORG, "topup");

const ENTITLEMENTS: StoredEntitlement[] = [{ key: "manual_units", units: 250 }];

beforeAll(async () => {
  await db.organization.create({
    data: {
      id: ORG,
      name: `repair-${RUN}`,
      slug: `repair-${RUN}`,
      createdAt: new Date(),
      credits: 1_000,
    },
  });
  // The state an outage leaves behind, written directly rather than mocked:
  // a successful PaymentRecord whose audit append never landed.
  await db.paymentRecord.create({
    data: {
      id: `pay_orphan_${RUN}`,
      orgId: ORG,
      provider: "paddle",
      reference: ORPHAN,
      amountMinor: 7_500,
      currency: "USD",
      status: "success",
      verifiedAt: new Date(),
      verifiedBy: "gateway",
      entitlementsJson: encodeEntitlements({
        version: 1,
        entitlements: ENTITLEMENTS,
        eventId: `evt_orphan_${RUN}`,
      }),
      createdAt: new Date(),
    },
  });
}, 60_000);

afterAll(async () => {
  await db.paymentRecord.deleteMany({ where: { reference: { in: [ORPHAN, LONG] } } });
  await db.auditLog.deleteMany({
    where: { callRef: { in: [moneyChainRef(ORPHAN), moneyChainRef(LONG)] } },
  });
  await db.usageLedger.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}, 60_000);

function metaOf(row: { meta: unknown } | undefined): Record<string, unknown> {
  if (!row) return {};
  if (typeof row.meta === "string") {
    try {
      return JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (row.meta ?? {}) as Record<string, unknown>;
}

describe("a redelivery repairs the record an outage destroyed", () => {
  test("the settled facts come back off the payment row and are marked as recovered", async () => {
    // Nothing recorded yet — the precondition the repair keys on.
    expect(await db.auditLog.count({ where: { callRef: moneyChainRef(ORPHAN) } })).toBe(0);

    const walletBefore = await db.organization.findUniqueOrThrow({
      where: { id: ORG },
      select: { credits: true },
    });
    const ledgerBefore = await balance(ORG);

    const replay = await settlePayment({
      provider: "paddle",
      orgId: ORG,
      reference: ORPHAN,
      money: { amountMinor: 7_500, currency: "USD" },
      status: "success",
      eventId: `evt_orphan_${RUN}`,
      entitlements: ENTITLEMENTS,
      verifiedBy: "gateway",
    });

    expect(replay.applied).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.auditRecorded).toBe(true);

    const rows = await db.auditLog.findMany({
      where: { callRef: moneyChainRef(ORPHAN) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const intents = rows.map((r) => r.intent);
    // BOTH halves of the truth: the replay that arrived, and the credit that had
    // already happened and had no record of it.
    expect(intents).toContain("payment_settlement_replay");
    expect(intents).toContain("payment_settled");

    const settled = rows.find((r) => r.intent === "payment_settled");
    const m = metaOf(settled);
    expect(m.reconstructed).toBe(true);
    expect(m.amountMinor).toBe(7_500);
    expect(m.currency).toBe("USD");
    // Read back from the payment's own envelope — the 250 units the first
    // attempt credited, not the 7,500 minor units the customer was charged.
    expect(m.unitsCredited).toBe(250);

    // The repair describes money; it does not move any.
    const walletAfter = await db.organization.findUniqueOrThrow({
      where: { id: ORG },
      select: { credits: true },
    });
    expect(walletAfter.credits).toBe(walletBefore.credits);
    expect(await balance(ORG)).toBe(ledgerBefore);

    const chain = await verifyChain(moneyChainRef(ORPHAN), ORG);
    expect(chain.ok).toBe(true);
    expect(chain.rows).toBe(2);
  }, 60_000);

  test("a second redelivery does not reconstruct the same record twice", async () => {
    const again = await settlePayment({
      provider: "paddle",
      orgId: ORG,
      reference: ORPHAN,
      money: { amountMinor: 7_500, currency: "USD" },
      status: "success",
      eventId: `evt_orphan_${RUN}`,
      entitlements: ENTITLEMENTS,
      verifiedBy: "gateway",
    });
    expect(again.applied).toBe(false);

    const settledCount = await db.auditLog.count({
      where: { callRef: moneyChainRef(ORPHAN), intent: "payment_settled" },
    });
    expect(settledCount).toBe(1);
    // The chain still verifies, with the replay rows appended in order.
    expect((await verifyChain(moneyChainRef(ORPHAN), ORG)).ok).toBe(true);
  }, 60_000);
});

describe("a real-length payment reference stays on the chain", () => {
  test("the stored callRef is the one a verifier can find", () => {
    // The trap, stated as data: the naive key is longer than the chain's
    // ceiling, so it cannot be what was stored.
    expect(`PAY-${LONG}`.length).toBeGreaterThan(64);
    const canonical = moneyChainRef(LONG);
    expect(canonical).not.toBe(`PAY-${LONG}`);
    expect(canonical.length).toBe(64);
    // Deterministic — two processes must file and find the same record.
    expect(moneyChainRef(LONG)).toBe(canonical);
    // Short references are untouched, so the `PAY-<bankRef>` scheme WP-13
    // asserts is unchanged.
    expect(moneyChainRef("INV-4471")).toBe("PAY-INV-4471");
  });

  test("settlement under a long reference is verifiable, not silently empty", async () => {
    const result = await settlePayment({
      provider: "paddle",
      orgId: ORG,
      reference: LONG,
      money: { amountMinor: 12_000, currency: "USD" },
      status: "success",
      eventId: `evt_long_${RUN}`,
      entitlements: [{ key: "manual_units", units: 75 }],
      verifiedBy: "gateway",
    });
    expect(result.applied).toBe(true);
    expect(result.auditRecorded).toBe(true);

    // The proof is that the lookup the product performs finds rows. An
    // `verifyChain` over zero rows also reports `ok: true`, which is precisely
    // how a broken scheme passes a green check.
    const canonical = moneyChainRef(LONG);
    const chain = await verifyChain(canonical, ORG);
    expect(chain.ok).toBe(true);
    expect(chain.rows).toBeGreaterThanOrEqual(1);

    const stored = await db.auditLog.findMany({ where: { callRef: canonical } });
    expect(stored.length).toBe(1);
    expect(metaOf(stored[0]).amountMinor).toBe(12_000);

    // And the naive key finds nothing — kept as an assertion so a future edit
    // that reverts to `PAY-${reference}` cannot make this case pass quietly.
    expect(await db.auditLog.count({ where: { callRef: `PAY-${LONG}` } })).toBe(0);
  }, 60_000);

  test("two long references from one org do not collapse onto one chain", async () => {
    const sibling = buildReference(ORG, "overage");
    const distinct = moneyChainRef(LONG) !== moneyChainRef(sibling);
    expect(distinct).toBe(true);

    const recorded = await auditMoney({
      reference: sibling,
      orgId: ORG,
      actor: "test",
      intent: "payment_recorded",
      detail: "sibling reference",
      meta: { sibling: true },
    });
    expect(recorded).toBe(true);

    const asLeft = await db.auditLog.count({ where: { callRef: moneyChainRef(LONG) } });
    const asRight = await db.auditLog.count({
      where: { callRef: moneyChainRef(sibling), intent: "payment_recorded" },
    });
    expect(asLeft).toBe(1);
    expect(asRight).toBe(1);

    await db.auditLog.deleteMany({ where: { callRef: moneyChainRef(sibling) } });
  }, 60_000);
});
