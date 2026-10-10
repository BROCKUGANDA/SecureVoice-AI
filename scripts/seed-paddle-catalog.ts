/**
 * Seed the Paddle **sandbox** catalog: 3 products, 6 base prices, 18 regional
 * price overrides.
 *
 * Run:   PADDLE_SANDBOX_API_KEY=pdl_sdbx_... bun scripts/seed-paddle-catalog.ts
 *
 * Sandbox and production catalogs are completely separate — `pri_` ids from one
 * do not exist in the other. This script hard-refuses to run against production
 * unless you flip `ENVIRONMENT`, because a catalog seeded with test prices into
 * a live account is the kind of mistake that is only fixable by hand.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️  THESE PRICES DO NOT MATCH src/lib/commercial.ts. READ THIS.
 *
 *   Plan      this script        src/lib/commercial.ts (the website)
 *   Starter   $10 / $100         $490 / (annual not published)
 *   Pro       $40 / $400         $1,490 / (annual not published)
 *   Advanced  $120 / $1,200      — no such plan; "Enterprise" is Custom-priced
 *
 * The numbers below are the ones specified for the catalog. They were used
 * deliberately and they are isolated in ONE `PLANS` array at the top of this
 * file, so reconciling them with the site is a one-line edit per plan rather than
 * a hunt. The website prices are the ones a customer sees today; do not let the
 * two drift without deciding which is authoritative.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── Amount units (the #1 documented pitfall, so: stated here too) ───────────
 * `unitPrice.amount` is a STRING in the LOWEST currency unit.
 *   $10.00  -> "1000"     £7.00   -> "700"     €9.00 -> "900"   A$15.00 -> "1500"
 * USD, GBP, EUR and AUD are all 2-decimal, so pence/cents throughout.
 * (JPY, KRW and CLP are ZERO-decimal in Paddle — "1200" is ¥1,200, not ¥12.
 * None of the currencies here are in that group, but any future market added to
 * `REGIONALS` must be checked against it first.)
 *
 * ── Why trial is on MONTHLY only ─────────────────────────────────────────────
 * A trial on a recurring price auto-converts to that price's billing cycle when
 * it ends. A 7-day trial on the ANNUAL price therefore ends in a charge for 12
 * months, which is the single largest chargeback and refund generator in
 * subscription commerce. "Trial on all plans" is honoured as one trial on each
 * of the three plans; annual is left trial-free on purpose. To change that, add
 * `trialPeriod` to the yearly entries in `base()`.
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
  /** Whole USD. 10.00 -> minor units "1000". */
  monthlyUsd: string;
  yearlyUsd: string;
};

const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    description:
      "Real-time voice fraud intervention for one bank entity. 1,000 outbound interventions per month.",
    monthlyUsd: "1000", // $10.00
    yearlyUsd: "10000", // $100.00
  },
  {
    id: "pro",
    name: "Pro",
    description:
      "The production tier for five bank entities: 5,000 interventions per month, streaming voice, priority carrier routing, 99.9% uptime SLA.",
    monthlyUsd: "4000", // $40.00
    yearlyUsd: "40000", // $400.00
  },
  {
    id: "advanced",
    name: "Advanced",
    description:
      "Negotiated volume, in-VPC deployment, bring-your-own-keys, voice cloning and a CBUAE audit pack.",
    monthlyUsd: "12000", // $120.00
    yearlyUsd: "120000", // $1,200.00
  },
];

/* ── regional pricing ─────────────────────────────────────────────────────── */

/**
 * Country overrides, and the basis for the numbers.
 *
 * These are MARKET-conventional with a mild purchasing-power tilt, which is the
 * norm for B2B SaaS — not a straight PPP conversion. The distinction matters:
 *
 *   A strict PPP conversion would make UK/EU/AU prices HIGHER than the USD
 *   price, because all three are above US purchasing power. That is
 *   economically correct and commercially wrong: these buyers are price-sensitive
 *   relative to a dollar-denominated alternative and there is no local currency
 *   advantage to pass on, so a higher local number reads as a penalty.
 *
 *   The multipliers below are the widely-used B2B SaaS convention:
 *     GBP ~0.75 x USD   UK is competitive on £, VAT added at checkout by
 *                       Paddle so the list price must not pre-load tax
 *     EUR ~0.90 x USD   Ireland runs high on € but tracks the EU market
 *     AUD ~1.50 x USD   AUD is weak against USD; parity already feels expensive
 *                       locally, so it needs a premium
 *
 * The amounts are DERIVED from each plan's USD price, never listed separately.
 * That is the fix for a bug this file shipped first time round: the original
 * held one ABSOLUTE amount per region ("UK: 700") and applied it to every plan,
 * so Pro and Advanced were created carrying Starter's regional prices — a £7
 * monthly override on a $40 plan, caught by verifying the catalog after
 * creation. A per-region absolute cannot be correct for more than one plan.
 * A multiplier can.
 *
 * These multipliers also land on round numbers at every tier ($10/$40/$120 x
 * 0.75/0.90/1.50 = £7.50/£30/£90, €9/€36/€108, A$15/A$60/A$180), and every
 * annual figure is exactly 10x its monthly — "two months free", the standard
 * annual discount, legible to a buyer in any currency.
 *
 * ADJUST THESE. They are starting points, not research.
 */
