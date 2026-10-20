import { describe, expect, test } from "bun:test";
import { INSURANCE_INSTITUTIONS, INSURANCE_LINES, INSURANCE_TERMS } from "@/lib/insurance";

/**
 * The insurance coverage map is content, so the gate checks coverage and the
 * two failure modes that make bilingual product copy dangerous: a duplicate
 * English key with two Arabic renderings, and an Arabic term that is still
 * Latin text.
 */
describe("insurance coverage map", () => {
  test("covers every line the product advertises", () => {
    expect(INSURANCE_LINES.map((l) => l.id)).toEqual([
      "health",
      "life",
      "motor",
      "property",
      "travel",
      "takaful",
    ]);
  });

  test("covers the insurer institution types a buyer may be", () => {
    expect(INSURANCE_INSTITUTIONS.map((i) => i.id)).toEqual([
      "health",
      "life",
      "motor",
      "takaful",
      "broker",
      "reinsurer",
    ]);
  });

  test("every term has one English key and one Arabic rendering", () => {
    const byEnglish = new Map<string, string>();
    for (const term of INSURANCE_TERMS) {
      expect(term.en.trim().length).toBeGreaterThan(0);
      expect(term.ar.trim().length).toBeGreaterThan(0);
      const prior = byEnglish.get(term.en);
      // The English key IS the message: a duplicate key is a duplicate term, and
      // the key names it.
      //
      // `as string` widens the literal union the vocabulary is typed with, so
      // `toBe` is compared against a `string` rather than against the fifteen
      // Arabic literals — the assertion is "the same rendering", not "one of
      // these exact literals".
      if (prior !== undefined) expect(term.ar as string).toBe(prior);
      byEnglish.set(term.en, term.ar);
    }
  });

  test("Arabic terms contain Arabic script and no leftover Latin words", () => {
    for (const item of [...INSURANCE_TERMS, ...INSURANCE_INSTITUTIONS, ...INSURANCE_LINES]) {
      expect(item.ar).toMatch(/[\u0600-\u06ff]/);
      expect(item.ar).not.toMatch(/[A-Za-z]{2,}/);
    }
  });

  test("the Takaful vocabulary is contribution/disbursement, not premium/payout", () => {
    const premium = INSURANCE_TERMS.find((t) => t.id === "premium");
    expect(premium?.ar).toContain("المساهمة");
    expect(INSURANCE_TERMS.find((t) => t.id === "payout")?.ar).toContain("تعويض");
  });
});
