/**
 * Overage rating and invoice raising.
 *
 * The properties worth pinning are the ones that would otherwise only show up on
 * a customer's invoice: that the arithmetic is integer-exact, that a refund
 * cannot produce a negative bill, that an unconfigured rate refuses instead of
 * guessing, and that raising the same period twice produces one document.
 *
 * Runs against the real database (UsageLedger is a real table and the unique
 * index on PaymentRecord.reference is the idempotency mechanism, so a fake
 * would not exercise either).
 *
 *   bun test tests/billing/overage.test.ts
 */
import { test, expect, afterAll, describe } from "bun:test";
import { db } from "@/lib/db";
import {
  summariseOverage,
  raiseOverageInvoice,
  overageInvoiceReference,
} from "@/lib/payments/overage";

const ORG = `ovg-test-${Date.now().toString(36)}`;
// Anchored to now, NOT to fixed calendar dates. UsageLedger.createdAt defaults
// to the current timestamp, so a hardcoded window would silently exclude every
// fixture and the ranking would assert 0 === 0 — a green test proving nothing.
// `TO` sits just ahead of now so rows written during the test fall inside.
const NOW = new Date();
const TO = new Date(NOW.getTime() + 60_000);
const FROM = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

/** UsageLedger.idemKey is unique, so each fixture needs its own key. */
let seq = 0;
async function addUsage(args: { kind: string; units: number }) {
  seq += 1;
  await db.usageLedger.create({
    data: {
      orgId: ORG,
      caseRef: `CASE-${seq}`,
      kind: args.kind,
      units: args.units,
      idemKey: `${ORG}:${seq}:${args.kind}`,
    },
  });
}

async function clearUsage() {
  await db.usageLedger.deleteMany({ where: { orgId: ORG } });
  await db.paymentRecord.deleteMany({ where: { orgId: ORG } });
}

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterAll(async () => {
  await clearUsage();
  setEnv("OVERAGE_RATE_MINOR_PER_UNIT", undefined);
  setEnv("INCLUDED_UNITS_PER_PERIOD", undefined);
  await db.$disconnect();
});

describe("usage ranking", () => {
  test("consume minus release is the net, and the bundle is subtracted once", async () => {
    await clearUsage();
    await addUsage({ kind: "consume", units: 120 });
    await addUsage({ kind: "consume", units: 30 });
    await addUsage({ kind: "release", units: 20 });
    setEnv("INCLUDED_UNITS_PER_PERIOD", "100");
    setEnv("OVERAGE_RATE_MINOR_PER_UNIT", "150");

    const r = await summariseOverage({ orgId: ORG, periodFrom: FROM, periodTo: TO });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 120 + 30 - 20 = 130 net, 100 included, so 30 billable at 150 minor each.
    expect(r.summary.netUsedUnits).toBe(130);
    expect(r.summary.billableOverageUnits).toBe(30);
    expect(r.summary.amountMinor).toBe(4500);
    expect(r.summary.currency).toBe("AED");
  });

  test("usage inside the bundle bills nothing", async () => {
    await clearUsage();
    await addUsage({ kind: "consume", units: 40 });
    setEnv("INCLUDED_UNITS_PER_PERIOD", "100");

    const r = await summariseOverage({ orgId: ORG, periodFrom: FROM, periodTo: TO });
    expect(r.ok && r.summary.billableOverageUnits).toBe(0);
    expect(r.ok && r.summary.amountMinor).toBe(0);
  });

  test("a refund larger than the consume clamps at zero instead of going negative", async () => {
    // A negative invoice is a credit note wearing a bill's clothes, so the
    // clamp is the assertion, not an implementation detail.
    await clearUsage();
    await addUsage({ kind: "consume", units: 10 });
    await addUsage({ kind: "refund", units: 25 });
    setEnv("INCLUDED_UNITS_PER_PERIOD", "0");

    const r = await summariseOverage({ orgId: ORG, periodFrom: FROM, periodTo: TO });
    expect(r.ok && r.summary.netUsedUnits).toBe(0);
    expect(r.ok && r.summary.billableOverageUnits).toBe(0);
    expect(r.ok && r.summary.amountMinor).toBe(0);
  });

  test("usage outside the window is not counted", async () => {
    await clearUsage();
    seq += 1;
    await db.usageLedger.create({
      data: {
        orgId: ORG,
        caseRef: "CASE-OLD",
        kind: "consume",
        units: 500,
        idemKey: `${ORG}:old:consume`,
        createdAt: new Date(FROM.getTime() - 24 * 60 * 60 * 1000),
      },
    });
    setEnv("INCLUDED_UNITS_PER_PERIOD", "100");
    const r = await summariseOverage({ orgId: ORG, periodFrom: FROM, periodTo: TO });
    expect(r.ok && r.summary.netUsedUnits).toBe(0);
  });

  test("an unconfigured rate reports rateConfigured=false rather than assuming zero", async () => {
    await clearUsage();
    await addUsage({ kind: "consume", units: 500 });
    setEnv("OVERAGE_RATE_MINOR_PER_UNIT", undefined);
    setEnv("INCLUDED_UNITS_PER_PERIOD", "10");

    const r = await summariseOverage({ orgId: ORG, periodFrom: FROM, periodTo: TO });
    expect(r.ok && r.summary.rateConfigured).toBe(false);
  });

  test("an inverted period is refused rather than silently swapped", async () => {
    const r = await summariseOverage({
      orgId: ORG,
      periodFrom: TO,
      periodTo: FROM,
    });
    expect(r).toEqual({ ok: false, reason: "invalid_period" });
  });
});

