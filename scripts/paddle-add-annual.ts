/**
 * Add ANNUAL prices to the existing products.
 *
 * ADDITIVE — this only creates new price objects on the existing products. It
 * does not touch, archive or delete the monthly prices the pricing page already
 * sells, nor the products themselves.
 *
 * Annual is 10x monthly — "two months free" — which is the same rule
 * `commercial.ts` now encodes and `catalog-parity.test.ts` asserts.
 *
 * Usage: PADDLE_API_KEY=pdl_sdbx_... bun scripts/paddle-add-annual.ts
 */
import { Environment, Paddle } from "@paddle/paddle-node-sdk";
import type { CountryCode, CurrencyCode } from "@paddle/paddle-node-sdk";

const ENVIRONMENT = "sandbox" as const;

/** The products as re-seeded on 2026-10-10. Monthly only, at these amounts. */
const PRODUCTS = [
  {
    id: "starter",
    name: "Starter",
    productId: "pro_01m4kc8a89eb5fs4638p0trbf7",
    monthlyUsd: 9900,
  },
  {
    id: "growth",
    name: "Growth",
    productId: "pro_01m4kc8b21kpp6eabxrybvb935",
    monthlyUsd: 49900,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    productId: "pro_01m4kc8bvk4vjrdhzcgqms3pfk",
    monthlyUsd: 200000,
  },
];

/** Same multipliers as the seed script and the parity test. */
const REGIONALS: {
  label: string;
  countryCodes: CountryCode[];
  currencyCode: CurrencyCode;
  multiplier: number;
}[] = [
  { label: "UK", countryCodes: ["GB"], currencyCode: "GBP", multiplier: 0.75 },
  { label: "Ireland", countryCodes: ["IE"], currencyCode: "EUR", multiplier: 0.9 },
  { label: "Australia", countryCodes: ["AU"], currencyCode: "AUD", multiplier: 1.5 },
];

const ANNUAL_MULTIPLE = 10;

function requireKey(): string {
  const key = process.env.PADDLE_API_KEY?.trim();
  if (!key) throw new Error("PADDLE_API_KEY is not set");
  if (!key.startsWith("pdl_sdbx_")) throw new Error("refusing a non-sandbox key");
  return key;
}

async function main() {
  const paddle = new Paddle(requireKey(), { environment: Environment[ENVIRONMENT] });
  const created: Record<string, { annual: string; usd: string; regional: Record<string, string> }> =
    {};

  for (const p of PRODUCTS) {
    const yearlyMinor = p.monthlyUsd * ANNUAL_MULTIPLE;
    const regional: Record<string, string> = {};
    const overrides = REGIONALS.map((r) => {
      const amount = String(Math.round(yearlyMinor * r.multiplier));
      regional[r.label] = amount;
      return { countryCodes: r.countryCodes, unitPrice: { amount, currencyCode: r.currencyCode } };
    });

    const price = await paddle.prices.create({
      productId: p.productId,
      description: `${p.name} yearly (USD)`,
      unitPrice: { amount: String(yearlyMinor), currencyCode: "USD" },
      billingCycle: { interval: "year", frequency: 1 },
      unitPriceOverrides: overrides,
    });

    created[p.id] = { annual: price.id, usd: String(yearlyMinor), regional };
    console.log(`${p.id}: yearly ${price.id}  $${(yearlyMinor / 100).toFixed(2)}`);
  }

  console.log("\n=== ANNUAL PRICES ADDED (minor units) ===\n");
  console.table(
    PRODUCTS.map((p) => ({
      plan: p.name,
      USD: created[p.id]!.usd,
      GBP: created[p.id]!.regional["UK"]!,
      EUR: created[p.id]!.regional["Ireland"]!,
      AUD: created[p.id]!.regional["Australia"]!,
    })),
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
