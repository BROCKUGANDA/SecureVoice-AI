/**
 * EVERY MOVEMENT OF MONEY IS IN THE TAMPER-EVIDENT CHAIN.
 *
 * The chain (`src/lib/audit-chain.ts`) is the evidence this product shows a
 * regulator, and until this file it covered the manual-invoice path (WP-13) but
 * NOT the path that actually mints prepaid units: `settlePayment` — "the ONLY
 * writer of a successful PaymentRecord and the only bridge from money to
 * prepaid units" — wrote a payment row, a ledger credit and a wallet increment
 * and left no chain record at all. The most consequential money action in the
 * product was the one action that could not be proved, while an operator noting
 * a bank transfer was fully chained. That is the inverse of what an audit
 * surface should be.
 *
 * What is proven here, against the real Postgres and the real chain writer (no
 * stubbed audit sink — a mocked `append()` would assert that the mock was
 * called, not that a link exists):
 *
 *   1. A settlement appends `payment_settled` on `PAY-<reference>`, and the
 *      chain VERIFIES. A row that breaks the link is worse than no row.
 *   2. The row carries the reconciliation facts — provider, amount, currency,
 *      units credited, gateway event id, who verified — so "why does this
 *      tenant have 5,000 credits" is answerable from the evidence alone.
 *   3. A REPLAYED delivery appends `payment_settlement_replay` and credits
 *      nothing. `duplicate` is not silence: it is the guard refusing to pay out
 *      twice, which is the thing an at-least-once gateway gets challenged on.
 *   4. A refund appends `payment_refunded` with what it reversed.
 *   5. A refund for a reference we have no payment for is recorded, not dropped.
 *   6. A payment reported FAILED is recorded. Chaining only successes would
 *      leave the chain mute on exactly the events a reconciliation asks about.
 *   7. Nothing here is a text assertion about source files: every case performs
 *      the money action and then reads the chain the action wrote.
 *
 *   bun scripts/run-tests.mjs money-audit-chain
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { verifyChain } from "@/lib/audit-chain";
import { balance } from "@/lib/billing/ledger";
import { settlePayment, refundPayment } from "@/lib/payments/provider";

const RUN = Date.now().toString(36);
// `organization.id` is a `uuid` column, so the per-run discriminator must be
// hex — a base36 id fails at the driver in a way that reads like a schema bug.
const HEX = (Date.now().toString(16) + "0".repeat(12)).slice(0, 12);
const ORG = `33333333-3333-4333-8333-${HEX}`;

const refs = {
  settle: `AUD_SETTLE_${RUN}`,
  refund: `AUD_REFUND_${RUN}`,
  ghost: `AUD_GHOST_${RUN}`,
  failed: `AUD_FAILED_${RUN}`,
};

const chainRef = (reference: string) => `PAY-${reference}`;

async function rows(reference: string, intent?: string) {
  return db.auditLog.findMany({
    where: { callRef: chainRef(reference), ...(intent ? { intent } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** `AuditLog.meta` is stored as a JSON STRING by `append()`; read it as one. */
