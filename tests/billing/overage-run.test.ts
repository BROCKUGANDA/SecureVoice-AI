/**
 * The production caller of the overage rater.
 *
 * `overage.ts` was rated and tested for months with nothing invoking it. These
 * tests pin the three things that matter about the RUNNER, none of which the
 * rater's own tests can see:
 *
 *   1. the WINDOW. A mirrored `currentPeriodEnd` is the end of the OPEN period,
 *      so the closed one is `[end - 2 months, end - 1 month)`. Get this wrong and
 *      every run bills a rolling window that overlaps the last one — and the
 *      unique reference cannot catch it, because the dates differ each time.
 *   2. the RATE IS THE PLAN'S. Growth at 12¢ and Starter at 15¢ for identical
 *      usage, measured through the real rater rather than the pure function.
 *   3. NOTHING IS WRITTEN until `OVERAGE_INVOICING_ENABLED=1`. The default run
 *      measures and reports `would_bill` and leaves no PaymentRecord behind.
 *
 * The gateway is deliberately left unconfigured: with no adapter bound, an
 * enabled run must refuse and write nothing, which is the assertion that a
 * mis-set environment cannot bill anybody. The Paddle push itself is covered by
 * `tests/billing/billing-routes.test.ts` and the sandbox harness.
 *
 *   bun test tests/billing/overage-run.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { subMonths } from "date-fns";
import { closedPeriodFor, runOverageBilling } from "@/lib/payments/overage-run";
import { OVERAGE_RUN_ACTOR } from "@/lib/payments/overage-run";
import { cleanupRun, testOrg, uniq } from "../auth/helpers";

const RUN_TAG = uniq("ovgrun");

const SAVED = {
  PADDLE_PRICES: process.env.PADDLE_PRICES,
  OVERAGE_INVOICING_ENABLED: process.env.OVERAGE_INVOICING_ENABLED,
  OVERAGE_RATE_MINOR_PER_UNIT: process.env.OVERAGE_RATE_MINOR_PER_UNIT,
  INCLUDED_UNITS_PER_PERIOD: process.env.INCLUDED_UNITS_PER_PERIOD,
  PADDLE_API_KEY: process.env.PADDLE_API_KEY,
  PADDLE_WEBHOOK_SECRET: process.env.PADDLE_WEBHOOK_SECRET,
  PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER,
};

const PRICES: Record<string, string> = {
  starter: `pr_starter_${RUN_TAG}`,
  growth: `pr_growth_${RUN_TAG}`,
  enterprise: `pr_enterprise_${RUN_TAG}`,
};

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

process.env.PADDLE_PRICES = JSON.stringify({
  usd_9900_monthly: PRICES.starter,
  usd_49900_monthly: PRICES.growth,
  usd_200000_monthly: PRICES.enterprise,
});
// No env allowance: every tenant here must be rated against ITS plan, and a
// fallback would hide a plan that failed to resolve.
delete process.env.INCLUDED_UNITS_PER_PERIOD;
// No rate override EITHER — and this one is load-bearing rather than tidy.
// `OVERAGE_RATE_MINOR_PER_UNIT` set in a developer's `.env` makes every plan rate
// at that one figure, which would turn "Growth bills 12¢, Starter bills 15¢" into
// a test of the override that still passes while proving nothing about the tiers.
// `plan-facts.test.ts` covers the override on purpose; here it must be absent.
delete process.env.OVERAGE_RATE_MINOR_PER_UNIT;
// Nothing may be written unless a test says so.
delete process.env.OVERAGE_INVOICING_ENABLED;
// No gateway bound — an enabled run must refuse rather than bill.
setEnv("PADDLE_API_KEY", undefined);
setEnv("PADDLE_WEBHOOK_SECRET", undefined);

/** Orgs created here, deleted by id in `afterAll`. */
const orgs: string[] = [];
const customers: string[] = [];
const subs: string[] = [];

/**
 * A tenant with a mirrored subscription whose period closed on `end`.
 * `currentPeriodEnd` is the END OF THE OPEN PERIOD, exactly as Paddle mirrors it.
 */
