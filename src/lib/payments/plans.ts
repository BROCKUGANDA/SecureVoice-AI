/**
 * Plan facts — derived, never duplicated.
 *
 * This module owns the answer to "what does a plan include, what does its
 * overage cost, and how do I know which plan a Paddle price is?" It has NO
 * database client and no server-only guard on purpose: `src/lib/commercial.ts`
 * is imported by the public `/pricing` page, and a billing module that cannot be
 * imported from a browser is a billing module the page will re-implement.
 *
 * ── Why this exists separately from `payments/overage.ts` ───────────────────
 * Three lists used to state the same commercial facts in three places:
 *
 *   · `commercial.ts`'s `PLANS[]` — what `/pricing` renders and what
 *     `scripts/seed-paddle-catalog.ts` seeds.
 *   · `overage.ts`'s `PLAN_INCLUDED_UNITS` — what the rater subtracts, and what
 *     `unitsForPlan()` credits at settlement.
 *   · `overage.ts`'s `PRICE_KEY_TO_PLAN` — which price id means which plan.
 *
 * Nothing tested the first two against each other (`catalog-parity.test.ts`
 * only checked `PLANS` against itself), so a price change to the page could
 * silently change what a bank is BILLED for — the included allowance the rater
 * subtracts is the number the customer read. And `PRICE_KEY_TO_PLAN` listed only
 * MONTHLY cents, so an annual subscription resolved to no plan at all and fell
 * through to the env allowance.
 *
 * Both are now computed from `PLANS[]`. `tests/billing/plan-facts.test.ts` pins
 * the derivation, and the rater reads the per-plan overage rate rather than one
 * global figure the page contradicts.
 */

import { PLANS, planById, type Plan } from "@/lib/commercial";

/**
 * The published overage rate for an org whose plan is unknown, in integer minor
 * units (fils/cents) per intervention. $0.15 = 15.
 *
 * Only a fallback for "we cannot tell what you bought". A known plan always
 * rates at its own `overageCents` — see `resolveOverageRate()`.
 */
export const DEFAULT_OVERAGE_RATE_MINOR_PER_UNIT = 15;

/**
 * Included interventions per commitment period, by plan id — DERIVED from the
 * published catalog, which is the only copy of these numbers anyone edits.
 *
 * A plan with `includedPerMonth: null` publishes no allowance and so is absent
 * here, which makes `unitsForPlan()` fall back to the env allowance rather than
 * crediting zero for a negotiated volume.
 */
export const PLAN_INCLUDED_UNITS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    PLANS.filter((p): p is Plan & { includedPerMonth: number } => p.includedPerMonth !== null).map(
      (p) => [p.id, p.includedPerMonth],
    ),
  ),
);

/**
 * Paddle price-key prefix (`usd_<minor>`) → plan id, built from the catalog.
 *
 * Both intervals are registered. Monthly `usd_9900` and yearly `usd_99000` are
 * the SAME Starter plan; a map that only carried the monthly figure made an
 * annual subscriber's plan unresolvable, which silently replaced their included
 * allowance with `INCLUDED_UNITS_PER_PERIOD` — the deployment's guess at what
 * some other tenant bought.
 */
const PRICE_KEY_TO_PLAN: Readonly<Record<string, string>> = Object.freeze(
  (() => {
    const out: Record<string, string> = {};
    for (const plan of PLANS) {
      if (plan.monthlyUsd !== null) out[`usd_${plan.monthlyUsd * 100}`] = plan.id;
      if (plan.yearlyUsd !== null) out[`usd_${plan.yearlyUsd * 100}`] = plan.id;
    }
    return out;
  })(),
);

/**
 * Maps a Paddle price key to a plan id. Returns null for a price this catalog
 * does not publish (a price made in the dashboard), which falls through to the
 * env allowance — the refusal is loud in `plan-facts.test.ts`, not silent here.
 */
export function planFromPriceKey(priceKey: string | null | undefined): string | null {
  if (!priceKey) return null;
  const cents = priceKey.split("_").slice(0, 2).join("_");
  return PRICE_KEY_TO_PLAN[cents] ?? null;
}

