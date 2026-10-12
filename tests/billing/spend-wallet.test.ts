/**
 * THE SPEND WALLET IS FUNDED BY WHAT THE CUSTOMER BOUGHT, NOT BY THE PRICE
 * (checklist #204).
 *
 * Two balances exist and only one of them is spent. `UsageLedger` is the
 * append-only audit trail; `Organization.credits` is the wallet `deductCredit`
 * actually consults when an intervention is about to fire. Settlement used to
 * write `money.amountMinor + entitlement units` into the ledger as "units" and
 * touch the wallet not at all, so a $99 payment booked 9,900 units and the
 * institution still could not place a call. Money and intervention credits are
 * different denominations; nothing converts one into the other.
 *
 * Proven here against the real Postgres, with the real `settlePayment` and the
 * real `refundPayment`:
 *
 *   1. A settlement credits the entitlement's allowance, funds the wallet by
 *      exactly that, and the wallet is NOT the payment amount.
 *   2. A payment carrying no units and no `plan:` token credits NOTHING — it is
 *      a charge (an overage settlement), not a purchase of units. This is the
 *      case the old code got wrong in the loudest possible way.
 *   3. A replayed webhook moves neither balance twice.
 *   4. Ledger and wallet move TOGETHER or NOT AT ALL: a settlement whose wallet
 *      update fails leaves no ledger row behind, and a rolled-back settlement
 *      emits no revenue event.
 *   5. A refund reverses the UNITS it credited, read back from the payment
 *      envelope, and mirrors into the wallet.
 *   6. A ledger-only synthetic org id (no `organization` row; the shape the
 *      rest of the billing suite uses) records its ledger movement and skips the
 *      wallet instead of throwing — so this fix cannot turn a test-shaped org id
 *      into a failed settlement.
 *   7. Revenue is recognised AFTER the commit, exactly once per settlement.
 *
 * `@/lib/analytics` is replaced with a capture: the transport is fire-and-forget
 * and batches to a real PostHog host when `POSTHOG_KEY` is set, and an assertion
 * about "emitted after commit" cannot be made against a call that returns before
 * the network does.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";
import { balance } from "@/lib/billing/ledger";
import { unitsForPlan } from "@/lib/payments/overage";
import { settlePayment, refundPayment, type StoredEntitlement } from "@/lib/payments/provider";

const revenueCalls: Record<string, unknown>[] = [];
const usageCalls: Record<string, unknown>[] = [];
const subscriptionCalls: Record<string, unknown>[] = [];

mock.module("@/lib/analytics", () => ({
  revenueRecognised: (props: Record<string, unknown>) => void revenueCalls.push(props),
  usageSummarised: (props: Record<string, unknown>) => void usageCalls.push(props),
  subscriptionChanged: (props: Record<string, unknown>) => void subscriptionCalls.push(props),
  interventionAccepted: () => {},
  interventionRefused: () => {},
  riskBand: () => "low",
}));

const RUN = Date.now().toString(36);

/** Deterministic UUID v4-shaped ids, so `organization.id` (@db.Uuid) accepts them. */
function uuid(slot: number): string {
  const h = createHash("sha256").update(`${RUN}:${slot}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const bought = uuid(1); // the tenant that buys a plan
const overage = uuid(2); // the tenant that pays a charge with no units
const synthetic = `org-synthetic-${RUN}`; // no organization row at all

async function wallet(id: string): Promise<number> {
  const row = await db.organization.findUnique({ where: { id }, select: { credits: true } });
  if (!row) throw new Error(`organization ${id} is missing`);
  return row.credits;
}

beforeAll(async () => {
  for (const id of [bought, overage]) {
    await db.organization.create({
      data: {
        id,
        name: `Wallet ${id.slice(0, 8)}`,
        slug: `wallet-${RUN}-${id.slice(0, 8)}`,
        createdAt: new Date(),
        credits: 0,
      },
    });
  }
});

afterAll(async () => {
  // Clean up this run's rows only. The ledger is append-only by trigger, so the
  // movements stay; every row keyed to these org ids is removed first.
  await db.paymentRecord.deleteMany({ where: { orgId: { in: [bought, overage, synthetic] } } });
  await db.usageLedger.deleteMany({ where: { orgId: { in: [bought, overage, synthetic] } } });
  await db.organization.deleteMany({ where: { id: { in: [bought, overage] } } });
});

function settle(
  orgId: string,
  reference: string,
  opts: {
    amountMinor?: number;
    entitlements?: StoredEntitlement[];
    eventId?: string;
  } = {},
) {
  return settlePayment({
    provider: "paddle",
    orgId,
    reference,
    money: { amountMinor: opts.amountMinor ?? 9_900, currency: "USD" },
    status: "success",
    eventId: opts.eventId ?? `evt_${reference}`,
    entitlements: opts.entitlements ?? [{ key: "plan:starter" }],
  });
}

describe("a settlement funds the wallet the platform spends", () => {
  test("the plan allowance lands in both balances, and the price lands in neither", async () => {
    const res = await settle(bought, `${RUN}-buy-1`, {
      amountMinor: 9_900,
      entitlements: [{ key: "platform_licence", units: 250 }],
    });

    expect(res.applied).toBe(true);
    expect(res.unitsCredited).toBe(250);
    // The two balances agree, which is the entire point of #204.
    expect(await wallet(bought)).toBe(250);
    expect(await balance(bought)).toBe(250);
    // And neither is the money: 9,900 minor units bought 250 credits.
    expect(await wallet(bought)).not.toBe(9_900);
    expect(await balance(bought)).not.toBe(9_900);
  });

  test("a minted `plan:` token with no explicit units credits that plan's allowance", async () => {
    // This is the shape Paddle's checkout actually carries: the plan id is
    // anchored at mint time and the allowance is looked up at settlement.
    const before = await wallet(bought);
    const res = await settle(bought, `${RUN}-buy-2`, {
      amountMinor: 4_900,
      entitlements: [{ key: "plan:growth" }],
    });

    expect(res.unitsCredited).toBe(unitsForPlan("growth"));
    expect(res.unitsCredited).toBeGreaterThan(0);
    expect(await wallet(bought)).toBe(before + unitsForPlan("growth"));
  });

  test("a payment with no units and no plan token credits NOTHING", async () => {
    // The loudest half of the old bug: `reduce(acc, e => acc + (e.units ?? 0),
    // money.amountMinor)` SEEDS with the price, so an overage settlement — a
    // charge that buys no allowance at all — booked its minor units as credits.
    const before = await wallet(overage);
    const res = await settle(overage, `${RUN}-charge-1`, {
      amountMinor: 120_000,
      entitlements: [{ key: "overage_settlement" }],
    });

    expect(res.unitsCredited).toBe(0);
    expect(await wallet(overage)).toBe(before);
    expect(await balance(overage)).toBe(0);
  });

  test("a replayed webhook moves neither balance twice and credits nothing again", async () => {
    const reference = `${RUN}-replay`;
    const first = await settle(bought, reference, { entitlements: [{ key: "plan:starter" }] });
    const afterFirst = await wallet(bought);
    const ledgerAfterFirst = await balance(bought);

    // Same reference, same event id: the delivery Twilio… Paddle retries.
    const replay = await settle(bought, reference, { entitlements: [{ key: "plan:starter" }] });

    expect(first.applied).toBe(true);
    expect(replay.applied).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.unitsCredited).toBe(0);
    expect(await wallet(bought)).toBe(afterFirst);
    expect(await balance(bought)).toBe(ledgerAfterFirst);
    // One ledger row and one payment row for two deliveries: the replay is
    // idempotent all the way down, not merely non-crediting.
    expect(await db.usageLedger.count({ where: { orgId: bought, kind: "topup" } })).toBe(
      await db.paymentRecord.count({ where: { orgId: bought, status: "success" } }),
    );
  });

  test("a ledger-only synthetic org id records the movement and skips the wallet", async () => {
    // `Organization.id` is a UUID column while the ledger keys on a String that
    // also accepts synthetic ids. Funding the wallet against a non-row would
    // throw and poison the whole settlement, so the increment is gated and the
    // ledger still writes.
    const res = await settle(synthetic, `${RUN}-synthetic`, {
      entitlements: [{ key: "platform_licence", units: 90 }],
    });

    expect(res.applied).toBe(true);
    expect(res.unitsCredited).toBe(90);
    expect(await balance(synthetic)).toBe(90);
    // Cast to text: `organization.id` is a uuid column, so binding a synthetic
    // id through the typed client throws P2007 — which is precisely the failure
    // the UUID gate above exists to avoid.
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::int AS n FROM "organization" WHERE "id"::text = ${synthetic}
    `;
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe("the wallet and the ledger fail together, never apart", () => {
  test("a settlement whose wallet update cannot land leaves no ledger row", async () => {
    // A UUID org id with no organization row: the increment hits a foreign key /
    // missing row and the whole transaction rolls back. The invariant is that
    // `available` and `credits` never disagree — so neither may exist alone.
    const ghost = uuid(99);
    let threw = false;
    try {
      await settle(ghost, `${RUN}-ghost`, {
        entitlements: [{ key: "platform_licence", units: 500 }],
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(await balance(ghost)).toBe(0);
    expect(await db.usageLedger.count({ where: { orgId: ghost } })).toBe(0);
    expect(await db.paymentRecord.count({ where: { reference: `${RUN}-ghost` } })).toBe(0);
  });

  test("a rolled-back settlement recognises no revenue", async () => {
    // Its own org id: the ledger is append-only and shared, so another test's
    // movements would make `balance` non-zero here for reasons that have
    // nothing to do with the rollback being clean.
    const ghost = uuid(98);
    const before = revenueCalls.length;
    await expect(
      settle(ghost, `${RUN}-ghost-2`, { entitlements: [{ key: "platform_licence", units: 500 }] }),
    ).rejects.toThrow();
    expect(revenueCalls.length, "a settlement that never committed emitted a revenue event").toBe(
      before,
    );
    expect(await balance(ghost)).toBe(0);
    expect(await db.paymentRecord.count({ where: { reference: `${RUN}-ghost-2` } })).toBe(0);
  });
});

describe("a refund reverses what was credited, in both balances", () => {
  test("the wallet falls by the units credited, never by the price", async () => {
    const reference = `${RUN}-refund`;
    await settle(bought, reference, {
      amountMinor: 9_900,
      entitlements: [{ key: "plan:starter" }],
    });

    const before = await wallet(bought);
    const beforeLedger = await balance(bought);

    const res = await refundPayment({
      provider: "paddle",
      reference,
      money: { amountMinor: 9_900, currency: "USD" },
      eventId: `evt_${reference}:refund`,
    });

    expect(res.applied).toBe(true);
    const credited = unitsForPlan("starter");
    expect(await wallet(bought)).toBe(before - credited);
    expect(await balance(bought)).toBe(beforeLedger - credited);
    // The price is not the reversal amount.
    expect(await wallet(bought)).not.toBe(before - 9_900);
  });

  test("refunding twice reverses once", async () => {
    const reference = `${RUN}-refund-twice`;
    await settle(bought, reference, { entitlements: [{ key: "platform_licence", units: 60 }] });
    const afterBuy = await wallet(bought);

    const first = await refundPayment({
      provider: "paddle",
      reference,
      money: { amountMinor: 1_000, currency: "USD" },
      eventId: `evt_${reference}:refund:1`,
    });
    const second = await refundPayment({
      provider: "paddle",
      reference,
      money: { amountMinor: 1_000, currency: "USD" },
      eventId: `evt_${reference}:refund:2`,
    });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(await wallet(bought)).toBe(afterBuy - 60);
  });
});

describe("revenue is recognised once, after the commit", () => {
  test("a settled payment emits exactly one event carrying the settled total", async () => {
    const before = revenueCalls.length;
    await settle(bought, `${RUN}-revenue`, {
      amountMinor: 25_000,
      entitlements: [{ key: "plan:enterprise" }],
    });

    expect(revenueCalls.length - before).toBe(1);
    const props = revenueCalls[revenueCalls.length - 1]!;
    expect(props.revenueMinor).toBe(25_000);
    expect(props.currency).toBe("USD");
    expect(props.orgId).toBe(bought);
    expect(props.kind).toBe("new_sale");
    expect(props.source).toBe("transaction_completed");
    // The plan id is carried, not the price id, and not an unknown string.
    expect(props.plan).toBe("enterprise");
  });

  test("a replay emits no second event", async () => {
    const reference = `${RUN}-revenue-replay`;
    await settle(bought, reference, { entitlements: [{ key: "plan:starter" }] });
    const before = revenueCalls.length;
    await settle(bought, reference, { entitlements: [{ key: "plan:starter" }] });
    expect(revenueCalls.length).toBe(before);
  });

  test("the emit sits after the transaction, not merely after its last write", () => {
    // The behavioural tests above cannot reach the case that matters: a failure
    // AT COMMIT (deadlock, serialisation, a dropped connection) happens after
    // every statement in the callback, so an emit placed inside it would already
    // have fired. Only placement proves placement — the same way the structural
    // gates in tests/contracts read a handler's source.
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "lib", "payments", "provider.ts"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const txEnd = src.indexOf("{ maxWait: 30_000, timeout: 30_000 },\n  );");
    expect(
      txEnd,
      "the settlement transaction's terminator moved — this gate is stale",
    ).toBeGreaterThan(-1);
    expect(
      src.slice(0, txEnd),
      "revenue is recognised inside the transaction: a commit failure would book revenue that never happened",
    ).not.toContain("revenueRecognised(");
    expect(src.slice(txEnd)).toContain("revenueRecognised(");
    // And the facts are CAPTURED inside it, so what is emitted is what settled.
    expect(src.slice(0, txEnd)).toContain("pending.revenue = {");
  });
});