type Regional = {
  label: string;
  /**
   * Paddle expects ISO 3166-1 alpha-2 country codes, and the SDK types this as
   * a literal union (`CountryCode`), not `string`. Typing it `string[]` is a
   * compile error — which is correct: it means a typo like "GBR" is caught here
   * rather than silently creating an override that never matches a buyer.
   */
  countryCodes: CountryCode[];
  currencyCode: CurrencyCode;
  /** Applied to the plan's USD MINOR amount. 0.75 means "75% of the USD price". */
  multiplier: number;
};

const REGIONALS: Regional[] = [
  { label: "UK", countryCodes: ["GB"], currencyCode: "GBP", multiplier: 0.75 },
  { label: "Ireland", countryCodes: ["IE"], currencyCode: "EUR", multiplier: 0.9 },
  { label: "Australia", countryCodes: ["AU"], currencyCode: "AUD", multiplier: 1.5 },
];

/**
 * Apply the multipliers to a plan's USD minor amount.
 *
 * A function rather than a table, deliberately: a table must be extended by hand
 * every time a plan is added, and forgetting one is silent — the override is
 * simply absent, and nobody notices until a customer is quoted the wrong local
 * price. Deriving it makes that failure mode unrepresentable.
 */
function regionalAmounts(usdMinor: string): Record<string, string> {
  const base = Number(usdMinor);
  if (!Number.isInteger(base) || base <= 0) {
    throw new RangeError(`usd amount must be a positive integer minor value, got "${usdMinor}"`);
  }
  return Object.fromEntries(
    REGIONALS.map((r) => [r.label, String(Math.round(base * r.multiplier))]),
  );
}

/** 7-day free trial, applied to the monthly price of every plan. */
const TRIAL = { interval: "day" as const, frequency: 7 };

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
  if (!key.startsWith("pdl_sdbx_")) {
    // Paddle sandbox keys are prefixed `pdl_sdbx_`, live keys `pdl_live_`.
    // Catching it here beats a 403 from the API with an empty body.
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
      yearly: string;
      overrides: string[];
      regionalAmounts: Record<string, { monthly: string; yearly: string }>;
    }
  > = {};

  for (const plan of PLANS) {
    const product = await paddle.products.create({
      name: plan.name,
      taxCategory: "saas",
      description: plan.description,
    });

    const overridesFor = (usdMinor: string) => {
      const amounts = regionalAmounts(usdMinor);
      return REGIONALS.map((r) => ({
        countryCodes: r.countryCodes,
        unitPrice: { amount: amounts[r.label]!, currencyCode: r.currencyCode },
      }));
    };

    const monthlyAmounts = regionalAmounts(plan.monthlyUsd);
    const yearlyAmounts = regionalAmounts(plan.yearlyUsd);

    const monthly = await paddle.prices.create({
      productId: product.id,
      description: `${plan.name} monthly (USD)`,
      unitPrice: { amount: plan.monthlyUsd, currencyCode: "USD" },
      billingCycle: { interval: "month", frequency: 1 },
      trialPeriod: TRIAL,
      unitPriceOverrides: overridesFor(plan.monthlyUsd),
    });

    const yearly = await paddle.prices.create({
      productId: product.id,
      description: `${plan.name} yearly (USD)`,
      unitPrice: { amount: plan.yearlyUsd, currencyCode: "USD" },
      billingCycle: { interval: "year", frequency: 1 },
      unitPriceOverrides: overridesFor(plan.yearlyUsd),
    });

    created[plan.id] = {
      productId: product.id,
      monthly: monthly.id,
      yearly: yearly.id,
      overrides: [monthly.id, yearly.id],
      regionalAmounts: {
        UK: { monthly: monthlyAmounts["UK"]!, yearly: yearlyAmounts["UK"]! },
        Ireland: { monthly: monthlyAmounts["Ireland"]!, yearly: yearlyAmounts["Ireland"]! },
        Australia: {
          monthly: monthlyAmounts["Australia"]!,
          yearly: yearlyAmounts["Australia"]!,
        },
      },
    };

    console.log(`created ${plan.name}: ${product.id}  monthly=${monthly.id}  yearly=${yearly.id}`);
  }

  console.log("\n=== PADDLE SANDBOX CATALOG — id mapping ===\n");
  console.log(JSON.stringify(created, null, 2));

  console.log("\n=== REGIONAL OVERRIDES APPLIED (minor units) ===\n");
  console.table(
    PLANS.flatMap((p) => [
      {
        plan: p.name,
        interval: "monthly",
        USD: p.monthlyUsd,
        GBP: created[p.id]!.regionalAmounts["UK"]!.monthly,
        EUR: created[p.id]!.regionalAmounts["Ireland"]!.monthly,
        AUD: created[p.id]!.regionalAmounts["Australia"]!.monthly,
        trial: "7 days",
      },
      {
        plan: p.name,
        interval: "yearly",
        USD: p.yearlyUsd,
        GBP: created[p.id]!.regionalAmounts["UK"]!.yearly,
        EUR: created[p.id]!.regionalAmounts["Ireland"]!.yearly,
        AUD: created[p.id]!.regionalAmounts["Australia"]!.yearly,
        trial: "none",
      },
    ]),
  );
  console.log("\nNothing here touches production. Sandbox and live catalogs are separate.");
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
