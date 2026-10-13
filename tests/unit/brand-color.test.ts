/**
 * UNIT - the pure colour math behind tenant brand white-labelling.
 *
 * `src/lib/brand/color.ts` is the only thing standing between a bank's
 * submitted string and a CSS custom property in the document head, and it is
 * the only thing that decides whether an operator can read the console. Both
 * failure modes are silent when they happen in a browser — a bad hex produces a
 * default-coloured button that looks like the brand was simply not saved, and an
 * unreadable foreground produces text nobody can read but that still passes a
 * smoke test — so both are asserted here rather than observed.
 *
 * The contrast assertions use ratios recomputed from the published WCAG
 * constants rather than literals copied out of a calculator, so a change to the
 * transfer function shows up as a failing expectation instead of a stale number.
 */

import { describe, expect, test } from "bun:test";
import {
  AA_NON_TEXT_CONTRAST,
  AA_TEXT_CONTRAST,
  DEFAULT_PRIMARY,
  DEFAULT_PRIMARY_FOREGROUND,
  LIGHT_SURFACE,
  brandCssVariables,
  brandStyleSheet,
  contrastRatio,
  evaluateBrandPrimary,
  forLightSurface,
  normalizeHex,
  readableForeground,
  relativeLuminance,
} from "@/lib/brand/color";

describe("normalizeHex", () => {
  test("accepts the two hex forms and lower-cases them", () => {
    expect(normalizeHex("#0B7A55")).toBe("#0b7a55");
    expect(normalizeHex("#abc")).toBe("#aabbcc");
    expect(normalizeHex("  #AbC  ")).toBe("#aabbcc");
  });

  test("expands shorthand by doubling each digit, not by padding", () => {
    // #abc is #aabbcc. Reading it as #aabbcc is the spec; a naive
    // right-pad gives #00aabb and a different colour entirely.
    expect(normalizeHex("#abc")).not.toBe("#00aabb");
  });

  test("refuses everything that is not a 3- or 6-digit hex", () => {
    for (const bad of [
      "",
      "#",
      "#12",
      "#12345",
      "#1234567",
      "#123456789",
      "0b7a55",
      "red",
      "rgb(0,0,0)",
      "hsl(120,50%,25%)",
      "#0b7a55; background: url(x)",
      "#0b7a55ff", // 8-digit alpha is deliberately not accepted
      null,
      undefined,
      42,
      { hex: "#0b7a55" },
    ]) {
      expect(normalizeHex(bad)).toBeNull();
    }
  });

  test("a CSS injection attempt is a parse failure, not a sanitised string", () => {
    // The guarantee that matters: whatever the tenant types, the only characters
    // that reach `brandStyleSheet` are `#` and hex digits. Asserting the refusal
    // here is what makes that true downstream.
    expect(normalizeHex("#000;}body{display:none")).toBeNull();
  });
});

describe("WCAG math", () => {
  test("relative luminance anchors at the documented extremes", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  test("black on white is the maximum 21:1, and the ratio is order-independent", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 2);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 2);
  });

  test("a colour against itself is 1:1", () => {
    expect(contrastRatio("#0b7a55", "#0b7a55")).toBeCloseTo(1, 5);
  });

  test("the default palette meets AA on its own foreground", () => {
    // If this ever fails, the shipped default is unreadable and the bug is in
    // globals.css rather than in anything a tenant did.
    expect(contrastRatio(DEFAULT_PRIMARY, DEFAULT_PRIMARY_FOREGROUND)).toBeGreaterThanOrEqual(
      AA_TEXT_CONTRAST,
    );
  });
});

describe("readableForeground", () => {
  test("picks the light candidate on a dark background and dark on a light one", () => {
    expect(readableForeground("#0b7a55").hex).toBe("#ffffff");
    expect(readableForeground("#f5e642").hex).toBe("#0b0f0c");
  });

  test("the chosen candidate is always the higher-contrast one", () => {
    for (const bg of ["#000000", "#ffffff", "#0b7a55", "#f5e642", "#808080", "#1a1a1a"]) {
      const { hex, ratio } = readableForeground(bg);
      const other = hex === "#ffffff" ? "#0b0f0c" : "#ffffff";
      expect(ratio).toBeGreaterThanOrEqual(contrastRatio(bg, other));
    }
  });
});