describe("raising the invoice", () => {
  test("refuses when no rate is configured, naming the missing variable", async () => {
    await clearUsage();
    await addUsage({ kind: "consume", units: 500 });
    setEnv("INCLUDED_UNITS_PER_PERIOD", "10");
    setEnv("OVERAGE_RATE_MINOR_PER_UNIT", undefined);

    const r = await raiseOverageInvoice({
      orgId: ORG,
      periodFrom: FROM,
      periodTo: TO,
      recordedBy: "op-a",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("rate_not_configured");
    expect(r.detail).toContain("OVERAGE_RATE_MINOR_PER_UNIT");
    // Nothing may be written when the price is unknown.
    expect(await db.paymentRecord.count({ where: { orgId: ORG } })).toBe(0);
  });

  test("refuses when the period is inside the bundle", async () => {
    await clearUsage();
    await addUsage({ kind: "consume", units: 5 });
    setEnv("INCLUDED_UNITS_PER_PERIOD", "100");
    setEnv("OVERAGE_RATE_MINOR_PER_UNIT", "150");

    const r = await raiseOverageInvoice({
      orgId: ORG,
      periodFrom: FROM,
      periodTo: TO,
      recordedBy: "op-a",
    });
    expect(!r.ok && r.reason).toBe("nothing_to_bill");
    expect(await db.paymentRecord.count({ where: { orgId: ORG } })).toBe(0);
  });

  test("raises once, and a re-raise returns the same document instead of billing twice", async () => {
    await clearUsage();
    await addUsage({ kind: "consume", units: 300 });
    setEnv("INCLUDED_UNITS_PER_PERIOD", "100");
    setEnv("OVERAGE_RATE_MINOR_PER_UNIT", "150");

    const first = await raiseOverageInvoice({
      orgId: ORG,
      periodFrom: FROM,
      periodTo: TO,
      recordedBy: "op-a",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.duplicate).toBe(false);
    expect(first.amount.amountMinor).toBe(30000);

    const second = await raiseOverageInvoice({
      orgId: ORG,
      periodFrom: FROM,
      periodTo: TO,
      recordedBy: "op-b",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.duplicate).toBe(true);
    expect(second.paymentId).toBe(first.paymentId);
    expect(second.reference).toBe(first.reference);

    // The actual guarantee: one row, not two bills.
    expect(await db.paymentRecord.count({ where: { orgId: ORG } })).toBe(1);
    // Generous timeout: this test performs two invoice writes, a uniqueness
    // probe and an audit append against a remote database. Bun's 5s default is
    // a local-filesystem assumption and this suite runs against a host with a
    // ~280ms round trip, so the default would fail on latency, not on logic.
  }, 30_000);

  test("the raised invoice starts pending and grants no entitlement", async () => {
    await clearUsage();
    await addUsage({ kind: "consume", units: 300 });
    setEnv("INCLUDED_UNITS_PER_PERIOD", "100");
    setEnv("OVERAGE_RATE_MINOR_PER_UNIT", "150");

    const r = await raiseOverageInvoice({
      orgId: ORG,
      periodFrom: FROM,
      periodTo: TO,
      recordedBy: "op-a",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const row = await db.paymentRecord.findUnique({ where: { reference: r.reference } });
    expect(row?.status).toBe("pending");
    // An overage is a charge. Empty entitlements is what stops settlement from
    // crediting wallet units for money the bank owes us.
    const env = JSON.parse(row!.entitlementsJson!) as {
      entitlements: unknown[];
      purpose: string;
      recordedBy: string;
    };
    expect(env.entitlements).toEqual([]);
    expect(env.purpose).toBe("overage");
    expect(env.recordedBy).toBe("op-a");
  });

  test("the reference is deterministic for the same period", () => {
    const a = overageInvoiceReference({ orgId: ORG, periodFrom: FROM, periodTo: TO });
    const b = overageInvoiceReference({ orgId: ORG, periodFrom: FROM, periodTo: TO });
    expect(a).toBe(b);
    expect(a).toContain(ORG);
  });
});
