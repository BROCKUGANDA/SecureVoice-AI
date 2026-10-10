/**
 * Seed the Paddle **sandbox** catalog: 3 products, 3 monthly subscription
 * prices.
 *
 * Run:   PADDLE_SANDBOX_API_KEY=pdl_sdbx_... bun scripts/seed-paddle-catalog.ts
 *
 * Sandbox and production catalogs are completely separate — `pri_` ids from one
 * do not exist in the other. This script hard-refuses to run against production
 * unless you flip `ENVIRONMENT`, because a catalog seeded with test prices into
 * a live account is the kind of mistake that is only fixable by hand.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️  WHAT THIS SCRIPT DOES NOT SEED, AND WHY — read before adding to it.
 *
 * There is no annual price and no free trial, because the page no longer
 * publishes either. There was a 7-day trial and a two-months-free annual price in
 * an earlier revision; both are gone from `src/views/Pricing.tsx`.
 *
 * There is ALSO no overage price, and that is deliberate rather than unfinished.
 * `src/views/Pricing.tsx` publishes a per-tier overage rate ($0.15 on Starter,
 * $0.12 on Growth), but `src/lib/payments/overage.ts` implements ONE GLOBAL
 * rate — `OVERAGE_RATE_MINOR_PER_UNIT` — plus ONE global
 * `INCLUDED_UNITS_PER_PERIOD`, and raises the result as an INVOICE through
 * `raiseOverageInvoice`, not as a Paddle charge. Seeding usage prices here would
 * create a second, contradictory billing path that nothing in the code calls.
 *
 * Reconciling that is a product decision, not a seeding decision: either
 * overage.ts grows per-tier rates, or the page stops quoting two of them.
 * Until then this script seeds what the code can actually charge.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── Amount units ──────────────────────────────────────────────────────────────
 * `unitPrice.amount` is a STRING in the LOWEST currency unit.
 *   $99.00  -> "9900"
 * USD is 2-decimal, so cents throughout. (JPY, KRW and CLP are ZERO-decimal in
 * Paddle — not used here, but check any future market against that list.)
 */

import { Environment, Paddle } from "@paddle/paddle-node-sdk";
// Both are literal unions re-exported from the package root (`export * from
// './enums/index.js'`). Typing with them rather than `string` is deliberate: it
// is a compile error to write "GBR" or "US D" here, which is exactly the class
// of typo that would otherwise create an override silently matching nobody.
import type { CountryCode, CurrencyCode } from "@paddle/paddle-node-sdk";

const ENVIRONMENT = "sandbox" as const;

/* ── plans ────────────────────────────────────────────────────────────────── */

type Plan = {
  id: string;
  name: string;
  description: string;
  /** Whole USD per month, as a MINOR-unit string. 99.00 -> "9900". */
  monthlyUsd: string;
};

/**
 * The three published tiers, matching `src/lib/commercial.ts` and
 * `src/views/Pricing.tsx`.
 *
 * IF YOU CHANGE A NUMBER HERE, change it in `commercial.ts` in the same commit —
 * `tests/billing/catalog-parity.test.ts` asserts they agree, and a page that
 * quotes one price while the gateway charges another is the failure it exists
 * to prevent.
 */
const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    description:
      "Real-time voice fraud intervention for evaluation teams. 500 intervention signals per month, one organization, Arabic and English voice agents.",
    monthlyUsd: "9900", // $99.00
  },
  {
    id: "growth",
    name: "Growth",
    description:
      "The production tier for mid-market banks and insurers running live fraud desks. 2,500 intervention signals per month, multi-tenant, BYOK.",
    monthlyUsd: "49900", // $499.00
  },
  {
    id: "enterprise",
    name: "Enterprise",
    description:
      "For Tier-1 UAE banks deploying inside their own perimeter. 10,000 intervention signals per month, in-VPC or data centre deployment, custom volume beyond.",
    monthlyUsd: "200000", // $2,000.00
  },
];

/* ── regional pricing ─────────────────────────────────────────────────────── */

type Regional = {
  label: string;
  /** Paddle expects ISO 3166-1 alpha-2 country codes. */
  countryCodes: CountryCode[];
  currencyCode: CurrencyCode;
  /**
   * Multiplier applied to the plan's USD MINOR amount. Market-conventional with
   * a mild purchasing-power tilt — the same values `catalog-parity` and the page
   * describe. Derived per plan, never a single absolute, because a per-region
   * absolute cannot be right for more than one tier.
   */
  multiplier: number;
};

const REGIONALS: Regional[] = [
  { label: "UK", countryCodes: ["GB"], currencyCode: "GBP", multiplier: 0.75 },
  { label: "Ireland", countryCodes: ["IE"], currencyCode: "EUR", multiplier: 0.9 },
  { label: "Australia", countryCodes: ["AU"], currencyCode: "AUD", multiplier: 1.5 },
];

