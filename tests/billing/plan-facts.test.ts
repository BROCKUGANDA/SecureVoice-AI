/**
 * Plan facts — the derivation that keeps the pricing page and the invoice rater
 * telling the same story.
 *
 * Before `src/lib/payments/plans.ts`, three lists stated these facts
 * independently: `commercial.ts`'s `PLANS[]` (what the buyer reads),
 * `overage.ts`'s `PLAN_INCLUDED_UNITS` (what the rater subtracts), and
 * `PRICE_KEY_TO_PLAN` (which price id is which plan). Nothing tested the first
 * against the second, so re-pricing the page could silently change what a bank
 * was billed for. These tests pin the DERIVATION, not the numbers, so the gate
 * keeps working when the numbers change.
 *
 * No database: every fact here is catalog + env, which is the point — a billing
 * screen and an invoice must be able to agree without both asking Postgres.
 *
 *   bun test tests/billing/plan-facts.test.ts
 */
import { describe, expect, test } from "bun:test";
import { PLANS, planById } from "@/lib/commercial";
import {
  PLAN_INCLUDED_UNITS,
  includedUnitsFromEnv,
  planFromPriceId,
  planFromPriceKey,
  resolveOverageRate,
  unitsForMintedPayment,
  unitsForPlan,
} from "@/lib/payments/plans";

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const SAVED = {
  OVERAGE_RATE_MINOR_PER_UNIT: process.env.OVERAGE_RATE_MINOR_PER_UNIT,
  INCLUDED_UNITS_PER_PERIOD: process.env.INCLUDED_UNITS_PER_PERIOD,
  PADDLE_PRICES: process.env.PADDLE_PRICES,
};
function restoreEnv() {
  setEnv("OVERAGE_RATE_MINOR_PER_UNIT", SAVED.OVERAGE_RATE_MINOR_PER_UNIT);
  setEnv("INCLUDED_UNITS_PER_PERIOD", SAVED.INCLUDED_UNITS_PER_PERIOD);
  setEnv("PADDLE_PRICES", SAVED.PADDLE_PRICES);
}

describe("the included allowance is the catalog's, not a copy", () => {
  test("PLAN_INCLUDED_UNITS equals PLANS[].includedPerMonth for every plan", () => {
    for (const plan of PLANS) {
      if (plan.includedPerMonth === null) {
        expect(PLAN_INCLUDED_UNITS[plan.id]).toBeUndefined();
      } else {
        expect(PLAN_INCLUDED_UNITS[plan.id], `${plan.id} allowance`).toBe(plan.includedPerMonth);
      }
    }
  });

  test("it names no plan the catalog does not publish", () => {
    // A stale key here is an allowance the rater subtracts for a plan nobody
    // sells any more — the customer is billed for volume they were never granted.
    expect(Object.keys(PLAN_INCLUDED_UNITS).sort()).toEqual(
      PLANS.filter((p) => p.includedPerMonth !== null)
        .map((p) => p.id)
        .sort(),
    );
  });

  test("unitsForPlan and unitsForMintedPayment read the same table", () => {
    setEnv("INCLUDED_UNITS_PER_PERIOD", undefined);
    for (const plan of PLANS) {
      if (plan.includedPerMonth === null) continue;
      expect(unitsForPlan(plan.id)).toBe(plan.includedPerMonth);
      expect(unitsForMintedPayment({ amountMinor: 1, currency: "USD", purpose: plan.id })).toBe(
        plan.includedPerMonth,
      );
    }
    restoreEnv();
  });

  test("an unknown plan buys the env allowance, never the amount it paid", () => {
    // The #204 bug: a $99 payment booking 9900 credits. Minor currency units and
    // intervention credits are different denominations.
    setEnv("INCLUDED_UNITS_PER_PERIOD", "75");
    expect(unitsForPlan("no-such-plan")).toBe(75);
    expect(unitsForMintedPayment({ amountMinor: 9_900, currency: "usd" })).toBe(75);
    restoreEnv();
  });
});