describe("evaluateBrandPrimary", () => {
  test("accepts the default and keeps the shipped green", () => {
    const v = evaluateBrandPrimary(DEFAULT_PRIMARY);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.primary).toBe(DEFAULT_PRIMARY);
    // The default green reads on the light card, so the scheme does not correct it.
    expect(v.lightPrimary).toBe(DEFAULT_PRIMARY);
    // The derived foreground is NOT the hand-picked #f4faf7: a computed value
    // maximises its margin against the gate. It only has to agree that the
    // default green wants light text.
    expect(v.lightForeground).toBe("#ffffff");
    expect(v.contrast).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
    // ...and the hand-picked default must still pass, or globals.css is wrong.
    expect(contrastRatio(DEFAULT_PRIMARY, DEFAULT_PRIMARY_FOREGROUND)).toBeGreaterThanOrEqual(
      AA_TEXT_CONTRAST,
    );
  });

  test("normalises before returning, so what is stored is what is applied", () => {
    const v = evaluateBrandPrimary("  #ABC ");
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.primary).toBe("#aabbcc");
    expect(v.lightForeground).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("a pale yellow is accepted by DARKENING the text, not by refusing it", () => {
    // The bank chose yellow. Refusing would be wrong; shipping white text on it
    // would be unreadable. Near-black on yellow is the answer.
    const v = evaluateBrandPrimary("#f5e642");
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.lightForeground).toBe("#0b0f0c");
    expect(v.contrast).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
    expect(contrastRatio(v.lightPrimary, v.lightForeground)).toBeCloseTo(v.contrast, 1);
  });

  test("stores the tenant's CHOICE, not the corrected value", () => {
    // A near-white brand is corrected downward for the light card. The stored
    // value must still be what the tenant picked, or the settings form and the
    // console would show two different colours as "the brand".
    const v = evaluateBrandPrimary("#fefefe");
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.primary).toBe("#fefefe");
    expect(v.lightPrimary).not.toBe("#fefefe");
    expect(contrastRatio(v.lightPrimary, LIGHT_SURFACE)).toBeGreaterThanOrEqual(
      AA_NON_TEXT_CONTRAST,
    );
  });

  test("white is corrected, not refused", () => {
    // White passes the TEXT check (dark text on white is fine) but its button
    // edge vanishes into a white card. The non-text check is the one that
    // catches it, and the answer is a correction rather than a refusal.
    const v = evaluateBrandPrimary("#ffffff");
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.primary).toBe("#ffffff");
    expect(v.lightPrimary).not.toBe("#ffffff");
    expect(contrastRatio(v.lightPrimary, LIGHT_SURFACE)).toBeGreaterThanOrEqual(
      AA_NON_TEXT_CONTRAST,
    );
  });

  test("black needs no correction on the light card, not refused", () => {
    // Black is already maximally dark — it cannot be darkened further, and it
    // clears 3:1 against white by a huge margin. The function returns it
    // unchanged at step 0, which is the correct outcome.
    const v = evaluateBrandPrimary("#000000");
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.primary).toBe("#000000");
    expect(v.lightPrimary).toBe("#000000");
    expect(contrastRatio(v.lightPrimary, LIGHT_SURFACE)).toBeGreaterThanOrEqual(
      AA_NON_TEXT_CONTRAST,
    );
  });

  test("refuses a non-hex with a reason the operator can act on", () => {
    const v = evaluateBrandPrimary("chartreuse");
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("invalid");
    expect(v.detail).toContain("#0b7a55");
  });

  test("every verdict that is ok reports a foreground that actually passes", () => {
    // A sweep, because the gate is the kind of code that is correct for the
    // colours anyone thought to try and wrong for the ones nobody did.
    for (let r = 0; r < 256; r += 17) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 17) {
          const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
          const v = evaluateBrandPrimary(hex);
          if (!v.ok) continue;
          expect(contrastRatio(v.lightPrimary, v.lightForeground)).toBeGreaterThanOrEqual(
            AA_TEXT_CONTRAST,
          );
          // And the control is not invisible against its own card.
          expect(contrastRatio(v.lightPrimary, LIGHT_SURFACE)).toBeGreaterThanOrEqual(
            AA_NON_TEXT_CONTRAST,
          );
        }
      }
    }
  });

  test("the ok/unreadable split covers every colour: something is always returned", () => {
    for (let v8 = 0; v8 < 256; v8 += 5) {
      const hex = `#${v8.toString(16).padStart(2, "0").repeat(3)}`;
      const v = evaluateBrandPrimary(hex);
      expect(typeof v.ok).toBe("boolean");
      if (!v.ok) expect(v.reason).toBe("unreadable");
    }
  });
});