/** The plan a mirrored `priceId` belongs to, via the deployment's `PADDLE_PRICES` map. */
export function planFromPriceId(priceId: string | null | undefined): string | null {
  if (!priceId) return null;
  let prices: Record<string, string>;
  try {
    prices = JSON.parse(process.env.PADDLE_PRICES ?? "{}") as Record<string, string>;
  } catch {
    return null;
  }
  for (const [key, id] of Object.entries(prices)) {
    if (id !== priceId) continue;
    return planFromPriceKey(key);
  }
  return null;
}

/** `INCLUDED_UNITS_PER_PERIOD` — the allowance for an org with no resolvable plan. */
export function includedUnitsFromEnv(): number {
  const raw = process.env.INCLUDED_UNITS_PER_PERIOD;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Intervention credits a settled payment buys.
 *
 * Money never converts 1:1 into credits — minor currency units and intervention
 * credits are different denominations, and equating them is the #204 bug (a $99
 * payment booking 9900 "units"). Units are decided at MINT time and carried on
 * the payment, never re-derived from live state at webhook time: a first
 * purchase has no subscription row yet, and deriving from live state would
 * credit the wrong allowance after a plan change.
 */
export function unitsForPlan(plan: string | null | undefined): number {
  if (plan && PLAN_INCLUDED_UNITS[plan] !== undefined) return PLAN_INCLUDED_UNITS[plan]!;
  return includedUnitsFromEnv();
}

/**
 * Intervention credits for a payment minted WITHOUT a subscription context — a
 * manual bank-transfer record, a top-up checkout, a payment made before any plan
 * row exists. `purpose` is matched case-insensitively against plan ids, so a
 * record entered as `purpose: "Starter"` buys the Starter allowance, not
 * `amountMinor` credits.
 */
export function unitsForMintedPayment(input: {
  amountMinor: number;
  currency: string;
  purpose?: string;
}): number {
  const purpose = input.purpose?.trim().toLowerCase() ?? "";
  if (purpose !== "") {
    for (const plan of Object.keys(PLAN_INCLUDED_UNITS)) {
      if (purpose === plan) return PLAN_INCLUDED_UNITS[plan]!;
    }
  }
  return includedUnitsFromEnv();
}

export type OverageRateResolution =
  | {
      ok: true;
      rateMinorPerUnit: number;
      /** False means the published catalog rate is in effect, not an override. */
      configured: boolean;
    }
  | { ok: false; reason: "rate_invalid" | "rate_not_negotiated"; detail: string };

/**
 * The per-unit overage rate for ONE plan.
 *
 * `OVERAGE_RATE_MINOR_PER_UNIT`, when set, overrides every plan: an operator who
 * sets it has said "bill at this rate", and a deployment mid-dispute needs one
 * switch rather than a catalog edit. Set-but-invalid REFUSES — a silently ignored
 * rate variable is how a billing bug becomes an invoice.
 *
 * Unset, the rate is the plan's own published `overageCents`, which is what
 * `/pricing` quotes per tier (Starter 15¢, Growth 12¢). Enterprise publishes
 * `null` because its volume is negotiated, so it REFUSES rather than rating a
 * negotiated contract at Starter's default — an invented number on an invoice is
 * worse than no invoice.
 */
export function resolveOverageRate(plan: string | null | undefined): OverageRateResolution {
  const raw = process.env.OVERAGE_RATE_MINOR_PER_UNIT;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return {
        ok: false,
        reason: "rate_invalid",
        detail: `OVERAGE_RATE_MINOR_PER_UNIT must be a positive integer number of minor units (got ${JSON.stringify(raw)}); leave it unset to use each plan's published rate`,
      };
    }
    return { ok: true, rateMinorPerUnit: n, configured: true };
  }

  const catalog = planById(plan);
  if (catalog) {
    if (catalog.overageCents === null) {
      return {
        ok: false,
        reason: "rate_not_negotiated",
        detail: `plan "${catalog.id}" publishes no overage rate — its volume beyond the included allowance is negotiated, so nothing is billable until a rate is agreed. Set OVERAGE_RATE_MINOR_PER_UNIT only if this tenant really is to be billed at a posted rate`,
      };
    }
    return { ok: true, rateMinorPerUnit: catalog.overageCents, configured: false };
  }

  return {
    ok: true,
    rateMinorPerUnit: DEFAULT_OVERAGE_RATE_MINOR_PER_UNIT,
    configured: false,
  };
}
