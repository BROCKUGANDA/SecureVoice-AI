/**
 * Normalisation for hostile display strings — merchant names, cardholder
 * names, agent names, anything a bank (or an attacker who has compromised a
 * bank's fraud engine) can put into a free-text field that will be rendered in
 * a console, spoken by an agent, and exported to Excel.
 *
 * The threat model is not "the user is rude", it is "the string is engineered".
 * Three classes of attack matter here:
 *
 *   1. Bidi / Trojan Source (U+202A–U+202E, U+2066–U+2069). A name that renders
 *      as "gmhc.exe" can be stored as "exe.mhg" with the visual order reversed.
 *      Every human reading the console sees a different string than the one we
 *      validated. This is how a fraud console gets fooled about who paid whom.
 *   2. Zero-width and invisible padding (U+200B–U+200D, U+FEFF, and the
 *      direction marks U+200E/U+200F/U+061C). "Starb‌bucks" compares
 *      unequal to "Starbucks" in every downstream dedupe, blacklist and
 *      fuzzy-match check, while looking identical to a human.
 *   3. Homoglyphs. Two different things that render identically. NFKC folds
 *      *compatibility* homoglyphs (fullwidth `Ｃａｆｅ`, circled ①, ﬁ ligature)
 *      for free — but it deliberately does NOT fold cross-script confusables
 *      (Cyrillic С vs Latin C), because that would corrupt legitimate Russian,
 *      Greek and Arabic names. Those get a separate fold that only fires when
 *      the string is genuinely mixed-script, and always reports what it did so
 *      the caller can flag the row for review.
 *
 * Output contract: `normalizeHostileText(...).value` is safe to store and to
 * display. It contains no bidi controls, no zero-width characters, no C0/C1
 * controls, no leading/trailing whitespace, no repeated whitespace, and is
 * capped by GRAPHEME count (not UTF-16 code-unit count, so an emoji or an
 * Arabic ligature is never cut in half).
 *
 * Known trade-off, stated rather than hidden: U+200C (ZWNJ) and U+200D (ZWJ)
 * are stripped as required, but they are *meaningful* in Persian/Urdu (ZWNJ)
 * and in Indic scripts (ZWJ). A name like "می‌رود" will normalise to
 * "میرود". That is the intended security posture — we would rather render a
 * name slightly wrong than accept a string that lies about its own identity —
 * but callers that must preserve those sequences should pass
 * `{ stripZeroWidth: false }` and take on the dedupe-bypass risk knowingly.
 */

/** Invisible characters that reverse or reorder the rendered text. */
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/g;
/** Direction marks — invisible, and they participate in bidi reordering. */
const BIDI_MARK_RE = /[\u200E\u200F\u061C]/g;
/** Zero-width space/non-joiner/joiner and the BOM. */
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
/** C0 controls, DEL and C1 controls. Newlines included — this is also a log-injection control. */
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
/** Whitespace including Unicode spaces (NBSP, ideographic space, …). */
const WHITESPACE_RE = /\s+/g;

/** Default cap on a hostile display string, in grapheme clusters. */
export const DEFAULT_MAX_GRAPHEMES = 64;

export type RemovalClass =
  | "bidi"
  | "zero-width"
  | "control"
  | "whitespace"
  | "truncated"
  | "confusable";

export interface NormalisedText {
  /** Safe to store and to display. Never contains invisible reordering characters. */
  value: string;
  /** True when normalisation changed the input in any way. */
  changed: boolean;
  /** Which classes of character were removed or rewritten. */
  removals: readonly RemovalClass[];
  /** True when a cross-script homoglyph mix was detected (see foldHomoglyphs). */
  mixedScript: boolean;
  /** Grapheme count of `value` after normalisation. */
  graphemes: number;
}

export interface NormaliseOptions {
  /** Cap in grapheme clusters. Defaults to DEFAULT_MAX_GRAPHEMES. */
  maxGraphemes?: number;
  /** Strip U+200C/U+200D. Default true. See the trade-off note at the top. */
  stripZeroWidth?: boolean;
  /** Fold cross-script confusables when a mixed-script mix is detected. Default true. */
  foldHomoglyphs?: boolean;
  /**
   * Maximum input length considered before normalisation, in UTF-16 code units.
   * Bounds the work an attacker can force us to do. Default 4096.
   */
  maxInputLength?: number;
}

/**
 * `RegExp.prototype.test` on a /g regex advances `lastIndex`, so a shared
 * global regex leaks state between calls. Every probe goes through here.
 */
function matches(re: RegExp, input: string): boolean {
  re.lastIndex = 0;
  return re.test(input);
}

// ── Grapheme counting ───────────────────────────────────────────────────────
//
// A cap in UTF-16 code units splits surrogate pairs and can leave a lone
// surrogate in the database — which renders as a replacement glyph and blows
// up downstream string handling. Grapheme clusters are the unit a human means
// by "character", so that is the unit we cap on.

const HAS_SEGMENTER = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";

let segmenter: Intl.Segmenter | null = null;