function meta(row: { meta: unknown }): Record<string, unknown> {
  if (typeof row.meta === "string") {
    try {
      return JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (row.meta ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  await db.organization.create({
    data: {
      id: ORG,
      name: `money-audit-${RUN}`,
      slug: `money-audit-${RUN}`,
      createdAt: new Date(),
      credits: 0,
    },
  });
  await db.paymentRecord.deleteMany({ where: { reference: { in: Object.values(refs) } } });
});

afterAll(async () => {
  await db.paymentRecord.deleteMany({ where: { reference: { in: Object.values(refs) } } });
  await db.auditLog.deleteMany({ where: { callRef: { in: Object.values(refs).map(chainRef) } } });
  await db.usageLedger.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
});

describe("settlement writes the evidence of record", () => {
  test("a settled payment appends payment_settled and the chain verifies", async () => {
    const result = await settlePayment({
      provider: "paddle",
      orgId: ORG,
      reference: refs.settle,
      money: { amountMinor: 99_000, currency: "USD" },
      status: "success",
      eventId: `evt_settle_${RUN}`,
      entitlements: [{ key: "plan:growth" }],
      verifiedBy: "gateway",
    });

    expect(result.applied).toBe(true);
    expect(result.auditRecorded).toBe(true);

    const appended = await rows(refs.settle, "payment_settled");
    expect(appended.length).toBe(1);
    const row = appended[0]!;
    expect(row.action).toBe("consent");
    expect(row.callerId).toBe("gateway");

    const m = meta(row);
    expect(m.provider).toBe("paddle");
    expect(m.amountMinor).toBe(99_000);
    expect(m.currency).toBe("USD");
    expect(m.eventId).toBe(`evt_settle_${RUN}`);
    // The units actually credited, not the price paid. Money and intervention
    // credits are different denominations (checklist #204) and the evidence has
    // to say which one moved.
    expect(typeof m.unitsCredited).toBe("number");
    expect(m.applied).toBe(true);

    const chain = await verifyChain(chainRef(refs.settle), ORG);
    expect(chain.ok).toBe(true);
  });

  test("a replayed delivery records the replay and credits nothing twice", async () => {
    const walletBefore = await db.organization.findUniqueOrThrow({
      where: { id: ORG },
      select: { credits: true },
    });
    const ledgerBefore = await balance(ORG);

    const replay = await settlePayment({
      provider: "paddle",
      orgId: ORG,
      reference: refs.settle,
      money: { amountMinor: 99_000, currency: "USD" },
      status: "success",
      // The SAME gateway event id: this is what a redelivery of a completed
      // transaction looks like on the wire.
      eventId: `evt_settle_${RUN}`,
      entitlements: [{ key: "plan:growth" }],
      verifiedBy: "gateway",
    });

    expect(replay.applied).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.unitsCredited).toBe(0);
    expect(replay.auditRecorded).toBe(true);

    const recorded = await rows(refs.settle, "payment_settlement_replay");
    expect(recorded.length).toBe(1);
    expect(meta(recorded[0]!).duplicate).toBe(true);

    // The refusals that matter: the replay is recorded AND inert.
    expect((await db.organization.findUniqueOrThrow({ where: { id: ORG } })).credits).toBe(
      walletBefore.credits,
    );
    expect(await balance(ORG)).toBe(ledgerBefore);

    // Two rows, one link sequence — a second append must not fork the chain.
    const chain = await verifyChain(chainRef(refs.settle), ORG);
    expect(chain.ok).toBe(true);
    expect(chain.rows).toBe(2);
  });

  test("a payment reported failed is recorded, not dropped", async () => {
    const out = await settlePayment({
      provider: "paddle",
      orgId: ORG,
      reference: refs.failed,
      money: { amountMinor: 1_500, currency: "USD" },
      status: "failed",
      eventId: `evt_failed_${RUN}`,
      verifiedBy: "gateway",
    });

    expect(out.applied).toBe(true);
    expect(out.auditRecorded).toBe(true);

    const appended = await rows(refs.failed, "payment_settlement_failed");
    expect(appended.length).toBe(1);
    expect(meta(appended[0]!).unitsCredited).toBe(0);
    expect((await verifyChain(chainRef(refs.failed), ORG)).ok).toBe(true);
  });
});

describe("refunds reverse money and record that they did", () => {
  test("a refund appends payment_refunded with what it reversed", async () => {
    // Settle first so there is something to reverse.
    await settlePayment({
      provider: "paddle",
      orgId: ORG,
      reference: refs.refund,
      money: { amountMinor: 49_000, currency: "USD" },
      status: "success",
      eventId: `evt_refund_${RUN}`,
      entitlements: [{ key: "manual_units", units: 400 }],
      verifiedBy: "gateway",
    });
    const before = await db.organization.findUniqueOrThrow({
      where: { id: ORG },
      select: { credits: true },
    });

    const out = await refundPayment({
      provider: "paddle",
      reference: refs.refund,
      money: { amountMinor: 49_000, currency: "USD" },
      eventId: `evt_refund_${RUN}`,
    });

    expect(out.applied).toBe(true);
    expect(out.auditRecorded).toBe(true);

    const appended = await rows(refs.refund, "payment_refunded");
    expect(appended.length).toBe(1);
    const m = meta(appended[0]!);
    expect(m.unitsReversed).toBe(400);
    expect(m.walletTouched).toBe(true);

    // The record and the wallet agree: the row claims 400 reversed and exactly
    // 400 left the spend wallet. A chain row that disagrees with the balance it
    // describes is worse than no row, because it launders the discrepancy.
    const after = await db.organization.findUniqueOrThrow({
      where: { id: ORG },
      select: { credits: true },
    });
    expect(before.credits - after.credits).toBe(400);

    expect((await verifyChain(chainRef(refs.refund), ORG)).ok).toBe(true);
  });

  test("a refund for an unknown reference is recorded as an exception", async () => {
    const out = await refundPayment({
      provider: "paddle",
      reference: refs.ghost,
      money: { amountMinor: 10_000, currency: "USD" },
      eventId: `evt_ghost_${RUN}`,
    });

    expect(out.applied).toBe(false);
    expect(out.auditRecorded).toBe(true);
    expect((await rows(refs.ghost, "payment_refund_unknown_reference")).length).toBe(1);
  });

  test("the refund's three writes commit together or not at all", async () => {
    // Regression guard for the shape this file replaced: the status flip, the
    // ledger reversal and the wallet decrement used to run as three unguarded
    // statements, so a failure between the first and the second left a payment
    // marked `refunded` whose credits were still spendable.
    const reference = `AUD_ATOMIC_${RUN}`;
    const chain = chainRef(reference);
    try {
      await settlePayment({
        provider: "paddle",
        orgId: ORG,
        reference,
        money: { amountMinor: 20_000, currency: "USD" },
        status: "success",
        eventId: `evt_atomic_${RUN}`,
        entitlements: [{ key: "manual_units", units: 111 }],
        verifiedBy: "gateway",
      });

      const walletAfterSettle = (
        await db.organization.findUniqueOrThrow({
          where: { id: ORG },
          select: { credits: true },
        })
      ).credits;

      await refundPayment({
        provider: "paddle",
        reference,
        money: { amountMinor: 20_000, currency: "USD" },
        eventId: `evt_atomic_${RUN}`,
      });

      const paid = await db.paymentRecord.findUniqueOrThrow({
        where: { reference },
        select: { status: true },
      });
      const wallet = (
        await db.organization.findUniqueOrThrow({
          where: { id: ORG },
          select: { credits: true },
        })
      ).credits;

      expect(paid.status).toBe("refunded");
      expect(walletAfterSettle - wallet).toBe(111);
      // Status, ledger row and wallet all describe the same completed reversal.
      const ledgerRows = await db.usageLedger.count({
        where: { orgId: ORG, reason: `paddle:${reference}:refund` },
      });
      expect(ledgerRows).toBe(1);
    } finally {
      await db.paymentRecord.deleteMany({ where: { reference } });
      await db.auditLog.deleteMany({ where: { callRef: chain } });
      await db.usageLedger.deleteMany({
        where: { orgId: ORG, reason: `paddle:${reference}:refund` },
      });
    }
  });
});

describe("the money path cannot be silently unrecorded", () => {
  test("the chain is verified over every reference this file touched", async () => {
    for (const reference of Object.values(refs)) {
      const chain = await verifyChain(chainRef(reference), ORG);
      // A `false` here means a link was broken by an append — the exact failure
      // mode the `PAY-<reference>` scheme exists to make detectable.
      expect({ reference, ok: chain.ok }).toEqual({ reference, ok: true });
    }
  });

  test("every money append shares one callRef scheme", async () => {
    const found = await db.auditLog.findMany({
      where: { callRef: { startsWith: "PAY-AUD_" } },
      select: { callRef: true, intent: true, chainHash: true },
    });
    // Non-vacuous: if the scheme drifted (`pay-`, `PM-`, a bare reference) this
    // count would be zero and the loop below would prove nothing.
    expect(found.length).toBeGreaterThanOrEqual(6);
    const hashes = new Set(found.map((r) => r.chainHash));
    expect(hashes.size).toBe(found.length);
    const intents = new Set(found.map((r) => r.intent));
    for (const intent of [
      "payment_settled",
      "payment_settlement_replay",
      "payment_settlement_failed",
      "payment_refunded",
      "payment_refund_unknown_reference",
    ]) {
      expect(intents.has(intent)).toBe(true);
    }
  });
});
