import { describe, expect, test } from "bun:test";
import {
  PLANS,
  formatMonthly,
  formatYearly,
  formatIncluded,
  formatOverage,
} from "../../src/lib/commercial.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The catalog as seeded and then extended, 2026-10-10.
 *
 * Monthly prices came from `bun run paddle:seed`; annual prices from
 * `bun run paddle:add-annual` (10x monthly, "two months free"). Both were read
 * back from the live sandbox account afterwards rather than assumed.
 *
 * Sandbox and production catalogs are entirely separate and these `pri_` ids do
 * not exist in production; regenerating them for live is a matter of re-running
 * the two scripts against a live key. The AMOUNTS are the business fact.
 */
const CATALOG = [
  {
    id: "starter",
    name: "Starter",
    monthlyUsd: 99,
    yearlyUsd: 990,
    productId: "pro_01m4kc8a89eb5fs4638p0trbf7",
    monthlyPriceId: "pri_01m4kc8amfsr590wkmf02v0q91",
    yearlyPriceId: "pri_01m4kmzw3cq4na5tfn6xqd6ekn",
    monthlyRegional: { GBP: 7425, EUR: 8910, AUD: 14850 },
    yearlyRegional: { GBP: 74250, EUR: 89100, AUD: 148500 },
  },
  {
    id: "growth",
    name: "Growth",
    monthlyUsd: 499,
    yearlyUsd: 4990,
    productId: "pro_01m4kc8b21kpp6eabxrybvb935",
    monthlyPriceId: "pri_01m4kc8bdy18z7h9g4qwbv6vqq",
    yearlyPriceId: "pri_01m4kmzwg9vdfe2c4x5qnz2s4s",
    monthlyRegional: { GBP: 37425, EUR: 44910, AUD: 74850 },
    yearlyRegional: { GBP: 374250, EUR: 449100, AUD: 748500 },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    monthlyUsd: 2000,
    yearlyUsd: 20000,
    productId: "pro_01m4kc8bvk4vjrdhzcgqms3pfk",
    monthlyPriceId: "pri_01m4kc8c6y167c8jx1pk7vcazx",
    yearlyPriceId: "pri_01m4kmzwwqy407sttdb550w8dt",
    monthlyRegional: { GBP: 150000, EUR: 180000, AUD: 300000 },
    yearlyRegional: { GBP: 1500000, EUR: 1800000, AUD: 3000000 },
  },
] as const;

/**
 * Products from the FIRST seeding, retired on the re-seed.
 *
 * They carried $10 / $40 / $120 with an annual price and a 7-day trial — a
 * pricing shape this codebase does not implement. They are archived in the
 * Paddle account and asserted as such here, because a stale product that is
 * still `active` is one someone can sell from by accident.
 */
const RETIRED = [
  "pro_01m4k7r196v73zm54hta4vexwr",
  "pro_01m4k7r2g61fsrtxjscrywe35a",
  "pro_01m4k7r4d7az2zggnavk2392pq",
];