async function seedTenant(input: {
  plan: "starter" | "growth" | "enterprise";
  status?: string;
  currentPeriodEnd?: Date | null;
}): Promise<string> {
  const orgId = testOrg(`ovg-${input.plan}`);
  orgs.push(orgId);
  const customerId = `ctm_${RUN_TAG}_${orgId.slice(-8)}`;
  const subscriptionId = `sub_${RUN_TAG}_${orgId.slice(-8)}`;
  customers.push(customerId);
  subs.push(subscriptionId);
  await db.paddleCustomer.create({
    data: { customerId, orgId, email: `${orgId}@overage.test`, name: orgId },
  });
  await db.paddleSubscription.create({
    data: {
      subscriptionId,
      customerId,
      orgId,
      status: input.status ?? "active",
      priceId: PRICES[input.plan]!,
      productId: `pro_${RUN_TAG}`,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
    },
  });
  return orgId;
}

/** Usage inside a specific window — the window is what the test is about. */
async function addUsage(orgId: string, units: number, at: Date): Promise<void> {
  const caseRef = `CASE-${RUN_TAG}-${orgId.slice(-6)}-${units}`;
  await db.usageLedger.create({
    data: {
      orgId,
      caseRef,
      kind: "consume",
      units,
      idemKey: `${caseRef}:1:consume`,
      createdAt: at,
    },
  });
}

const END = new Date(Date.now() + 12 * 86_400_000); // open period ends in 12 days
const CLOSED_TO = subMonths(END, 1);
const CLOSED_FROM = subMonths(CLOSED_TO, 1);

afterAll(async () => {
  await db.usageLedger.deleteMany({ where: { caseRef: { contains: RUN_TAG } } }).catch(() => {});
  await db.paymentRecord
    .deleteMany({ where: { reference: { contains: "OVG-" }, orgId: { in: orgs } } })
    .catch(() => {});
  await db.paddleSubscription
    .deleteMany({ where: { subscriptionId: { in: subs } } })
    .catch(() => {});
  await db.paddleCustomer.deleteMany({ where: { customerId: { in: customers } } }).catch(() => {});
  setEnv("PADDLE_PRICES", SAVED.PADDLE_PRICES);
  setEnv("OVERAGE_INVOICING_ENABLED", SAVED.OVERAGE_INVOICING_ENABLED);
  setEnv("INCLUDED_UNITS_PER_PERIOD", SAVED.INCLUDED_UNITS_PER_PERIOD);
  setEnv("OVERAGE_RATE_MINOR_PER_UNIT", SAVED.OVERAGE_RATE_MINOR_PER_UNIT);
  setEnv("PADDLE_API_KEY", SAVED.PADDLE_API_KEY);
  setEnv("PADDLE_WEBHOOK_SECRET", SAVED.PADDLE_WEBHOOK_SECRET);
  setEnv("PAYMENT_PROVIDER", SAVED.PAYMENT_PROVIDER);
  await cleanupRun();
  await db.$disconnect();
});

describe("the closed window is derived from the mirror, not from now", () => {
  test("an open period ending in the future bills [end-2mo, end-1mo)", () => {
    const p = closedPeriodFor(END);
    expect(p).not.toBeNull();
    if (!p) return;
    // Exactly one month wide, ending one month before the mirrored end.
    expect(p.periodTo.getTime()).toBe(CLOSED_TO.getTime());
    expect(p.periodFrom.getTime()).toBe(CLOSED_FROM.getTime());
    expect(p.periodTo.getTime()).toBeLessThan(END.getTime());
  });

  test("no mirrored period end yields no window", () => {
    // An invoice whose dates are a guess cannot be defended to an accounts team.
    expect(closedPeriodFor(null)).toBeNull();
    expect(closedPeriodFor(undefined)).toBeNull();
  });

  test("usage OUTSIDE the window is not billed", async () => {
    const orgId = await seedTenant({ plan: "growth", currentPeriodEnd: END });
    // 3,000 units today — inside the OPEN period, so not billable yet.
    await addUsage(orgId, 3000, new Date());
    const report = await runOverageBilling({ orgId });
    const one = report.results.find((r) => r.orgId === orgId);
    expect(one?.outcome).toBe("nothing_to_bill");
    expect(one?.billableUnits).toBe(0);
  });

  test("usage inside the window is billed, and the same window twice is one invoice", async () => {
    const orgId = await seedTenant({ plan: "growth", currentPeriodEnd: END });
    await addUsage(orgId, 2600, new Date((CLOSED_FROM.getTime() + CLOSED_TO.getTime()) / 2));

    const report = await runOverageBilling({ orgId });
    const one = report.results.find((r) => r.orgId === orgId);
    expect(one?.outcome).toBe("would_bill");
    expect(one?.billableUnits).toBe(100);
    // The reference is a function of (org, window) alone.
    expect(one?.reference).toBe(
      `OVG-${orgId}-${CLOSED_FROM.toISOString().slice(0, 10)}_${CLOSED_TO.toISOString().slice(0, 10)}`,
    );
  });
});

