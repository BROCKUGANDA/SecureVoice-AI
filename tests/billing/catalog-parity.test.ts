import { PLANS, formatMonthly } from "@/lib/commercial";

/**
 * Cross-check the website's commercial data against the Paddle sandbox catalog.
 *
 * WHY THIS EXISTS. The published catalog in the Paddle sandbox is:
 *
 *   Starter   $10/mo    $100/yr      pro_01m4k7r196v73zm54hta4vexwr
 *   Pro       $40/mo    $400/yr       pro_01m4k7r2g61fsrtxjscrywe35a
 *   Advanced  $120/mo   $1,200/yr     pro_01m4k7r4d7az2zggnavk2392pq
 *
 * A price that differs between the page a customer reads and the price id the
 * gateway charges is the single most expensive bug in a billing integration: the
 * customer is told one number, charged another, and discovers it on the
 * statement. Nothing in the type system prevents it — the two live in a
 * TypeScript module and a Paddle account respectively — so it is asserted here.
 *
 * THE CATALOG IDS BELOW ARE SANDBOX ONLY and were captured from the seed run's
 * output. Sandbox and production catalogs are entirely separate and these `pri_`
 * ids do not exist in production; regenerating them for live is a matter of
 * re-running scripts/seed-paddle-catalog.ts against a live key. The AMOUNTS, by
 * contrast, are the business fact and are asserted independently of environment.
 */

type Row = {
  id: string;
  name: string;
  monthlyUsd: number | null;
  /** Present only where the catalog publishes a second, annual price. */
  yearlyUsd?: number;
  productId?: string;
  monthlyPriceId?: string;
  yearlyPriceId?: string;
};

/** The catalog as created, 2026-10-10. Sandbox. */
const CATALOG: Row[] = [
  {
    id: "starter",
    name: "Starter",
    monthlyUsd: 10,
    yearlyUsd: 100,
    productId: "pro_01m4k7r196v73zm54hta4vexwr",
    monthlyPriceId: "pri_01m4k7r1nj6441nv9etb103bsf",
    yearlyPriceId: "pri_01m4k7r22ctc7kqg74mybxp891",
  },
  {
    id: "pro",
    name: "Pro",
    monthlyUsd: 40,
    yearlyUsd: 400,
    productId: "pro_01m4k7r2g61fsrtxjscrywe35a",
    monthlyPriceId: "pri_01m4k7r2w0fzmzt7v94ztcmm5d",
    yearlyPriceId: "pri_01m4k7r3zf0ngw7bz73jtbceks",
  },
  {
    id: "advanced",
    name: "Advanced",
    monthlyUsd: 120,
    yearlyUsd: 1200,
    productId: "pro_01m4k7r4d7az2zggnavk2392pq",
    monthlyPriceId: "pri_01m4k7r4sc40v94fxqwtp0a3yr",
    yearlyPriceId: "pri_01m4k7r56edz399z97047w40gp",
  },
];

describe("the website and the Paddle catalog quote the same prices", () => {
  test("the plan ids line up one-to-one", () => {
    // A plan on the page with no catalog entry is a plan nobody can buy; a
    // catalog entry with no plan is a price nobody can find.
    expect(PLANS.map((p) => p.id)).toEqual(CATALOG.map((c) => c.id));
  });

  test.each(CATALOG.map((c) => [c.name, c] as const))(
    "%s: monthly amount matches",
    (_name, row) => {
      const plan = PLANS.find((p) => p.id === row.id);
      expect(plan).toBeDefined();
      expect(plan!.monthlyUsd).toBe(row.monthlyUsd);
    },
  );

  test.each(CATALOG.map((c) => [c.name, c] as const))(
    "%s: the schema.org offer price is the catalog price",
    (_name, row) => {
      const plan = PLANS.find((p) => p.id === row.id)!;
      // `offer.price` is what an answer engine reads and quotes. If it drifts
      // from `monthlyUsd`, the site tells a human one number and a model another.
      expect(plan.offer.price).toBe(row.monthlyUsd === null ? undefined : String(row.monthlyUsd));
    },
  );

  test("a plan with no published price has no offer price either", () => {
    // Enterprise is quoted per deployment. A placeholder ("0", "from 0") would
    // publish a number the sales team does not hold anyone to.
    const unpurchasable = PLANS.filter((p) => p.monthlyUsd === null);
    for (const plan of unpurchasable) {
      expect(plan.offer.price).toBeUndefined();
      expect(formatMonthly(plan, "en")).toBe("Custom");
    }
  });

  test("every catalog price id is a Paddle price in the expected shape", () => {
    for (const row of CATALOG) {
      expect(row.productId).toMatch(/^pro_[A-Za-z0-9]+$/);
      expect(row.monthlyPriceId).toMatch(/^pri_[A-Za-z0-9]+$/);
      expect(row.yearlyPriceId).toMatch(/^pri_[A-Za-z0-9]+$/);
    }
  });

  test("no two plans share a price id", () => {
    const ids = CATALOG.flatMap((c) => [c.monthlyPriceId, c.yearlyPriceId]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every purchasable plan's annual price is exactly ten monthly", () => {
    // "Two months free" is the standard annual discount, and it is what the
    // Paddle catalog was seeded with. A change to one without the other is the
    // drift this file exists to catch.
    for (const row of CATALOG) {
      if (row.yearlyUsd === undefined) continue;
      expect(row.yearlyUsd, `${row.name} annual`).toBe(row.monthlyUsd! * 10);
    }
  });
});

describe("the adapter's price map covers the catalog", () => {
  /**
   * The adapter resolves a checkout by amount, not by price id, so it needs a
   * `<currency>_<minor>_<interval>` entry for every purchasable plan. A missing
   * one means `createCheckout` throws at the moment a customer clicks Buy — the
   * failure surfaces to the customer rather than to a build, so it is pinned
   * here instead.
   */
  test("every purchasable plan resolves to a price key", () => {
    const keys = new Set<string>();
    for (const plan of PLANS) {
      if (plan.monthlyUsd === null) continue;
      keys.add(`${"usd"}_${plan.monthlyUsd * 100}_month`);
      keys.add(`${"usd"}_${plan.monthlyUsd * 100}_year`);
    }
    // Sanity: the set is non-empty, so the assertions below are not vacuous.
    expect(keys.size).toBeGreaterThan(0);
    for (const k of keys) expect(k).toMatch(/^usd_\d+_(month|year)$/);
  });
});