/**
 * Tenant brand colour: parsing, and the contrast gate that decides whether a
 * bank's colour is allowed to reach the screen.
 *
 * ## Why this module exists rather than a `style={{ background: org.brand }}`
 *
 * A tenant picks one hex. Three things then have to be true at once, and none
 * of them is the tenant's problem to solve:
 *
 *   1. The hex has to be a hex. `javascript:alert(1)` is a string like any
 *      other, and this value is interpolated into a CSS custom property that
 *      reaches a `<style>` element in the document head.
 *   2. Text on top of that colour has to be readable. The default foreground is
 *      `#f4faf7`, a near-white chosen for the default green. A bank's yellow or
 *      pale blue turns that into white-on-pale, which is unreadable — and the
 *      console is the surface an analyst uses to decide whether a customer's
 *      money is being moved.
 *   3. The same colour has to survive DARK MODE, where it sits on `#121814`
 *      rather than white. A dark navy brand is invisible there.
 *
 * The gate therefore REJECTS at save time rather than degrading at render time.
 * A colour that cannot pass never enters the database, so no screen has to
 * decide what to do with it.
 *
 * ## The thresholds, and why they are what they are
 *
 *   · 4.5:1 against the chosen foreground — WCAG 2.1 AA for normal text. The
 *     console's primary buttons carry 13-14px labels, which is body text, not
 *     large text, so the 3:1 large-text allowance does not apply.
 *   · 3:1 against the dark surface — WCAG 1.4.11 non-text contrast. The button
 *     has to be distinguishable from the page behind it; this is about the
 *     EDGE of the control, not the text on it.
 *
 * Both are the published numbers rather than a house style, because the argument
 * with a bank's accessibility reviewer is much shorter when the threshold is one
 * they already know.
 *
 * ## No colour is rejected for being dark or light
 *
 * There is no "too light" rule. Near-white brands are darkened toward black and
 * near-black brands are lightened toward white, in fixed steps, until they pass.
 * A bank's palette is theirs; this module's only opinion is that the result has
 * to be legible.
 */

// ── the defaults this module falls back to ────────────────────────────────────
// Mirrors globals.css `:root`. Duplicated deliberately: importing a CSS file into
// a module that runs on the server and in tests is not possible, and a literal
// that can drift is better than a token that cannot be read. `tests/unit/brand-color.test.ts`
// asserts these still match the stylesheet.
export const DEFAULT_PRIMARY = "#0b7a55";
export const DEFAULT_PRIMARY_FOREGROUND = "#f4faf7";

/** globals.css `.dark` `--card`. The surface a brand-coloured control sits on in dark mode. */
export const DARK_SURFACE = "#121814";

/** globals.css `:root` `--card`. The same control, light scheme. */
export const LIGHT_SURFACE = "#ffffff";

/** WCAG 2.1 AA, normal text. */
export const AA_TEXT_CONTRAST = 4.5;

/** WCAG 2.1 §1.4.11, non-text contrast. */
export const AA_NON_TEXT_CONTRAST = 3;

/**
 * The two candidates for text sitting ON the brand colour.
 *
 * Deliberately pure `#ffffff` and a near-black rather than the palette's
 * `#f4faf7` / `#07130d`: a DERIVED value should maximise its margin against the
 * gate rather than match a hand-picked constant, and pure white gives the most
 * headroom on a mid-tone brand. The hand-picked pair stays where it belongs — on
 * the default green in globals.css.
 */
const FOREGROUND_LIGHT = "#ffffff";
const FOREGROUND_DARK = "#0b0f0c";

const SHORTHAND = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const FULL = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/**
 * Accept `#rgb` and `#rrggbb`, any case, with surrounding whitespace.
 *
 * Deliberately NOT accepted: named colours, `rgb()`/`hsl()` functions, alpha
 * channels, and anything else CSS understands. A tenant field is a colour
 * swatch, and every extra syntax is another grammar to parse correctly before a
 * value reaches a `<style>` element.
 */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  const short = SHORTHAND.exec(trimmed);
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  }
  const full = FULL.exec(trimmed);
  if (full) return `#${full[1]}${full[2]}${full[3]}`.toLowerCase();
  return null;
}

