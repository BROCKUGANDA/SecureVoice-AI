/**
 * Seed the Paddle **sandbox** catalog: one product per self-serve plan, with
 * a monthly AND an annual price.
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
import { PLANS as COMMERCIAL_PLANS } from "../src/lib/commercial";

const ENVIRONMENT = "sandbox" as const;

/**
 * The API host for that environment.
 *
 * `sandbox-api.paddle.com` and `api.paddle.com` are separate catalogs with
 * separate credentials, and a request that crosses them is a request that
 * either 404s or, worse, writes to the wrong account.
 */
const API_HOST =
  ENVIRONMENT === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";

/* ── plans ────────────────────────────────────────────────────────────────── */

/**
 * The published tiers, DERIVED from `src/lib/commercial.ts`.
 *
 * This used to be a hand-written literal table of the same three numbers — the
 * THIRD copy of the price list, after `commercial.ts` and
 * `src/views/Pricing.tsx`. The drift between them was invisible until a buyer
 * saw one price and the gateway charged another, which is exactly what
 * `tests/billing/catalog-parity.test.ts` exists to catch. Deriving it removes
 * the copy instead of pinning it.
 *
 * The `monthlyUsd` string Paddle wants is a MINOR-unit string, and the catalog
 * holds whole dollars, so the conversion is `Math.round(usd * 100)`.
 *
 * PLANS WITH `salesAssisted` ARE SKIPPED. A plan sold by negotiation and
 * invoiced has no Paddle product: seeding one would create a price id that
 * nobody bills against, and it would make the browser price map's
 * completeness check (every tier needs BOTH intervals) reject the whole map.
 */
type SeedPlan = {
  id: string;
  name: string;
  description: string;
  /** Whole USD per month, as a MINOR-unit string. 2500.00 -> "250000". */
  monthlyUsd: string;
  /** Whole USD per YEAR, as a MINOR-unit string, or null when the plan has no annual price. */
  yearlyUsd: string | null;
};

