/**
 * REPAIR the Paddle sandbox catalog's regional price overrides.
 *
 * Why this exists: the first run of seed-paddle-catalog.ts held one absolute
 * regional amount per region and applied it to every plan, so all three products
 * were created with Starter's regional prices — a £7 monthly override on a $40
 * Pro plan. The seed script is fixed (amounts are now derived per plan from a
 * multiplier); this repairs what is already in the account.
 *
 * It UPDATES IN PLACE rather than deleting and recreating, so the `pro_`/`pri_`
 * ids already reported to the user stay valid. Only `unitPriceOverrides` is
 * touched — the USD base price, billing cycle and trial are correct as created.
 *
 * Idempotent: re-running applies the same values and is safe.
 *
 * Usage: PADDLE_SANDBOX_API_KEY=... bun scripts/paddle-repair-overrides.ts
 */
import { Environment, Paddle } from "@paddle/paddle-node-sdk";
import type { CountryCode, CurrencyCode } from "@paddle/paddle-node-sdk";

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

const PLANS = [
  {
    name: "Starter",
    productId: "pro_01m4k7r196v73zm54hta4vexwr",
    monthlyUsd: 1000,
    yearlyUsd: 10000,
  },
  {
    name: "Pro",
    productId: "pro_01m4k7r2g61fsrtxjscrywe35a",
    monthlyUsd: 4000,
    yearlyUsd: 40000,
  },
  {
    name: "Advanced",
    productId: "pro_01m4k7r4d7az2zggnavk2392pq",
    monthlyUsd: 12000,
    yearlyUsd: 120000,
  },
];

const paddle = new Paddle(process.env.PADDLE_SANDBOX_API_KEY!, {
  environment: Environment.sandbox,
});

const overridesFor = (usdMinor: number) =>
  REGIONALS.map((r) => ({
    countryCodes: r.countryCodes,
    unitPrice: {
      amount: String(Math.round(usdMinor * r.multiplier)),
      currencyCode: r.currencyCode,
    },
  }));

for (const plan of PLANS) {
  const product = await paddle.products.get(plan.productId, { include: ["prices"] });
  for (const price of product.prices ?? []) {
    const interval = (price as unknown as { billingCycle?: { interval?: string } }).billingCycle
      ?.interval;
    const usdMinor = interval === "year" ? plan.yearlyUsd : plan.monthlyUsd;
    const next = overridesFor(usdMinor);

    const current = (
      price as unknown as {
        unitPriceOverrides?: { countryCodes: string[]; unitPrice: { amount: string } }[];
      }
    ).unitPriceOverrides;

    const before = (current ?? [])
      .map((o) => `${o.countryCodes.join("/")}=${o.unitPrice.amount}`)
      .join(" ");
    const after = next.map((o) => `${o.countryCodes.join("/")}=${o.unitPrice.amount}`).join(" ");

    await paddle.prices.update(price.id, { unitPriceOverrides: next });
    console.log(`${plan.name.padEnd(9)} ${String(interval).padEnd(6)} ${price.id}`);
    console.log(`   before: ${before || "(none)"}`);
    console.log(`   after : ${after}`);
  }
}

console.log("\nDone. Re-run scripts/paddle-verify.ts to confirm.");