describe("forLightSurface", () => {
  test("leaves a colour that already reads on the light card alone", () => {
    expect(forLightSurface("#0b7a55")).toBe("#0b7a55");
  });

  test("darkens a near-white brand until it clears the non-text threshold", () => {
    const fixed = forLightSurface("#fefefe");
    expect(fixed).not.toBe("#fefefe");
    expect(contrastRatio(fixed, LIGHT_SURFACE)).toBeGreaterThanOrEqual(AA_NON_TEXT_CONTRAST);
  });

  test("stops at the FIRST passing grey, not at black", () => {
    // Symmetric to the dark-mode case: #8c8c8c already clears 3:1 against white,
    // and darkening further would throw away the tenant's colour for nothing.
    const fixed = forLightSurface("#ffffff");
    expect(fixed).not.toBe("#ffffff");
    expect(fixed).not.toBe("#000000");
    expect(contrastRatio(fixed, LIGHT_SURFACE)).toBeGreaterThanOrEqual(AA_NON_TEXT_CONTRAST);
  });

  test("is deterministic", () => {
    expect(forLightSurface("#fafafa")).toBe(forLightSurface("#fafafa"));
  });
});

describe("brandStyleSheet", () => {
  test("overrides the tokens that carry the brand and leaves the tints alone", () => {
    const v = evaluateBrandPrimary("#123456");
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const vars = brandCssVariables(v);
    expect(vars["--primary"]).toBe("#123456");
    expect(vars["--ring"]).toBe("#123456");
    expect(vars["--sidebar-primary"]).toBe("#123456");
    // A tint derived from the old green would be wrong under a blue brand.
    expect(vars["--accent"]).toBeUndefined();
    expect(vars["--green-tint"]).toBeUndefined();
  });

  test("emits a single light rule", () => {
    const v = evaluateBrandPrimary("#123456");
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const css = brandStyleSheet(v);
    expect(css).not.toBeNull();
    expect(css).toStartWith(":root{");
    expect(css).not.toContain(".dark");
  });

  test("is null for a refused colour, so a bad tenant setting renders nothing", () => {
    expect(brandStyleSheet(evaluateBrandPrimary("nope"))).toBeNull();
  });

  test("every emitted VALUE is a six-digit hex — nothing else reaches the <style>", () => {
    // The security property. Property names are expected; the values are not
    // expected to be anything but hex, because this string is written into a
    // <style> element in the document head.
    const v = evaluateBrandPrimary("#0b7a55");
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const css = brandStyleSheet(v) ?? "";
    const values = [...css.matchAll(/:([^;{}]+)[;}]/g)].map((m) => (m[1] ?? "").trim());
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }

    // The selectors are fixed, so an unexpected one would mean the serialiser
    // grew a branch. Anything outside this set is a bug, not a new feature.
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].map((m) => (m[1] ?? "").trim());
    expect(new Set(selectors)).toEqual(new Set([":root"]));

    // The properties are the fixed token set.
    const ALLOWED = [
      "--primary",
      "--primary-foreground",
      "--ring",
      "--sidebar-primary",
      "--sidebar-primary-foreground",
    ];
    const props = [...css.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1] ?? "");
    expect(props.length).toBe(ALLOWED.length);
    for (const p of props) expect(ALLOWED).toContain(p);
  });
});
