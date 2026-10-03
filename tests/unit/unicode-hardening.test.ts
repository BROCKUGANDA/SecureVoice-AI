/**
 * UNIT — hostile display-string normalisation (src/lib/validation/unicode.ts).
 *
 * This is the anti-homograph layer for merchant names, cardholder names and
 * anything else rendered back to an operator. Its whole purpose is that a
 * display string cannot lie about its own rendered identity, so the tests here
 * are adversarial rather than round-trip:
 *
 *   · Bidi controls are stripped. A merchant name using RLO to render as
 *     "BANK OF" while the bytes say something else defeats a human reviewer
 *     reading a case console — this is the "Аpple Store" class of attack.
 *   · Zero-width characters are stripped. "Аррle" with a zero-width joiner
 *     between characters passes every naive exact-match blocklist.
 *   · C0/C1 controls are stripped, which doubles as a log-injection control.
 *   · The grapheme cap never splits a cluster, so an emoji ZWJ sequence or a
 *     combining mark is not cut into replacement glyphs.
 *   · Homoglyph folding happens ONLY in a mixed-script context. Folding a
 *     single-script string would corrupt genuine Cyrillic or Arabic names — the
 *     module explicitly must not do that, and a test is the only thing holding
 *     that line.
 *   · `normalizeHostileText` output always satisfies `isSafeDisplayText`. That
 *     composition is the post-condition every database write relies on, so it is
 *     asserted as a property rather than per-case.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_GRAPHEMES,
  countGraphemes,
  dominantScript,
  foldHomoglyphs,
  hasMixedScript,
  isSafeDisplayText,
  normalizeHostileText,
  safeText,
  truncateGraphemes,
} from "@/lib/validation/unicode";

describe("countGraphemes / truncateGraphemes", () => {
  test("counts ASCII code units as one each", () => {
    expect(countGraphemes("hello")).toBe(5);
    expect(countGraphemes("")).toBe(0);
  });

  test("counts an emoji ZWJ sequence as one cluster, not many code units", () => {
    // A naive code-unit count would report 3+ and split the cluster.
    expect(countGraphemes("\u{1F468}‍\u{1F469}‍\u{1F467}")).toBe(1);
  });

  test("counts a combining sequence as one cluster", () => {
    expect(countGraphemes("é")).toBe(1);
  });

  test("a string at or under the cap is not truncated", () => {
    expect(truncateGraphemes("abc", 3)).toEqual({ value: "abc", truncated: false });
    expect(truncateGraphemes("abc", 10)).toEqual({ value: "abc", truncated: false });
  });

  test("truncation reports truncated and cuts to exactly the cap", () => {
    const r = truncateGraphemes("abcdefgh", 3);
    expect(r.truncated).toBe(true);
    expect(r.value).toBe("abc");
  });

  test("truncation never splits a cluster into a lone surrogate", () => {
    // The whole reason this counts graphemes: a code-unit cap would leave half a
    // surrogate pair behind, which renders as a replacement glyph.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const r = truncateGraphemes(family, 1);
    expect(r.value).toBe(family);
    expect(r.value).not.toContain("\uFFFD");
    // No lone surrogate survives.
    for (let i = 0; i < r.value.length; i += 1) {
      const code = r.value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        expect(r.value.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
      }
    }
  });

  test("a zero cap yields an empty string", () => {
    expect(truncateGraphemes("abc", 0)).toEqual({ value: "", truncated: true });
  });

  test("the default cap is 64 graphemes", () => {
    expect(DEFAULT_MAX_GRAPHEMES).toBe(64);
    const r = truncateGraphemes("x".repeat(100), DEFAULT_MAX_GRAPHEMES);
    expect(r.value).toHaveLength(64);
  });
});

describe("script detection", () => {
  test("a single-script string is not mixed", () => {
    expect(hasMixedScript("МОСКВА Банк")).toBe(false);
    expect(hasMixedScript("Cafe de Paris")).toBe(false);
  });

  test("Latin mixed with Cyrillic is mixed — the homograph signal", () => {
    expect(hasMixedScript("МАРКЕТ Store")).toBe(true);
  });

  test("digits and punctuation alone are not a mix", () => {
    // Otherwise every price would be flagged.
    expect(hasMixedScript("123-456-7890")).toBe(false);
    expect(hasMixedScript("!!! *** ###")).toBe(false);
    expect(hasMixedScript("")).toBe(false);
  });

  test("dominantScript reports the majority script", () => {
    expect(dominantScript("hello world")).toBe("latin");
    expect(dominantScript("Привет")).toBe("cyrillic");
    expect(dominantScript("123")).toBeNull();
  });

  test("Japanese kana counts as one script family, not a mix", () => {
    // Hiragana + katakana + han is a normal Japanese name.
    expect(hasMixedScript("さくら")).toBe(false);
    expect(hasMixedScript("さくら カタカナ")).toBe(false);
  });
});

describe("foldHomoglyphs", () => {
  test("a single-script string is never folded", () => {
    // Folding genuine Cyrillic here would corrupt real names — the module
    // explicitly refuses, and that refusal is the property.
    const r = foldHomoglyphs("Привет");
    expect(r.folded).toBe(false);
    expect(r.value).toBe("Привет");
  });

  test("a mixed-script string folds confusables to Latin", () => {
    const r = foldHomoglyphs("МАРКЕТ Store");
    expect(r.folded).toBe(true);
    expect(r.value).toContain("Store");
    // Glyph-wise, NOT dictionary-aware: М→M, А→A, Р→P, К→K, Е→E, Т→T. So the
    // Cyrillic МАРКЕТ folds to "MAPKET", not "MARKET" — the table maps single
    // glyphs and deliberately holds no word list. The property that matters is
    // that the spoofed string stops being script-mixed, not that it spells a word.
    expect(r.value).toBe("MAPKET Store");
    expect(hasMixedScript(r.value)).toBe(false);
  });

  test("source case is preserved through the fold", () => {
    const lower = foldHomoglyphs("раypal store");
    expect(lower.value).toContain("paypal");
    const upper = foldHomoglyphs("РАYPAL Store");
    expect(upper.value).toContain("PAYPAL");
  });

  test("characters with no confusable mapping are left intact", () => {
    const r = foldHomoglyphs("МАРКЕТ مرحبا");
    // The Arabic is not in the table and must survive rather than be dropped.
    expect(r.value).toContain("مرحبا");
  });
});

describe("normalizeHostileText — invisible character removal", () => {
  test("bidi controls are stripped and reported", () => {
    const r = normalizeHostileText("BANK\u202Eof Evil");
    expect(r.value).not.toContain("\u202E");
    expect(r.removals).toContain("bidi");
  });

  test("bidi marks are stripped", () => {
    const r = normalizeHostileText("safe\u200Ftext");
    expect(r.value).not.toContain("\u200F");
  });

  test("zero-width characters are stripped and reported", () => {
    const r = normalizeHostileText("A\u200Bpple");
    expect(r.value).not.toContain("\u200B");
    expect(r.removals).toContain("zero-width");
  });

  test("a BOM is stripped", () => {
    expect(normalizeHostileText("\uFEFFhello").value).toBe("hello");
  });

  test("C0 and C1 controls are stripped — this is also log-injection control", () => {
    const r = normalizeHostileText("user\u0000admin\n\rInjected");
    expect(r.value).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    expect(r.removals).toContain("control");
  });

  test("whitespace is collapsed and trimmed", () => {
    expect(normalizeHostileText("  a   b  ").value).toBe("a b");
    expect(normalizeHostileText("a\u00A0b").value).toBe("a b");
  });

  test("the output of a hostile input is always safe to display", () => {
    const hostile = [
      "BANK\u202E of Evil",
      "A\u200Bpple Store",
      "user\u0000admin",
      "\uFEFF\u200F\u200Ehidden",
      "МАРКЕТ Store",
      "  padded  ",
    ];
    for (const input of hostile) {
      const r = normalizeHostileText(input);
      expect(isSafeDisplayText(r.value)).toBe(true);
    }
  });
});

describe("normalizeHostileText — NFKC folding", () => {
  test("fullwidth characters fold to ASCII", () => {
    // Ａｐｐｌｅ (fullwidth) → Apple.
    expect(normalizeHostileText("Ａｐｐｌｅ").value).toBe("Apple");
  });

  test("circled and superscript forms fold", () => {
    expect(normalizeHostileText("①").value).toBe("1");
  });

  test("a fullwidth spoof of a known merchant collapses to the real name", () => {
    // The reason NFKC is step 2: an exact-match allowlist on "PayPal" must
    // catch the fullwidth rendition, or the blocklist is decorative.
    expect(safeText("ＰａｙＰａｌ")).toBe("PayPal");
  });
});

describe("normalizeHostileText — non-string input", () => {
  test("null and undefined become the empty string, not the text 'null'", () => {
    expect(normalizeHostileText(null).value).toBe("");
    expect(normalizeHostileText(undefined).value).toBe("");
  });

  test("numbers and booleans are stringified", () => {
    expect(normalizeHostileText(42).value).toBe("42");
    expect(normalizeHostileText(true).value).toBe("true");
  });

  test("an object becomes a non-empty string rather than throwing", () => {
    expect(() => normalizeHostileText({ a: 1 })).not.toThrow();
    expect(typeof normalizeHostileText({ a: 1 }).value).toBe("string");
  });

  test("an array is handled without throwing", () => {
    expect(() => normalizeHostileText(["a", "b"])).not.toThrow();
  });
});

describe("normalizeHostileText — bounds", () => {
  test("over-long input is truncated and reported", () => {
    const r = normalizeHostileText("x".repeat(5000), { maxInputLength: 100 });
    expect(r.removals).toContain("truncated");
    expect(r.value.length).toBeLessThanOrEqual(100);
  });

  test("the grapheme cap is honoured and reported", () => {
    const r = normalizeHostileText("y".repeat(200), { maxGraphemes: 10 });
    expect(countGraphemes(r.value)).toBe(10);
    expect(r.removals).toContain("truncated");
  });

  test("a huge input cannot force unbounded work", () => {
    // Bounded by maxInputLength before any normalisation runs.
    const r = normalizeHostileText("\u202E".repeat(100_000), { maxInputLength: 64 });
    expect(r.value).toBe("");
    expect(r.value.length).toBeLessThanOrEqual(64);
  });

  test("changed is false for an already-clean string", () => {
    const r = normalizeHostileText("Clean Merchant");
    expect(r.value).toBe("Clean Merchant");
    expect(r.changed).toBe(false);
    expect(r.removals).toHaveLength(0);
  });

  test("changed is true when anything was altered", () => {
    expect(normalizeHostileText("A\u200Bpple").changed).toBe(true);
  });

  test("the result is stable — re-normalising changes nothing", () => {
    const once = normalizeHostileText("  B\u202E  A\u200BNK\u0000  ");
    const twice = normalizeHostileText(once.value);
    expect(twice.value).toBe(once.value);
    expect(twice.changed).toBe(false);
  });

  test("safeText returns just the string", () => {
    expect(safeText("  A  B  ")).toBe("A B");
  });

  test("graphemes is reported for the final value", () => {
    const r = normalizeHostileText("hello world");
    expect(r.graphemes).toBe(countGraphemes("hello world"));
  });
});

describe("isSafeDisplayText", () => {
  test("accepts ordinary text", () => {
    expect(isSafeDisplayText("Cafe de Paris")).toBe(true);
    expect(isSafeDisplayText("")).toBe(true);
  });

  test("rejects anything carrying an invisible control", () => {
    for (const bad of ["A\u202EB", "A\u200FB", "A\u200BB", "A\uFEFFB", "A\u0000B", "A\u001FB"]) {
      expect(isSafeDisplayText(bad)).toBe(false);
    }
  });

  test("rejects untrimmed text", () => {
    expect(isSafeDisplayText(" padded ")).toBe(false);
  });

  test("rejects a non-NFKC string", () => {
    expect(isSafeDisplayText("Ａ")).toBe(false);
  });
});