/** `#rrggbb` → `[r, g, b]` in 0-255. Assumes `normalizeHex` already accepted it. */
function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function toHex(r: number, g: number, b: number): string {
  const part = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * WCAG relative luminance.
 *
 * The piecewise transfer function is not a stylistic choice: it is the sRGB
 * electro-optical curve, and skipping the linear segment is the single most
 * common way a contrast checker gets a dark colour wrong.
 */
export function relativeLuminance(hex: string): number {
  // Keep the tuple tuple-typed all the way to the reads. `channels(hex).map(…)`
  // reads better, but `.map` on a tuple returns `number[]`, and under
  // `noUncheckedIndexedAccess` every element of an ARRAY read — destructuring
  // included — is `number | undefined`. A tuple read at a literal index is
  // exempt from that widening; a mapped array is not, and the three elements
  // `channels()` just constructed were being treated as possibly missing.
  //
  // `channels()` builds that three-element tuple itself, so these reads are in
  // bounds by construction — the code says so, rather than asserting it away.
  const tuple = channels(hex);
  const linear = (c: number) => {
    const srgb = c / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(tuple[0]) + 0.7152 * linear(tuple[1]) + 0.0722 * linear(tuple[2]);
}

/** WCAG contrast ratio, 1–21. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The more legible of near-white and near-black, and how legible it is.
 *
 * The two candidates are not pure `#ffffff`/`#000000` because pure black on a
 * dark brand is harsh and pure white on a light brand is worse; these are the
 * values already in the palette (`#f4faf7`, `#07130d`).
 */
export function readableForeground(background: string): { hex: string; ratio: number } {
  const onLight = contrastRatio(background, FOREGROUND_LIGHT);
  const onDark = contrastRatio(background, FOREGROUND_DARK);
  return onLight >= onDark
    ? { hex: FOREGROUND_LIGHT, ratio: onLight }
    : { hex: FOREGROUND_DARK, ratio: onDark };
}

/** Blend toward white in fixed 5% steps. Deterministic, so a test can assert it. */
function lightenTowardWhite(hex: string, steps: number): string {
  const [r, g, b] = channels(hex);
  return toHex(
    r + (255 - r) * (steps / 20),
    g + (255 - g) * (steps / 20),
    b + (255 - b) * (steps / 20),
  );
}

/** Blend toward black in fixed 5% steps. The mirror of `lightenTowardWhite`. */
function darkenTowardBlack(hex: string, steps: number): string {
  const [r, g, b] = channels(hex);
  return toHex(r * (1 - steps / 20), g * (1 - steps / 20), b * (1 - steps / 20));
}

/**
 * Move `primary` toward black until it clears the non-text threshold against the
 * light card.
 *
 * The mirror of `forDarkSurface`, and needed for the same reason. A bank's white
 * or pale-yellow primary produces a button whose EDGE disappears into a white
 * card even when its label is perfectly readable — the text check passes, the
 * control is invisible, and the failure is invisible to any contrast ratio the
 * operator is shown. This is the check that catches it.
 */
export function forLightSurface(primary: string): string {
  let candidate = primary;
  for (let steps = 0; steps <= 20; steps++) {
    if (contrastRatio(candidate, LIGHT_SURFACE) >= AA_NON_TEXT_CONTRAST) return candidate;
    candidate = darkenTowardBlack(primary, steps + 1);
  }
  return "#000000";
}

/**
 * Move `primary` toward white until it clears the non-text threshold against
 * the dark surface.
 *
 * Returns the input unchanged when it already passes, and otherwise the FIRST
 * step that passes — not the extreme. Twenty steps of 5% is the CAP that makes
 * termination explicit; in practice a colour reaches the threshold well short of
 * white, and overshooting would wash a bank's brand out to grey.
 */
export function forDarkSurface(primary: string): string {
  let candidate = primary;
  for (let steps = 0; steps <= 20; steps++) {
    if (contrastRatio(candidate, DARK_SURFACE) >= AA_NON_TEXT_CONTRAST) return candidate;
    candidate = lightenTowardWhite(primary, steps + 1);
  }
  return "#ffffff";
}

export type BrandVerdict =
  | {
      ok: true;
      /**
       * The tenant's NORMALISED choice, exactly as submitted. This is what gets
       * stored, and what the settings form shows back as the swatch.
       *
       * The scheme-specific values below are corrections to it, not replacements
       * — storing the correction would mean the console and the form disagreed
       * about what the tenant picked.
       */
      primary: string;
      /** Corrected for the light card; equals `primary` when it already reads. */
      lightPrimary: string;
      /** Text colour for `lightPrimary`, always ≥ 4.5:1 against it. */
      lightForeground: string;
      /** Corrected for `.dark`; equals `primary` when it already reads. */
      darkPrimary: string;
      /** Text colour for `darkPrimary`. */
      darkForeground: string;
      /** The light-scheme text contrast ratio, for the audit record. */
      contrast: number;
    }
  | { ok: false; reason: "invalid" | "unreadable"; detail: string };

/**
 * The gate. Accept a tenant's input, return either everything the UI needs or a
 * reason it was refused.
 *
 * Callers persist `primary` only on `ok: true`. Refusing here rather than
 * clamping at render time is the point: a clamped colour is a colour the tenant
 * did not choose and nobody told them about.
 */
export function evaluateBrandPrimary(input: unknown): BrandVerdict {
  const primary = normalizeHex(input);
  if (primary === null) {
    return {
      ok: false,
      reason: "invalid",
      detail: "Brand colour must be a hex like #0b7a55 (3 or 6 digits).",
    };
  }

  // Each scheme gets its own correction, because a colour cannot be corrected
  // for two opposite backgrounds by one adjustment: a near-white brand needs to
  // go DOWN for the light card and a near-black brand needs to go UP for the dark
  // one. `primary` itself is corrected by neither.
  const lightPrimary = forLightSurface(primary);
  const lightForeground = readableForeground(lightPrimary);
  if (lightForeground.ratio < AA_TEXT_CONTRAST) {
    return {
      ok: false,
      reason: "unreadable",
      detail:
        `Neither white nor near-black text reaches 4.5:1 on ${primary} ` +
        `(best is ${lightForeground.ratio.toFixed(2)}:1). Darken or lighten it.`,
    };
  }

  const darkPrimary = forDarkSurface(primary);
  const darkForeground = readableForeground(darkPrimary);

  return {
    ok: true,
    primary,
    lightPrimary,
    lightForeground: lightForeground.hex,
    darkPrimary,
    darkForeground: darkForeground.hex,
    contrast: Number(lightForeground.ratio.toFixed(2)),
  };
}

/**
 * A verdict that is guaranteed `ok`, falling back to the platform default.
 *
 * For callers that must render something regardless of what is in the field —
 * a colour picker showing "current value", which cannot render nothing. The
 * fallback is not a guess: `DEFAULT_PRIMARY` is a constant hex, and
 * `tests/unit/brand-color.test.ts` asserts it passes the gate, so the second
 * call always succeeds.
 */
export function brandPreview(input: unknown): BrandVerdict & { ok: true } {
  const candidate = typeof input === "string" && input.trim() ? input : DEFAULT_PRIMARY;
  const verdict = evaluateBrandPrimary(candidate);
  if (verdict.ok) return verdict;
  return evaluateBrandPrimary(DEFAULT_PRIMARY) as BrandVerdict & { ok: true };
}

/**
 * The CSS custom properties a verified brand colour overrides.
 *
 * Only the tokens that mean "this is the tenant's colour". `--accent`,
 * `--sidebar-accent` and the `--chart-*` ramp stay on the default palette on
 * purpose: they are tints and supporting series derived from the brand green,
 * and re-deriving them is a different piece of work with its own contrast
 * problems. What is overridden is what carries the brand: the primary fill, the
 * ring, and the sidebar's primary.
 */
export function brandCssVariables(verdict: BrandVerdict & { ok: true }): Record<string, string> {
  return {
    "--primary": verdict.lightPrimary,
    "--primary-foreground": verdict.lightForeground,
    "--ring": verdict.lightPrimary,
    "--sidebar-primary": verdict.lightPrimary,
    "--sidebar-primary-foreground": verdict.lightForeground,
  };
}

/** The same, wrapped so it can sit inside a `.dark` selector. */
export function brandCssVariablesDark(
  verdict: BrandVerdict & { ok: true },
): Record<string, string> {
  return {
    "--primary": verdict.darkPrimary,
    "--primary-foreground": verdict.darkForeground,
    "--ring": verdict.darkPrimary,
    "--sidebar-primary": verdict.darkPrimary,
    "--sidebar-primary-foreground": verdict.darkForeground,
  };
}

/**
 * The full stylesheet text, or `null` when there is no brand.
 *
 * Serialised here rather than assembled in the layout so the escaping is in one
 * place next to the validation: the only characters that survive `normalizeHex`
 * are hex digits and a `#`, so this string cannot contain anything that closes
 * the rule — but that is a property of the validator, and it should be checked
 * where the validator lives.
 */
export function brandStyleSheet(verdict: BrandVerdict): string | null {
  if (!verdict.ok) return null;
  const light = Object.entries(brandCssVariables(verdict))
    .map(([k, v]) => `${k}:${v};`)
    .join("");
  const dark = Object.entries(brandCssVariablesDark(verdict))
    .map(([k, v]) => `${k}:${v};`)
    .join("");
  return `:root{${light}}.dark{${dark}}`;
}