const PLANS: SeedPlan[] = COMMERCIAL_PLANS.filter((p) => !p.salesAssisted).map((p) => ({
  id: p.id,
  name: p.name,
  description: p.tagline,
  monthlyUsd: String(Math.round((p.monthlyUsd ?? 0) * 100)),
  yearlyUsd: p.yearlyUsd === null ? null : String(Math.round(p.yearlyUsd * 100)),
}));

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
  return Object.fromEntries(
    REGIONALS.map((r) => [r.label, String(Math.round(base * r.multiplier))]),
  );
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
      yearly: string | null;
      monthlyUsd: string;
      yearlyUsd: string | null;
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

    // ── The annual price ────────────────────────────────────────────────────
    //
    // The browser price map is only usable when EVERY tier has BOTH intervals:
    // a half-filled map renders a working monthly Buy and a dead annual one,
    // and the map's own completeness check rejects the whole map rather than
    // half of it. A monthly-only seed therefore produces a catalog that cannot
    // be mapped, and the pricing page renders with checkout unavailable — which
    // is exactly what the live pricing page did, because the sandbox catalog
    // was seeded from the OLD rate card and never re-seeded after it changed.
    let yearly: string | null = null;
    if (plan.yearlyUsd) {
      const yearlyRegional = regionalAmounts(plan.yearlyUsd);
      yearly = (
        await paddle.prices.create({
          productId: product.id,
          description: `${plan.name} annual (USD)`,
          unitPrice: { amount: plan.yearlyUsd, currencyCode: "USD" },
          billingCycle: { interval: "year", frequency: 1 },
          unitPriceOverrides: REGIONALS.map((r) => ({
            countryCodes: r.countryCodes,
            unitPrice: {
              amount: yearlyRegional[r.label]!,
              currencyCode: r.currencyCode,
            },
          })),
        })
      ).id;
    }

    created[plan.id] = {
      productId: product.id,
      monthly: monthly.id,
      yearly,
      monthlyUsd: plan.monthlyUsd,
      yearlyUsd: plan.yearlyUsd,
      regional,
    };

    console.log(
      `created ${plan.name}: ${product.id}  monthly=${monthly.id}  yearly=${yearly ?? "—"}  ` +
        `$${(Number(plan.monthlyUsd) / 100).toFixed(2)}/mo` +
        (plan.yearlyUsd ? `  $${(Number(plan.yearlyUsd) / 100).toFixed(2)}/yr` : ""),
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

  // ── Archive the products THIS run superseded ────────────────────────────────
  //
  // A rate-card change leaves the previous catalog's products active, with
  // their old prices still sellable: the sandbox carried Starter at $99 and
  // Growth at $499 long after the published rate card moved to $2,500 and
  // $9,000, and nothing in the repository noticed — the price map pointed at
  // the new cards' keys, those keys mapped to no product, and the pricing page
  // rendered with checkout unavailable.
  //
  // The rule is by NAME, so it is self-maintaining: any other ACTIVE product
  // carrying a current plan's name is an older generation of that plan and is
  // archived. A product with a name that is not a plan's — "Negotiated Terms",
  // which the invoiced Enterprise path uses — is untouched.
  const fresh = new Set(Object.values(created).map((c) => c.productId));
  const planNames = new Set(PLANS.map((p) => p.name));
  try {
    // The REST API, not the SDK's `products.list`.
    //
    // The SDK's list returns an EMPTY list for this endpoint on this account —
    // every argument shape, `perPage` included, returns zero items — while
    // `GET /products?per_page=50` over plain HTTP returns the catalog. A
    // seeder that archives "every product with a plan's name" and silently
    // archives NOTHING is worse than one that does not try, because the log
    // says the job was done.
    const r = await fetch(`${API_HOST}/products?per_page=50`, {
      headers: { Authorization: `Bearer ${requireKey()}` },
    });
    if (!r.ok) throw new Error(`GET /products -> ${r.status}`);
    const body = (await r.json()) as { data?: Array<{ id: string; name: string; status: string }> };
    for (const p of body.data ?? []) {
      if (p.status !== "active") continue;
      if (fresh.has(p.id)) continue;
      if (!planNames.has(p.name)) continue;
      await paddle.products.update(p.id, { status: "archived" });
      console.log(`archived superseded product ${p.id} (${p.name})`);
    }
  } catch (e) {
    console.warn(
      `could not archive superseded products: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }

  // ── The price map, in the EXACT shape the environment wants ─────────────────
  //
  // `NEXT_PUBLIC_PADDLE_PRICES` and `PADDLE_PRICES` are both
  // `usd_<minor units>_<month|year>` -> price id, and the interval is part of
  // the key because the rate card contains one amount two prices share
  // (Starter's annual $25,000 and Enterprise's monthly $25,000). Printing the
  // map here means the operator pastes one line rather than assembling it from
  // ids by hand, which is how a key ends up with a mismatched interval.
  const priceMap: Record<string, string> = {};
  for (const plan of PLANS) {
    const c = created[plan.id]!;
    priceMap[`usd_${c.monthlyUsd}_month`] = c.monthly;
    if (c.yearly && c.yearlyUsd) priceMap[`usd_${c.yearlyUsd}_year`] = c.yearly;
  }

  console.log("\n=== PADDLE SANDBOX CATALOG — id mapping ===\n");
  console.log(JSON.stringify(created, null, 2));

  console.log("\n=== THE PRICE MAP — paste into NEXT_PUBLIC_PADDLE_PRICES and PADDLE_PRICES ===\n");
  console.log(JSON.stringify(priceMap));

  console.log("\n=== PRICES (minor units) ===\n");
  console.table(
    PLANS.flatMap((p) => {
      const r = created[p.id]!.regional;
      return [
        {
          plan: p.name,
          "USD / mo": p.monthlyUsd,
          "USD / yr": p.yearlyUsd ?? "—",
          GBP: r["UK"]!,
          EUR: r["Ireland"]!,
          AUD: r["Australia"]!,
        },
      ];
    }),
  );
  console.log("\nNo trial: the page publishes none.");
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