function getSegmenter(): Intl.Segmenter | null {
  if (!HAS_SEGMENTER) return null;
  if (!segmenter) segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return segmenter;
}

/**
 * Count grapheme clusters. Uses Intl.Segmenter where available (correct for
 * emoji ZWJ sequences, regional-indicator flags, Hangul jamo and combining
 * marks); falls back to Unicode code-point counting, which over-counts
 * (a base letter plus its combining marks counts as 2) and therefore errs on
 * the side of a SHORTER string, which is the safe direction for a cap.
 */
export function countGraphemes(input: string): number {
  const seg = getSegmenter();
  if (seg) {
    let n = 0;
    for (const _ of seg.segment(input)) n += 1;
    return n;
  }
  return Array.from(input).length;
}

/** Truncate to at most `max` grapheme clusters without splitting a cluster. */
export function truncateGraphemes(input: string, max: number): { value: string; truncated: boolean } {
  if (countGraphemes(input) <= max) return { value: input, truncated: false };
  const seg = getSegmenter();
  if (seg) {
    let out = "";
    let n = 0;
    for (const piece of seg.segment(input)) {
      if (n >= max) break;
      out += piece.segment;
      n += 1;
    }
    return { value: out, truncated: true };
  }
  return { value: Array.from(input).slice(0, max).join(""), truncated: true };
}

// ── Script detection ────────────────────────────────────────────────────────
//
// Needed because NFKC cannot (and must not) fold Cyrillic а into Latin a. The
// only safe signal is CONTEXT: a string that mixes scripts where one of them is
// a small minority is a far more likely homoglyph attack than a real name.
// "МОСКВА Банк" is one script — untouched. "МАРКЕТ Store" is two — flagged.

const SCRIPT_RANGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u0400-\u052F]/, "cyrillic"],
  [/[\u0370-\u03FF\u1F00-\u1FFF]/, "greek"],
  [/[\u0530-\u058F]/, "armenian"],
  [/[\u0590-\u05FF]/, "hebrew"],
  [/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/, "arabic"],
  [/[\u0900-\u097F]/, "devanagari"],
  [/[\u0E00-\u0E7F]/, "thai"],
  [/[\u3040-\u309F]/, "hiragana"],
  [/[\u30A0-\u30FF]/, "katakana"],
  [/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/, "hangul"],
  [/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/, "han"],
  [/[A-Za-z]/, "latin"],
];

/** Hiragana and Katakana count as "han" so a Japanese name is not a "mix". */
function canonicalScript(name: string): string {
  return name === "hiragana" || name === "katakana" ? "han" : name;
}

function scriptOf(char: string): string | null {
  for (const [re, name] of SCRIPT_RANGES) if (matches(re, char)) return name;
  return null;
}