describe("a price id resolves to the plan it belongs to", () => {
  test("MONTHLY and YEARLY prices of one plan resolve to that plan", () => {
    // The hand-maintained map listed only monthly cents, so an ANNUAL
    // subscription resolved to no plan and its allowance fell through to
    // INCLUDED_UNITS_PER_PERIOD — the deployment's guess at some other tenant.
    for (const plan of PLANS) {
      if (plan.monthlyUsd !== null) {
        expect(planFromPriceKey(`usd_${plan.monthlyUsd * 100}_monthly`), plan.id).toBe(plan.id);
      }
      if (plan.yearlyUsd !== null) {
        expect(planFromPriceKey(`usd_${plan.yearlyUsd * 100}_yearly`), `${plan.id} yearly`).toBe(
          plan.id,
        );
      }
    }
  });

  test("a price the catalog does not publish resolves to null, not to a plan", () => {
    // Returning a plausible plan for an unknown id would bill the wrong bundle.
    expect(planFromPriceKey("usd_1_monthly")).toBeNull();
    expect(planFromPriceKey(null)).toBeNull();
    expect(planFromPriceKey("")).toBeNull();
  });

  test("planFromPriceId goes through the deployment's PADDLE_PRICES map", () => {
    const growth = PLANS.find((p) => p.id === "growth")!;
    setEnv(
      "PADDLE_PRICES",
      JSON.stringify({
        usd_250000_monthly: "pr_starter",
        [`usd_${(growth.monthlyUsd ?? 0) * 100}_monthly`]: "pr_growth",
        [`usd_${(growth.yearlyUsd ?? 0) * 100}_yearly`]: "pr_growth_annual",
      }),
    );
    expect(planFromPriceId("pr_growth")).toBe("growth");
    expect(planFromPriceId("pr_growth_annual")).toBe("growth");
    expect(planFromPriceId("pr_starter")).toBe("starter");
    expect(planFromPriceId("pr_not_ours")).toBeNull();
    restoreEnv();
  });

  test("a malformed PADDLE_PRICES map refuses to name a plan rather than inventing one", () => {
    setEnv("PADDLE_PRICES", "{not json");
    expect(planFromPriceId("pr_anything")).toBeNull();
    restoreEnv();
  });
});

describe("the overage rate is the plan's own", () => {
  test("each published rate comes from the catalog the buyer read", () => {
    setEnv("OVERAGE_RATE_MINOR_PER_UNIT", undefined);
    const starter = resolveOverageRate("starter");
    const growth = resolveOverageRate("growth");
    expect(starter.ok).toBe(true);
    expect(growth.ok).toBe(true);
    if (!starter.ok || !growth.ok) return;
    const starterCents = planById("starter")!.overageCents;
    const growthCents = planById("growth")!.overageCents;
    if (starterCents === null || growthCents === null) {
      throw new Error("starter and growth publish a catalog overage rate");
    }
    expect(starter.rateMinorPerUnit).toBe(starterCents);
    expect(growth.rateMinorPerUnit).toBe(growthCents);
    // The page quotes two DIFFERENT figures. One global rate made Growth's
    // advertised 12¢ a lie, so this fails if anyone collapses them again.
    expect(starter.rateMinorPerUnit).not.toBe(growth.rateMinorPerUnit);
    expect(starter.configured).toBe(false);
  });

  test("Enterprise publishes a rate, so its overage is rated rather than refused", () => {
    // It used to publish `overageCents: null` — "negotiated" — which meant the
    // rater REFUSED to invoice Enterprise overage at all. A missing invoice is
    // recoverable; a rate nobody can price against is a ceiling with no
    // commercial meaning. The rate card now posts $2.25 per intervention, with
    // the telephony leg passed through at cost + 10%.
    setEnv("OVERAGE_RATE_MINOR_PER_UNIT", undefined);
    expect(planById("enterprise")!.overageCents).toBe(225);
    const r = resolveOverageRate("enterprise");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rateMinorPerUnit).toBe(225);
    expect(r.configured).toBe(false);
  });

  test("the env override beats every plan, and reports itself as configured", () => {
    setEnv("OVERAGE_RATE_MINOR_PER_UNIT", "9");
    for (const id of ["starter", "growth", "enterprise", "pilot"]) {
      const r = resolveOverageRate(id);
      expect(r.ok, id).toBe(true);
      if (r.ok) {
        expect(r.rateMinorPerUnit).toBe(9);
        expect(r.configured).toBe(true);
      }
    }
    restoreEnv();
  });

  test("a malformed override refuses instead of defaulting", () => {
    for (const bad of ["0.15", "abc", "0", "-5"]) {
      setEnv("OVERAGE_RATE_MINOR_PER_UNIT", bad);
      const r = resolveOverageRate("starter");
      expect(r.ok, `bad rate ${bad} must not be accepted`).toBe(false);
      if (!r.ok) expect(r.reason).toBe("rate_invalid");
    }
    restoreEnv();
  });

  test("whitespace means unset, and the plan's own rate applies", () => {
    setEnv("OVERAGE_RATE_MINOR_PER_UNIT", " ");
    const r = resolveOverageRate("starter");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const publishedCents = planById("starter")!.overageCents;
      if (publishedCents === null) throw new Error("starter publishes no overage rate");
      expect(r.rateMinorPerUnit).toBe(publishedCents);
      expect(r.configured).toBe(false);
    }
    restoreEnv();
  });

  test("an org with no resolvable plan still gets the published default", () => {
    setEnv("OVERAGE_RATE_MINOR_PER_UNIT", undefined);
    const r = resolveOverageRate(null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rateMinorPerUnit).toBe(15);
  });
});

