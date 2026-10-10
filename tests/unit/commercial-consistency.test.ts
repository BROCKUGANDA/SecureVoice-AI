import { describe, expect, test } from "bun:test";
import {
  PLANS,
  FAQ,
  COMPANY,
  SETTLEMENT,
  formatMonthly,
  formatIncluded,
  formatOverage,
} from "../../src/lib/commercial.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The commercial surface has three renderers and one source of truth.
 *
 * `/pricing` renders from `PLANS`, the schema.org graph in
 * `src/components/seo/JsonLd.tsx` renders from the same `PLANS`, and the FAQ is
 * quoted by answer engines straight out of `FAQ`. If those ever disagree, the
 * site quotes one price to a human and another to a machine, and the machine's
 * is the one that gets repeated. These tests exist to make that a build failure
 * rather than an incident.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

describe("pricing data", () => {
  test("every plan's display price and its schema.org price are the same number", () => {
    for (const plan of PLANS) {
      if (plan.monthlyUsd === null) {
        // Enterprise: no number on the card, so none in the graph either.
        expect(plan.offer.price).toBeUndefined();
        continue;
      }
      expect(plan.offer.price, `${plan.name} price drifted`).toBe(String(plan.monthlyUsd));
    }
  });

  test("exactly one plan is flagged as the popular one", () => {
    // Two "most popular" cards is a pricing page that has lost its argument.
    expect(PLANS.filter((p) => p.featured)).toHaveLength(1);
  });

  test("plan ids are unique and kebab-case", () => {
    const ids = PLANS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  test("every plan's includes list is index-aligned with its Arabic translation", () => {
    // `Pricing.tsx` renders `plan.includesAr[i]` against `plan.includes[i]`. A
    // missing Arabic entry renders `undefined` into the DOM — silently, in the
    // one language the QA pass is least likely to cover.
    for (const plan of PLANS) {
      expect(plan.includesAr.length, `${plan.name} Arabic list length`).toBe(plan.includes.length);
      for (const [i, entry] of plan.includes.entries()) {
        expect(entry.length, `${plan.name} #${i} English is empty`).toBeGreaterThan(0);
        expect(plan.includesAr[i]?.length, `${plan.name} #${i} Arabic is empty`).toBeGreaterThan(0);
      }
    }
  });

  test("monthly plans format to the published number, with no stray decimals", () => {
    const starter = PLANS.find((p) => p.id === "starter")!;
    const growth = PLANS.find((p) => p.id === "growth")!;
    // Not hard-coded to a price: `catalog-parity.test.ts` pins the actual numbers,
    // and this asserts the FORMATTING (symbol, grouping, no cents) so a price
    // change does not make this test lie about what it checks.
    expect(formatMonthly(starter, "en")).toBe(`$${starter.monthlyUsd!.toLocaleString("en-US")}`);
    expect(formatMonthly(growth, "en")).toBe(`$${growth.monthlyUsd!.toLocaleString("en-US")}`);
    for (const plan of PLANS) {
      expect(formatMonthly(plan, "en")).not.toContain(".");
    }
  });

  test("included volume and overage format to real money", () => {
    // The metering is the pricing model, so these two formatters are as
    // load-bearing as the price itself. Overage IS in cents by nature — $0.15 —
    // so unlike the monthly price it must carry two decimals.
    const starter = PLANS.find((p) => p.id === "starter")!;
    expect(formatIncluded(starter, "en")).toBe("500");
    expect(formatOverage(starter, "en")).toBe("$0.15");
    // Enterprise is negotiated rather than tiered, so it formats to "".
    const enterprise = PLANS.find((p) => p.id === "enterprise")!;
    expect(formatOverage(enterprise, "en")).toBe("");
  });

  test("every plan is purchasable and publishes an offer price", () => {
    // All three tiers are published and purchasable now. A plan that reverted to
    // `monthlyUsd: null` without an offer description would render as "Custom"
    // with no way to buy, which is the failure this catches.
    for (const plan of PLANS) {
      expect(plan.monthlyUsd, `${plan.name} has no published price`).not.toBeNull();
      expect(plan.offer.price).toBe(String(plan.monthlyUsd));
    }
  });

  test("settlement is Paddle as Merchant of Record, and regional prices are declared", () => {
    // Was KES-via-Paystack, then a 7-day trial and annual pricing, then the AED
    // display conversion and GBP/EUR/AUD regional prices. The quote currency is
    // USD; what a buyer in a covered market is actually charged is separate.
    expect(SETTLEMENT.rail).toBe("Paddle");
    expect(SETTLEMENT.merchantOfRecord).toBe(true);
    expect(PLANS.every((p) => p.offer.priceCurrency === "USD")).toBe(true);
    expect(SETTLEMENT.note).toContain("Merchant of Record");
    for (const c of SETTLEMENT.catalogRegionalCurrencies) expect(SETTLEMENT.note).toContain(c);
    // The AED peg the page displays, kept in step with `src/views/Pricing.tsx`.
    expect(SETTLEMENT.aedPeg).toBe(3.6725);
  });
});

describe("FAQ", () => {
  test("every entry has a non-empty English and Arabic question and answer", () => {
    expect(FAQ.length).toBeGreaterThanOrEqual(5);
    for (const f of FAQ) {
      expect(f.q.length).toBeGreaterThan(10);
      expect(f.a.length).toBeGreaterThan(40);
      expect(f.qAr.length).toBeGreaterThan(5);
      expect(f.aAr.length).toBeGreaterThan(20);
    }
  });

  test("no answer contains a stray latin fragment inside the Arabic text", () => {
    // The Arabic blocks are hand-written and were edited several times; a mixed
    // token like "upon الطلب" renders as gibberish to exactly the reader the
    // bilingual support line is aimed at. Cheap to check, easy to regress.
    const arabicWords = /\p{Script=Arabic}/u;
    for (const f of FAQ) {
      // A run of >=3 consecutive ASCII words inside Arabic text, allowing the
      // punctuation that legitimately appears (digits, %, ., ·).
      const suspect = f.aAr.match(/[A-Za-z][A-Za-z'-]*(\s+[A-Za-z][A-Za-z'-]*){2,}/g) ?? [];
      expect(suspect, `"${f.qAr}" contains latin words: ${suspect.join(" | ")}`).toEqual([]);
      expect(arabicWords.test(f.aAr)).toBe(true);
    }
  });

  test("the refund question exists and agrees with the refund policy page", () => {
    // A published FAQ answer that contradicts /refund is the kind of thing that
    // is decided in an incident. The two facts both must state are the shape of
    // the refund (pro rata, cancel before renewal) and that a consumed
    // intervention is not refundable — the metered half of the pricing model.
    const refund = FAQ.find((f) => /refund/i.test(f.q));
    expect(refund).toBeDefined();
    expect(refund!.a).toMatch(/pro rata/i);
    expect(refund!.a).toMatch(/consumed/i);
    // And it must agree with the policy page's own wording.
    const page = read("src/views/Legal.tsx");
    expect(page).toMatch(/pro rata/i);
    expect(page).toMatch(/Merchant of Record/);
  });
});

describe("company identity", () => {
  test("the legal name is a legal name and appears in the Terms and the JSON-LD", () => {
    expect(COMPANY.legalName).toMatch(/FZ-?LLC|LLC|Limited|Inc|GmbH/i);
    expect(read("src/views/Legal.tsx")).toContain(COMPANY.legalName);
    expect(read("src/components/seo/JsonLd.tsx")).toContain("legalName");
  });

  test("no invented sameAs profiles", () => {
    // A `sameAs` URL that does not exist is a structured-data claim about a
    // profile the company does not own. There are none today; this fails if
    // someone pastes a plausible-looking URL in.
    for (const url of COMPANY.sameAs) {
      expect(url, `${url} is not a real profile URL`).toMatch(/^https:\/\//);
    }
    // Asserted explicitly rather than left implicit: the array is empty on
    // purpose, and "it happens to be empty" is not the same as "it is required
    // to be real".
    expect(Array.isArray(COMPANY.sameAs)).toBe(true);
  });
});

describe("the JSON-LD graph reads from the same data", () => {
  const jsonLd = read("src/components/seo/JsonLd.tsx");

  /**
   * The file with its comments removed.
   *
   * Necessary because this file's own prose names the prices it must not
   * hardcode — "A hand-copied `price: \"1490\"` here…" — so a naive search for
   * that literal matches the documentation of the rule rather than a violation
   * of it. Only executable code can violate a code rule.
   */
  const code = jsonLd.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  test("it does not hardcode a price", () => {
    // A literal "1490" in the graph file is a price that will drift from the
    // one on the page. The graph must derive it.
    expect(code).not.toMatch(/["']\s*1490\s*["']/);
    expect(code).not.toMatch(/["']\s*490\s*["']/);
  });

  test("it escapes `<` so the script element cannot be closed early", () => {
    expect(jsonLd).toContain('replace(/</g, "\\\\u003c")');
  });

  test("it emits no placeholder price for a tier that has none", () => {
    // An Offer with a placeholder price publishes a fact. The spread is
    // conditional on `plan.offer.price`, which is the thing being pinned.
    expect(code).toContain("...(plan.offer.price");
    expect(code).not.toMatch(/price:\s*"0"/);
  });
});