/** Script → letter count, for every script present in the string. */
function scriptHistogram(input: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ch of input) {
    const name = scriptOf(ch);
    if (!name) continue;
    const key = canonicalScript(name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The script with the most letters, or null for a scriptless string. */
export function dominantScript(input: string): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [script, count] of scriptHistogram(input)) {
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return best;
}

/**
 * True when the string mixes two or more scripts. This is the trigger for
 * homoglyph folding — and also a useful signal on its own: a cardholder name
 * that mixes Latin and Cyrillic deserves a human look.
 */
export function hasMixedScript(input: string): boolean {
  return scriptHistogram(input).size > 1;
}

/**
 * Single-glyph cross-script confusables — the letters actually used to forge a
 * look-alike merchant name. Every key is a *distinct* Unicode character that
 * renders like the Latin letter it maps to.
 *
 * Deliberately a curated high-signal allow-list rather than a full confusables
 * table: an over-broad map mangles real names, and a mangled real name is a
 * customer-support incident. Applied only in a mixed-script context, so a
 * legitimately Cyrillic or Greek name is left alone.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic → Latin
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c",
  "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j", "\u0455": "s",
  "\u0501": "d", "\u04BB": "h", "\u04CF": "l", "\u051B": "q",
  "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041A": "K", "\u041C": "M",
  "\u041D": "H", "\u041E": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T",
  "\u0423": "Y", "\u0425": "X", "\u04B0": "Y", "\u04AE": "Y",
  // Greek → Latin
  "\u03BF": "o", "\u03BD": "v", "\u03B1": "a", "\u03C1": "p", "\u03C4": "t",
  "\u03C5": "u", "\u03BA": "k", "\u03B9": "i", "\u03B2": "b", "\u03B5": "e",
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H",
  "\u0399": "I", "\u039A": "K", "\u039C": "M", "\u039D": "N", "\u039F": "O",
  "\u03A1": "P", "\u03A4": "T", "\u03A5": "Y", "\u03A7": "X",
  // Armenian → Latin
  "\u0585": "o", "\u0561": "w", "\u0581": "g", "\u0584": "p", "\u0578": "n",
  "\u0570": "h", "\u057D": "s", "\u057C": "u", "\u0566": "q", "\u057F": "n",
  // Cherokee → Latin (the classic "this looks like a normal word" glyphs)
  "\u13AA": "A", "\u13AC": "E", "\u13B2": "H", "\u13B3": "I", "\u13B5": "L",
  "\u13B9": "M", "\u13BD": "O", "\u13C0": "P", "\u13C3": "S", "\u13CE": "Y",
};

/**
 * Fold known cross-script confusables to their Latin look-alikes. Only call
 * this on a string `hasMixedScript` reports as mixed — on a single-script
 * string this would corrupt real non-Latin names. Characters with no confusable
 * mapping are left in place; the caller decides what to do with them based on
 * `hasMixedScript`, rather than this function silently dropping data.
 */
export function foldHomoglyphs(input: string): { value: string; folded: boolean } {
  if (!hasMixedScript(input)) return { value: input, folded: false };
  let out = "";
  let folded = false;
  for (const ch of input) {
    const latin = CONFUSABLES[ch];
    if (latin === undefined) {
      out += ch;
      continue;
    }
    folded = true;
    // Preserve the source character's case: Cyrillic М (upper) → M.
    out += ch === ch.toLowerCase() ? latin : latin.toUpperCase();
  }
  return { value: out, folded };
}

/**
 * Normalise a hostile display string.
 *
 * Order matters and is deliberate:
 *   1. Bound the input length first, so an attacker cannot force unbounded work.
 *   2. NFKC — folds fullwidth, circled, superscript and ligature homoglyphs.
 *   3. Strip, then normalise again (bounded to two passes) so the result is
 *      stable under re-normalisation.
 *   4. Cross-script confusable fold, only in a mixed-script context.
 *   5. Whitespace collapse + trim.
 *   6. Grapheme cap.
 */
export function normalizeHostileText(raw: unknown, opts: NormaliseOptions = {}): NormalisedText {
  const maxGraphemes = opts.maxGraphemes ?? DEFAULT_MAX_GRAPHEMES;
  const maxInputLength = opts.maxInputLength ?? 4096;
  const stripZeroWidth = opts.stripZeroWidth !== false;
  const fold = opts.foldHomoglyphs !== false;

  const removals = new Set<RemovalClass>();
  let input = typeof raw === "string" ? raw : raw === null || raw === undefined ? "" : String(raw);

  const boundedByLength = input.length > maxInputLength;
  if (boundedByLength) {
    input = input.slice(0, maxInputLength);
    removals.add("truncated");
  }

  const original = input;
  const mixedScript = hasMixedScript(input);

  // Steps 2 + 3: normalise and strip until stable (bounded to two passes).
  for (let pass = 0; pass < 2; pass += 1) {
    const before = input;
    input = stripClasses(input.normalize("NFKC"), stripZeroWidth, removals);
    if (input === before) break;
  }

  // Step 4: cross-script homoglyphs. NFKC cannot do this and must not.
  if (fold && mixedScript) {
    const folded = foldHomoglyphs(input);
    if (folded.folded) {
      input = folded.value;
      removals.add("confusable");
    }
  }

  // Step 5: whitespace.
  const collapsed = input.replace(WHITESPACE_RE, " ").trim();
  if (collapsed !== input) removals.add("whitespace");
  input = collapsed;

  // Step 6: grapheme cap — never split a cluster.
  const capped = truncateGraphemes(input, maxGraphemes);
  if (capped.truncated) removals.add("truncated");
  input = capped.value;

  return {
    value: input,
    changed: input !== original,
    removals: [...removals],
    mixedScript,
    graphemes: countGraphemes(input),
  };
}

/** Convenience wrapper when only the safe string is wanted. */
export function safeText(raw: unknown, opts: NormaliseOptions = {}): string {
  return normalizeHostileText(raw, opts).value;
}

/**
 * True when the string contains nothing that can lie about its own rendered
 * identity. Used as a post-condition assertion on any path that writes a
 * display string to the database.
 */
export function isSafeDisplayText(value: string): boolean {
  if (value !== value.normalize("NFKC")) return false;
  if (matches(BIDI_CONTROL_RE, value)) return false;
  if (matches(BIDI_MARK_RE, value)) return false;
  if (matches(ZERO_WIDTH_RE, value)) return false;
  if (matches(CONTROL_RE, value)) return false;
  if (value !== value.trim()) return false;
  return true;
}

function stripClasses(input: string, stripZeroWidth: boolean, removals: Set<RemovalClass>): string {
  let out = input;
  if (matches(BIDI_CONTROL_RE, out) || matches(BIDI_MARK_RE, out)) {
    removals.add("bidi");
    out = out.replace(BIDI_CONTROL_RE, "").replace(BIDI_MARK_RE, "");
  }
  if (stripZeroWidth && matches(ZERO_WIDTH_RE, out)) {
    removals.add("zero-width");
    out = out.replace(ZERO_WIDTH_RE, "");
  }
  if (matches(CONTROL_RE, out)) {
    removals.add("control");
    out = out.replace(CONTROL_RE, "");
  }
  return out;
}