/** Apply the multipliers to a plan's USD minor amount. */
function regionalAmounts(usdMinor: string): Record<string, string> {
  const base = Number(usdMinor);
  if (!Number.isInteger(base) || base <= 0) {
    throw new RangeError(`usd amount must be a positive integer minor value, got "${usdMinor}"`);
  }
  return Object.fromEntries(REGIONALS.map((r) => [r.label, String(Math.round(base * r.multiplier))]));
}

/**
 * Products from an EARLIER seeding that should be archived so the catalog is not
 * carrying stale tiers alongside the current ones.
 *
 * The account was first seeded at $10 / $40 / $120 with an annual price and a
 * 7-day trial — a pricing shape this codebase does not implement. Archiving
 * rather than deleting keeps their ids resolvable for any historical event, and
 * a sandbox catalog nobody can accidentally sell from.
 */
const RETIRED_PRODUCT_IDS = [
  "pro_01m4k7r196v73zm54hta4vexwr", // Starter, $10
  "pro_01m4k7r2g61fsrtxjscrywe35a", // Pro, $40
  "pro_01m4k7r4d7az2zggnavk2392pq", // Advanced, $120
];

/* ── run ──────────────────────────────────────────────────────────────────── */

function requireKey(): string {
  const key = process.env.PADDLE_SANDBOX_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "PADDLE_SANDBOX_API_KEY is not set.\n" +
        "  Paddle > Developer tools > Authentication in the SANDBOX dashboard\n" +
        "  (https://sandbox-vendors.paddle.com/authentication-v2), with at least\n" +
        "  product.write and price.write scopes.",
    );
  }
  // Paddle sandbox keys are prefixed `pdl_sdbx_`, live keys `pdl_live_`. Catching
  // it here beats a 403 from the API with an empty body.
  if (!key.startsWith("pdl_sdbx_")) {
    throw new Error(
      `That does not look like a Paddle SANDBOX key (expected a "pdl_sdbx_" prefix).\n` +
        `  Got: "${key.slice(0, 12)}..."\n` +
        `  This script refuses to run against production.`,
    );
  }
  return key;
}

async function seed() {
  const paddle = new Paddle(requireKey(), {
    environment: Environment[ENVIRONMENT],
  });

  const created: Record<
    string,
    {
      productId: string;
      monthly: string;
      monthlyUsd: string;
      regional: Record<string, string>;
    }
  > = {};

  for (const plan of PLANS) {
    const product = await paddle.products.create({
      name: plan.name,
      taxCategory: "saas",
      description: plan.description,
    });

    const regional = regionalAmounts(plan.monthlyUsd);
    const overrides = REGIONALS.map((r) => ({
      countryCodes: r.countryCodes,
      unitPrice: { amount: regional[r.label]!, currencyCode: r.currencyCode },
    }));

    const monthly = await paddle.prices.create({
      productId: product.id,
      description: `${plan.name} monthly (USD)`,
      unitPrice: { amount: plan.monthlyUsd, currencyCode: "USD" },
      billingCycle: { interval: "month", frequency: 1 },
      unitPriceOverrides: overrides,
    });

    created[plan.id] = {
      productId: product.id,
      monthly: monthly.id,
      monthlyUsd: plan.monthlyUsd,
      regional,
    };

    console.log(
      `created ${plan.name}: ${product.id}  monthly=${monthly.id}  $${(Number(plan.monthlyUsd) / 100).toFixed(2)}`,
    );
  }

  // Archive the previous catalog so nobody sells from it. Non-fatal by design: a
  // re-run after a partial failure should still be able to finish creating.
  for (const id of RETIRED_PRODUCT_IDS) {
    try {
      await paddle.products.update(id, { status: "archived" });
      console.log(`archived retired product ${id}`);
    } catch (e) {
      console.warn(`could not archive ${id}: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  console.log("\n=== PADDLE SANDBOX CATALOG — id mapping ===\n");
  console.log(JSON.stringify(created, null, 2));

  console.log("\n=== PRICES (minor units) ===\n");
  console.table(
    PLANS.flatMap((p) => {
      const r = created[p.id]!.regional;
      return [
        {
          plan: p.name,
          USD: p.monthlyUsd,
          GBP: r["UK"]!,
          EUR: r["Ireland"]!,
          AUD: r["Australia"]!,
        },
      ];
    }),
  );
  console.log("\nNo annual price and no trial: the page publishes neither.");
  console.log("No overage price: overage is a global rate invoiced in code, not a Paddle charge.");
}

seed().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  if (/forbidden|unauthorized/i.test(String((e as { message?: string })?.message))) {
    console.error(
      "\nLikely cause: the API key lacks product.write / price.write.\n" +
        "Regenerate it in Paddle > Developer tools > Authentication with those scopes.",
    );
  }
  process.exit(1);
});