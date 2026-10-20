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
 * The catalog as seeded and then extended.
 *
 * Monthly prices came from `bun run paddle:seed`; annual prices from
 * `bun run paddle:add-annual` (10x monthly, "two months free"). Both were read
 * back from the live sandbox account afterwards rather than assumed.
 *
 * Sandbox and production catalogs are entirely separate and these `pri_` ids do
 * not exist in production; regenerating them for live is a matter of re-running
 * the two scripts against a live key. The AMOUNTS are the business fact.
 *
 * ── TWO TIERS ON THE PAGE, THREE IN THE CATALOG, AND THE IDS ARE STALE ──────
 *
 * The Pilot is `salesAssisted`: it is invoiced, not sold through Paddle, so
 * it has no Paddle product and no row here. It is a ninety-day engagement, and
 * it has no annual price to seed either.
 *
 * Enterprise IS in the catalog even though it is invoiced in practice, because
 * an invoiced tenant's commercial plan has to resolve from a price id.
 *
 * The `pri_` ids are the ones from the seeding that carried $99 / $499 /
 * $2,000. The AMOUNTS below are the new rate card. **The ids are stale until
 * `bun run paddle:seed` is re-run against the sandbox account**, and the ids
 * are only ever asserted for SHAPE here — the seed script prints the new ones.
 *
 * ── AND ONE AMOUNT IS SHARED BY TWO PRICES ──────────────────────────────────
 *
 * Starter's annual price is $2,500 x 10 = $25,000 and Enterprise's monthly
 * price is $25,000. A Paddle price key encodes the AMOUNT, so `usd_2500000`
 * alone names two different prices. The key's INTERVAL disambiguates them
 * (`usd_2500000_year` is Starter, `usd_2500000_month` is Enterprise), and
 * `src/lib/payments/plans.ts` resolves on the interval. Resolving on the
 * amount alone rated a Starter annual subscriber as Enterprise.
 */
const CATALOG = [
  {
    id: "starter",
    name: "Starter",
    monthlyUsd: 2500,
    yearlyUsd: 25000,
    productId: "pro_01m4kc8a89eb5fs4638p0trbf7",
    monthlyPriceId: "pri_01m4kc8amfsr590wkmf02v0q91",
    yearlyPriceId: "pri_01m4kmzw3cq4na5tfn6xqd6ekn",
    monthlyRegional: { GBP: 187500, EUR: 225000, AUD: 375000 },
    yearlyRegional: { GBP: 1875000, EUR: 2250000, AUD: 3750000 },
  },
  {
    id: "growth",
    name: "Growth",
    monthlyUsd: 9000,
    yearlyUsd: 90000,
    productId: "pro_01m4kc8b21kpp6eabxrybvb935",
    monthlyPriceId: "pri_01m4kc8bdy18z7h9g4qwbv6vqq",
    yearlyPriceId: "pri_01m4kmzwg9vdfe2c4x5qnz2s4s",
    monthlyRegional: { GBP: 675000, EUR: 810000, AUD: 1350000 },
    yearlyRegional: { GBP: 6750000, EUR: 8100000, AUD: 13500000 },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    monthlyUsd: 25000,
    yearlyUsd: 250000,
    productId: "pro_01m4kc8bvk4vjrdhzcgqms3pfk",
    monthlyPriceId: "pri_01m4kc8c6y167c8jx1pk7vcazx",
    yearlyPriceId: "pri_01m4kmzwwqy407sttdb550w8dt",
    monthlyRegional: { GBP: 1875000, EUR: 2250000, AUD: 3750000 },
    yearlyRegional: { GBP: 18750000, EUR: 22500000, AUD: 37500000 },
  },
] as const;

/**
 * The plans sold THROUGH Paddle — the ones the catalog has to carry.
 *
 * A plan marked `salesAssisted` is invoiced, has no Paddle product, and must
 * not appear in the catalog or in the browser price map. The PILOT is such a
 * plan: ninety days, bought once, with no annual price to seed.
 *
 * Enterprise is NOT one of them, even though it is invoiced in practice. It
 * keeps its Paddle product because an invoiced tenant's commercial plan has to
 * resolve from a price id — `Organization.planTier` carries the ABUSE tier
 * vocabulary, not a plan id. The invoice route is a decision taken in the
 * order form; the catalog entry is what keeps the tenant's plan resolvable.
 */
