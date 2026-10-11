import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEMO_POLICY,
  CREDIT_WALLET_POLICY,
  UNIMPLEMENTED_POLICY_CLAUSES,
  REFUND_POLICIES,
} from "../../src/lib/legal-policies.ts";

/**
 * The two refund surfaces must agree.
 *
 * They used to not: `/pricing` said purchased credits were non-refundable and
 * expired after 12 months, while `/refund` said unspent credits were "refundable
 * in full on request at any time". Two public pages, opposite answers to whether
 * a customer can have their money back — found only because someone read both.
 *
 * The assertions here are on the SHARED source, so editing one page cannot
 * reintroduce it. The second block checks that both pages actually render from
 * that source rather than carrying their own copy.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

describe("the refund facts are internally consistent", () => {
  test("credits are non-refundable, exactly once, in one direction", () => {
    const all = [...DEMO_POLICY, ...CREDIT_WALLET_POLICY];
    const refundable = all.filter((c) => /refundable in full|refundable while unspent/i.test(c.en));
    expect(
      refundable.map((c) => c.id),
      "a clause promising refundable unspent credits contradicts the wallet policy",
    ).toEqual([]);
  });

  test("the expiry term appears once and only once", () => {
    // Two different expiry periods would be a contradiction; none at all would
    // mean the clause was dropped.
    const withExpiry = [...DEMO_POLICY, ...CREDIT_WALLET_POLICY].filter((c) =>
      /expire \d+ months/i.test(c.en),
    );
    expect(withExpiry.map((c) => c.id)).toEqual(["credit_purchases"]);
    expect(withExpiry[0]!.en).toMatch(/expire 12 months/i);
  });

  test("both policy kinds are addressed, and neither is empty", () => {
    expect(REFUND_POLICIES.demo.clauses.length).toBeGreaterThan(0);
    expect(REFUND_POLICIES.creditWallet.clauses.length).toBeGreaterThan(0);
  });

  test("every clause has an English and an Arabic rendering of equal presence", () => {
    for (const c of [...DEMO_POLICY, ...CREDIT_WALLET_POLICY]) {
      expect(c.en.length, `${c.id} en`).toBeGreaterThan(40);
      expect(c.ar.length, `${c.id} ar`).toBeGreaterThan(20);
      expect(c.ar, `${c.id} ar must actually be Arabic`).toMatch(/\p{Script=Arabic}/u);
    }
  });
});

describe("both public surfaces render from the shared source", () => {
  test("Pricing.tsx carries no inline refund copy of its own", () => {
    // It used to: `DemoPolicy` and `CreditWalletPolicy` were written out in full
    // inside the view. That is how the two pages drifted. The strings are now
    // imported, so this asserts the distinctive phrases do NOT appear in the
    // view as literals.
    const pricing = read("src/views/Pricing.tsx");
    expect(pricing).not.toContain("Purchased credits are non-refundable and unused credits expire");
    expect(pricing).not.toContain("is provided free of charge strictly for");
  });

  test("Legal.tsx carries no inline refund copy of its own", () => {
    const legal = read("src/views/Legal.tsx");
    expect(legal).not.toContain("refundable while they are unspent");
    expect(legal).not.toContain("Unspent credits are refundable in full");
  });

  test("the page describes the credit wallet, not a subscription", () => {
    // There is no annual plan and no unused period to pro-rate, so a
    // subscription-cancellation policy would describe an unbuyable product.
    const legal = read("src/views/Legal.tsx");
    expect(legal).not.toMatch(/unused portion of that period pro rata/i);
    expect(legal).toMatch(/prepaid Credit Wallet/i);
  });
});

describe("clauses the code does not implement are flagged, not hidden", () => {
  test("the unimplemented clauses are the ones the header names", () => {
    // A policy is a promise; an automation is a kept promise. These four are the
    // former without the latter, and they are tagged so that adding a fifth is a
    // deliberate act rather than a drift.
    expect([...UNIMPLEMENTED_POLICY_CLAUSES].sort()).toEqual(
      ["chargebacks", "credit_purchases", "failed_interventions", "sla_credits"].sort(),
    );
  });

  test("no unimplemented clause is tagged as implemented", () => {
    for (const c of CREDIT_WALLET_POLICY) {
      if (c.unimplemented) expect(UNIMPLEMENTED_POLICY_CLAUSES).toContain(c.id);
    }
  });
});
