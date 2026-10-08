/**
 * The Shariah term filter must cover EVERY script in the caller base.
 *
 * P1-3 was that the filter had Latin and Arabic rulesets but no Urdu one, so a
 * takaful customer speaking Urdu heard "insurance" (انشورنس) instead of "takaful"
 * (تکافل) — the tenant declared the substitution and it was simply absent for
 * Urdu script. This pins the Urdu ruleset, and pins that adding it did not
 * regress the Latin or Arabic behavior it sits beside.
 */
import { describe, expect, test } from "bun:test";
import { applyShariahTerms, prepareSpeech } from "@/lib/compliance/speech-gate";

describe("Urdu Shariah terms (P1-3)", () => {
  test("rewrites the Urdu word for insurance to takaful", () => {
    const { text, applied } = applyShariahTerms("آپ کا انشورنس فعال ہے");
    expect(text).toContain("تکافل");
    expect(text).not.toContain("انشورنس");
    expect(applied.length).toBeGreaterThan(0);
  });

  test("consumes the compound before the bare noun (longest-first)", () => {
    // The whole phrase "life insurance" collapses to "takaful" (as the Latin
    // rule does), with no leftover "insurance" surviving the substitution.
    const { text } = applyShariahTerms("یہ لائف انشورنس پالیسی ہے");
    expect(text).toContain("تکافل");
    expect(text).not.toContain("انشورنس");
  });

  test("rewrites the Sanskrit-rooted insurance term too (بیمہ → تکافل)", () => {
    const { text } = applyShariahTerms("آپ کی بیمہ");
    expect(text).toContain("تکافل");
    expect(text).not.toContain("بیمہ");
  });

  test("does not fire when the tenant is NOT Shariah-compliant", () => {
    const conventional = prepareSpeech("your انشورنس is active", { shariahCompliant: false });
    expect(conventional.text).toContain("انشورنس");
    expect(conventional.substitutions).toHaveLength(0);

    const shariah = prepareSpeech("your انشورنس is active", { shariahCompliant: true });
    expect(shariah.text).toContain("تکافل");
  });
});

describe("Latin and Arabic rulesets are unchanged by the Urdu addition", () => {
  test("Latin insurance -> takaful still fires", () => {
    const { text } = applyShariahTerms("Auto Insurance Ltd");
    expect(text).toBe("Auto Takaful Ltd");
  });

  test("Arabic التأمين -> التكافل still fires", () => {
    const { text } = applyShariahTerms("شركة التأمين");
    expect(text).toContain("التكافل");
    expect(text).not.toContain("التأمين");
  });
});