describe("no seat cap is invisible", () => {
  test("every plan publishes a seat rule, and a capped plan never publishes zero", () => {
    for (const plan of PLANS) {
      if (plan.seats !== null) {
        expect(plan.seats, `${plan.id} seats`).toBeGreaterThan(0);
        expect(Number.isInteger(plan.seats), `${plan.id} seats integer`).toBe(true);
      }
    }
  });

  test("seats never go DOWN as the price goes UP", () => {
    // A cheaper plan with MORE seats means the cap being enforced is not the cap
    // being sold. `null` is unlimited, so it is the largest value.
    //
    // Over the RECURRING ladder. The Pilot is a different SHAPE — ninety days,
    // bought once, invoiced — so it is not a rung on the subscription ladder,
    // and putting it in the middle of that ladder would assert something false
    // ("a $12,000 engagement includes fewer seats than a $9,000 month"). It
    // carries the same seat count as Growth, which is what a pilot team
    // actually needs: a pilot is staffed, not staffed by one person.
    const recurring = PLANS.filter((p) => p.yearlyUsd !== null);
    const priced = [...recurring].sort((a, b) => a.monthlyUsd! - b.monthlyUsd!);
    for (let i = 1; i < priced.length; i++) {
      const prev = priced[i - 1]!.seats;
      const next = priced[i]!.seats;
      expect(next === null || prev === null || next >= prev, `${priced[i]!.id} seats`).toBe(true);
    }
  });

  test("the seat rule a buyer reads is the rule the enforcement uses", () => {
    // `billing/seats.ts` refuses an invitation from `PLANS[].seats`. If the
    // published copy never mentions seats, the cap is discovered by being
    // refused — so every capped plan must say it in its own bullets.
    for (const plan of PLANS) {
      if (plan.seats === null) continue;
      expect(
        plan.includes.some((line) => /seat/i.test(line)),
        `${plan.id} publishes a ${plan.seats}-seat cap but never says so`,
      ).toBe(true);
    }
  });
});

describe("includedUnitsFromEnv", () => {
  test("unset, blank, negative, fractional and non-numeric all read as no allowance", () => {
    for (const raw of [undefined, "", "-1", "2.5", "many"]) {
      setEnv("INCLUDED_UNITS_PER_PERIOD", raw);
      expect(includedUnitsFromEnv(), `INCLUDED_UNITS_PER_PERIOD=${String(raw)}`).toBe(0);
    }
    setEnv("INCLUDED_UNITS_PER_PERIOD", "0");
    expect(includedUnitsFromEnv()).toBe(0);
    setEnv("INCLUDED_UNITS_PER_PERIOD", "500");
    expect(includedUnitsFromEnv()).toBe(500);
    restoreEnv();
  });
});