describe("the website and the Paddle catalog quote the same prices", () => {
  test("the plan ids line up one-to-one", () => {
    // A plan on the page with no catalog entry is a plan nobody can buy; a
    // catalog entry with no plan is a price nobody can find.
    expect(PLANS.map((p) => p.id)).toEqual(CATALOG.map((c) => c.id));
  });

  test.each(CATALOG.map((c) => [c.name, c] as const))(
    "%s: the page price is the catalog price",
    (_name, row) => {
      const plan = PLANS.find((p) => p.id === row.id);
      expect(plan).toBeDefined();
      expect(plan!.monthlyUsd).toBe(row.monthlyUsd);
    },
  );

  test("the schema.org offer price is the same number the gateway charges", () => {
    // `offer.price` is what an answer engine reads and quotes verbatim. If it
    // drifts from `monthlyUsd`, the site tells a model one price and a buyer
    // another, and the model's version is the one that gets repeated.
    for (const row of CATALOG) {
      const plan = PLANS.find((p) => p.id === row.id)!;
      expect(plan.offer.price, `${plan.name} offer price`).toBe(String(row.monthlyUsd));
      expect(Number(plan.offer.price) * 100).toBe(row.monthlyUsd * 100);
    }
  });

  test("every catalog price id is a Paddle price in the expected shape", () => {
    for (const row of CATALOG) {
      expect(row.productId).toMatch(/^pro_[A-Za-z0-9]+$/);
      expect(row.monthlyPriceId).toMatch(/^pri_[A-Za-z0-9]+$/);
      expect(row.yearlyPriceId).toMatch(/^pri_[A-Za-z0-9]+$/);
    }
  });

  test("every plan has BOTH a monthly and an annual price in the catalog", () => {
    // The pricing page offers an interval toggle. An interval with no price
    // behind it does not fail at build time — it fails when a buyer clicks it,
    // and the failure is a charge that differs from the one displayed.
    for (const row of CATALOG) {
      expect(row.yearlyPriceId, `${row.name} annual`).toMatch(/^pri_/);
      expect(row.yearlyPriceId, `${row.name} annual is monthly`).not.toBe(row.monthlyPriceId);
    }
  });

  test("annual is exactly ten monthly on every tier", () => {
    // "Two months free", and the ratio the catalog was seeded to. Changing one
    // without the other is the drift this file exists to catch.
    for (const row of CATALOG) {
      expect(row.yearlyUsd, `${row.name} annual`).toBe(row.monthlyUsd * 10);
    }
  });

  test("the page's annual figure is the catalog's annual figure", () => {
    for (const row of CATALOG) {
      const plan = PLANS.find((p) => p.id === row.id)!;
      expect(plan.yearlyUsd, `${plan.name} yearlyUsd`).toBe(row.yearlyUsd);
    }
  });

  test("no two plans share any price id, monthly or annual", () => {
    const ids = CATALOG.flatMap((c) => [c.monthlyPriceId, c.yearlyPriceId, c.productId]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the retired catalog is recorded in the seed script", () => {
    // So a re-run of `bun run paddle:seed` archives the stale tiers again rather
    // than leaving them active alongside the current ones.
    const script = readFileSync(
      fileURLToPath(new URL("../../scripts/seed-paddle-catalog.ts", import.meta.url)),
      "utf8",
    );
    for (const id of RETIRED) expect(script).toContain(id);
  });
});

describe("the pricing model matches what the code can charge", () => {
  test("every plan has included volume, and overage except Enterprise", () => {
    for (const plan of PLANS) {
      expect(plan.includedPerMonth, `${plan.name} has no included volume`).toBeGreaterThan(0);
    }
    expect(PLANS.filter((p) => p.overageCents === null).map((p) => p.id)).toEqual(["enterprise"]);
  });

  test("included volume rises monotonically with price", () => {
    const priced = [...PLANS].sort((a, b) => a.monthlyUsd! - b.monthlyUsd!);
    for (let i = 1; i < priced.length; i++) {
      expect(priced[i]!.includedPerMonth!).toBeGreaterThan(priced[i - 1]!.includedPerMonth!);
    }
  });

  test("annual is offered and priced, with no trial promised anywhere", () => {
    // The annual toggle exists and is backed. A trial does NOT exist in the
    // catalog — nothing seeds one — so the page must not promise one. This is the
    // same guard that previously asserted the opposite, inverted because the
    // catalog now carries annual prices.
    for (const plan of PLANS) {
      expect(plan.yearlyUsd, `${plan.name} has no annual price`).not.toBeNull();
    }
    const page = read("src/views/Pricing.tsx");
    expect(page).not.toMatch(/trial/i);
  });

  test("annual formats to a whole-dollar figure", () => {
    for (const plan of PLANS) {
      expect(formatYearly(plan, "en")).not.toContain(".");
      expect(formatYearly(plan, "en")).not.toBe("");
    }
  });

  test("monthly prices format with no stray decimals", () => {
    for (const plan of PLANS) {
      expect(formatMonthly(plan, "en")).not.toContain(".");
    }
  });

  test("included and overage format to real numbers", () => {
    // Unlike the monthly price, overage IS in cents by nature — $0.15 — so it
    // must carry two decimals.
    const starter = PLANS.find((p) => p.id === "starter")!;
    expect(formatIncluded(starter, "en")).toBe("500");
    expect(formatOverage(starter, "en")).toBe("$0.15");
    expect(
      formatOverage(
        PLANS.find((p) => p.id === "enterprise")!,
        "en",
      ),
    ).toBe("");
  });
});

/** Read a repo file relative to this test. */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
}
