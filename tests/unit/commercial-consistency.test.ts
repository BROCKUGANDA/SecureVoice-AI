import { describe, expect, test } from "bun:test";
import { PLANS, FAQ, COMPANY, SETTLEMENT, formatMonthly } from "../../src/lib/commercial.ts";
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

  test("monthly plans format to the quoted number in both languages", () => {
    const starter = PLANS.find((p) => p.id === "starter")!;
    const pro = PLANS.find((p) => p.id === "pro")!;
    // These were $490 / $1,490 until the Paddle catalog was created at
    // $10 / $40 / $120 on 2026-10-10. The assertion is on the FORMATTING
    // (grouped, no decimals, symbol) rather than on hard-coded literals, so a
    // future price change does not make this test lie about what it checks.
    // `catalog-parity.test.ts` is what pins the actual numbers.
    expect(formatMonthly(starter, "en")).toBe(`$${starter.monthlyUsd!.toLocaleString("en-US")}`);
    expect(formatMonthly(pro, "en")).toBe(`$${pro.monthlyUsd!.toLocaleString("en-US")}`);
    // No cents, ever — these are list prices, not invoices.
    for (const plan of PLANS) {
      expect(formatMonthly(plan, "en")).not.toContain(".");
    }
  });

  test("every plan is purchasable and publishes an offer price", () => {
    // There is no longer a quote-per-deployment tier: all three plans are
    // published and all three are in the Paddle catalog. A plan that reverts to
    // `monthlyUsd: null` without also gaining an offer description would render
    // as "Custom" with no way to buy, which is the failure this catches.
    for (const plan of PLANS) {
      expect(plan.monthlyUsd, `${plan.name} has no published price`).not.toBeNull();
      expect(plan.yearlyUsd, `${plan.name} has no annual price`).not.toBeNull();
      expect(plan.offer.price).toBe(String(plan.monthlyUsd));
    }
  });

  test("annual is exactly ten monthly on every plan", () => {
    // "Two months free", and the same rule the Paddle catalog was seeded with.
    for (const plan of PLANS) {
      expect(plan.yearlyUsd, `${plan.name} annual`).toBe(plan.monthlyUsd! * 10);
    }
  });

  test("settlement is Paddle as Merchant of Record, in USD", () => {
    // Was KES-via-Paystack. Now the quote currency IS the settlement currency
    // (USD) and Paddle is the merchant of record, so there is no second currency
    // to keep in step with the first — but regional prices ARE a second thing to
    // keep in step, and this asserts they are declared.
    expect(SETTLEMENT.rail).toBe("Paddle");
    expect(SETTLEMENT.merchantOfRecord).toBe(true);
    expect(PLANS.every((p) => p.offer.priceCurrency === "USD")).toBe(true);
    expect(SETTLEMENT.note).toContain("Merchant of Record");
    for (const c of SETTLEMENT.regionalCurrencies) expect(SETTLEMENT.note).toContain(c);
  });

  test("the trial is declared and is 7 days", () => {
    // The catalog seeds `trialPeriod: { interval: "day", frequency: 7 }` on every
    // monthly price. If this drifts, the page promises a trial the checkout
    // does not grant.
    expect(SETTLEMENT.trialDays).toBe(7);
    expect(SETTLEMENT.note.length).toBeGreaterThan(40);
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
    // is decided in an incident. The one fact both must state is the shape of
    // the refund.
    const refund = FAQ.find((f) => /refund/i.test(f.q));
    expect(refund).toBeDefined();
    expect(refund!.a).toMatch(/pro rata/i);
    expect(refund!.a).toMatch(/prepaid/i);
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