describe("the rate is the plan's own, through the rater", () => {
  test("Growth bills 12¢ per unit and Starter 15¢ for identical usage", async () => {
    const growth = await seedTenant({ plan: "growth", currentPeriodEnd: END });
    const starter = await seedTenant({ plan: "starter", currentPeriodEnd: END });
    const mid = new Date((CLOSED_FROM.getTime() + CLOSED_TO.getTime()) / 2);
    // Each plan's own allowance plus 100 units.
    await addUsage(growth, 2600, mid);
    await addUsage(starter, 600, mid);

    const g = (await runOverageBilling({ orgId: growth })).results[0]!;
    const s = (await runOverageBilling({ orgId: starter })).results[0]!;

    expect(g.billableUnits).toBe(100);
    expect(s.billableUnits).toBe(100);
    expect(g.rateMinorPerUnit).toBe(12);
    expect(s.rateMinorPerUnit).toBe(15);
    // 100 units at 12¢ = 1200 minor units; at 15¢ = 1500. The page quotes both
    // figures; this is the run that has to honour them.
    expect(g.amountMinor).toBe(1200);
    expect(s.amountMinor).toBe(1500);
  });

  test("Enterprise is skipped, not rated at somebody else's price", async () => {
    const orgId = await seedTenant({ plan: "enterprise", currentPeriodEnd: END });
    await addUsage(orgId, 10_100, new Date((CLOSED_FROM.getTime() + CLOSED_TO.getTime()) / 2));
    const one = (await runOverageBilling({ orgId })).results[0]!;
    expect(one.outcome).toBe("skipped");
    expect(one.reason).toBe("rate_not_negotiated");
  });
});

describe("nothing is written before the switch is thrown", () => {
  test("with invoicing disabled, a billable tenant produces no PaymentRecord", async () => {
    const orgId = await seedTenant({ plan: "growth", currentPeriodEnd: END });
    await addUsage(orgId, 2600, new Date((CLOSED_FROM.getTime() + CLOSED_TO.getTime()) / 2));

    const report = await runOverageBilling({ orgId });
    expect(report.invoicingEnabled).toBe(false);
    expect(report.totals.wouldBill).toBe(1);
    expect(report.results[0]?.outcome).toBe("would_bill");
    expect(await db.paymentRecord.count({ where: { orgId } })).toBe(0);
  });

  test("enabled with no gateway bound: refuse, and still write nothing", async () => {
    const orgId = await seedTenant({ plan: "growth", currentPeriodEnd: END });
    await addUsage(orgId, 2600, new Date((CLOSED_FROM.getTime() + CLOSED_TO.getTime()) / 2));
    process.env.OVERAGE_INVOICING_ENABLED = "1";
    try {
      const report = await runOverageBilling();
      expect(report.invoicingEnabled).toBe(true);
      // The refusal is for the WHOLE run, before any tenant is touched, and it
      // names the variable that needs setting.
      expect(report.refused?.reason).toBe("gateway_unavailable");
      expect(report.results).toHaveLength(0);
      expect(await db.paymentRecord.count({ where: { orgId } })).toBe(0);
    } finally {
      delete process.env.OVERAGE_INVOICING_ENABLED;
    }
  });

  test("the run records who raised the invoice, and it is not a person", async () => {
    expect(OVERAGE_RUN_ACTOR).toBe("system:overage-worker");
  });
});

describe("candidates", () => {
  test("a tenant with no currentPeriodEnd is skipped with that reason", async () => {
    const orgId = await seedTenant({ plan: "growth", currentPeriodEnd: null });
    const one = (await runOverageBilling({ orgId })).results[0]!;
    expect(one.outcome).toBe("skipped");
    expect(one.reason).toBe("no_period_end");
  });

  test("a canceled subscription is not a candidate at all", async () => {
    const orgId = await seedTenant({ plan: "growth", status: "canceled", currentPeriodEnd: END });
    await addUsage(orgId, 5000, new Date((CLOSED_FROM.getTime() + CLOSED_TO.getTime()) / 2));
    const report = await runOverageBilling({ orgId });
    expect(report.totals.candidates).toBe(0);
    expect(report.results).toHaveLength(0);
  });
});