const PADDLE_PLANS = PLANS.filter((p) => !p.salesAssisted);

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
    //
    // The comparison is over the PADDLE-SOLD plans. A `salesAssisted` plan is
    // invoiced and has no Paddle product by design.
    expect(PADDLE_PLANS.map((p) => p.id)).toEqual(CATALOG.map((c) => c.id));
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
    //
    // The one exception is deliberate and narrow: a tier marked
    // `publiclyPriced: false` publishes no price AT ALL, so there is nothing to
    // drift. Its guarantee is the opposite one — the figure must be ABSENT from
    // the Offer while remaining the number the catalog charges. A hidden price
    // that leaks through structured data is the failure this branch now guards.
    for (const row of CATALOG) {
      const plan = PLANS.find((p) => p.id === row.id)!;
      if (plan.publiclyPriced === false) {
        expect(plan.offer.price, `${plan.name} must not publish a price`).toBeUndefined();
        // Still billed at the catalog rate — hiding a price is not a discount.
        expect(plan.monthlyUsd, `${plan.name} still charges the catalog price`).toBe(
          row.monthlyUsd,
        );
        continue;
      }
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
      // Widened deliberately: `row` is `as const`, so its `yearlyUsd` is the
      // literal union 990 | 4990 | 20000 while `monthlyUsd * 10` widens to
      // `number`. Bun's overload resolution wants both sides the same type and
      // rejects the pair. The RATIO is what is being asserted, so compare
      // numbers.
      expect(row.yearlyUsd as number, `${row.name} annual`).toBe(row.monthlyUsd * 10);
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
  test("every plan has an included volume AND a posted overage rate", () => {
    // There is no longer a tier whose overage is "negotiated" and therefore
    // un-ratable. Enterprise's rate is posted ($2.25, with the telephony leg
    // passed through at cost + 10%), because a rate that cannot be rated is a
    // ceiling nobody can price against — and because the rater REFUSING to
    // invoice Enterprise overage is a missing invoice a bank finds on its own
    // statement, months later.
    for (const plan of PLANS) {
      expect(plan.includedPerMonth, `${plan.name} has no included volume`).toBeGreaterThan(0);
      expect(plan.overageCents, `${plan.name} has no overage rate`).toBeGreaterThan(0);
    }
  });

  test("included volume rises monotonically with price", () => {
    // Over the RECURRING plans only, and the Pilot is deliberately excluded.
    //
    // The Pilot is a different SHAPE, not a cheaper month: $12,000 buys ninety
    // days and 2,000 interventions, so it is priced at $6.00 an intervention
    // against Growth's $3.60. That premium is the point of a pilot — it buys a
    // scoped engagement, a charter and a written success criteria, none of
    // which a monthly plan carries. Folding it into the recurring ladder would
    // assert something false ("a pilot includes more than a cheaper plan").
    //
    // The ladder that DOES have to hold is the recurring one: Starter $2,500 /
    // 500, Growth $9,000 / 2,500, Enterprise $25,000 / 10,000.
    const recurring = PLANS.filter((p) => p.yearlyUsd !== null);
    const priced = [...recurring].sort((a, b) => a.monthlyUsd! - b.monthlyUsd!);
    for (let i = 1; i < priced.length; i++) {
      expect(
        priced[i]!.includedPerMonth!,
        `${priced[i]!.name} vs ${priced[i - 1]!.name}`,
      ).toBeGreaterThan(priced[i - 1]!.includedPerMonth!);
    }
  });

  test("the pilot is priced above the recurring ladder, per intervention", () => {
    // $12,000 / 2,000 = $6.00, against Growth's $9,000 / 2,500 = $3.60. If the
    // pilot ever came out CHEAPER per intervention than the monthly plans, the
    // rate card would be inviting every customer to buy a pilot and never
    // convert — and nobody would notice, because both numbers are correct on
    // their own.
    const pilot = PLANS.find((p) => p.id === "pilot")!;
    const growth = PLANS.find((p) => p.id === "growth")!;
    const pilotPer = pilot.monthlyUsd! / pilot.includedPerMonth!;
    const growthPer = growth.monthlyUsd! / growth.includedPerMonth!;
    expect(pilotPer).toBeGreaterThan(growthPer);
  });

  test("annual is offered and priced, with no trial promised anywhere", () => {
    // The annual toggle exists and is backed. A trial does NOT exist in the
    // catalog — nothing seeds one — so the page must not promise one. This is the
    // same guard that previously asserted the opposite, inverted because the
    // catalog now carries annual prices.
    //
    // The PILOT is the exception, and it is a real one: ninety days, bought
    // once, invoiced. It has no annual price because it has no second year.
    for (const plan of PADDLE_PLANS) {
      expect(plan.yearlyUsd, `${plan.name} has no annual price`).not.toBeNull();
    }
    const pilot = PLANS.find((p) => p.id === "pilot")!;
    expect(pilot.yearlyUsd, "the pilot is a ninety-day engagement, not a subscription").toBeNull();
    const page = read("src/views/Pricing.tsx");
    expect(page).not.toMatch(/trial/i);
  });

  test("annual formats to a whole-dollar figure", () => {
    for (const plan of PLANS) {
      // A contact-sales tier formats the annual to "" on purpose — printing it
      // under a "Custom" headline would publish the figure the month hides. Its
      // annual NUMBER is still asserted above; this is only about rendering.
      //
      // A one-off engagement has no annual at all, and prints none.
      if (plan.publiclyPriced === false || plan.yearlyUsd === null) {
        expect(formatYearly(plan, "en"), `${plan.name} must hide its annual`).toBe("");
        continue;
      }
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
    // Unlike the monthly price, overage IS in cents by nature — $4.50 — so it
    // must carry two decimals.
    const starter = PLANS.find((p) => p.id === "starter")!;
    expect(formatIncluded(starter, "en")).toBe("500");
    expect(formatOverage(starter, "en")).toBe("$4.50");
    expect(
      formatOverage(
        PLANS.find((p) => p.id === "enterprise")!,
        "en",
      ),
    ).toBe("$2.25");
    expect(
      formatOverage(
        PLANS.find((p) => p.id === "pilot")!,
        "en",
      ),
    ).toBe("$5.00");
  });
});

/** Read a repo file relative to this test. */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
}
