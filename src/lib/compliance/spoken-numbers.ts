/**
 * Numbers rendered as speech — rule 5, enforced in code rather than requested
 * of a model.
 *
 * The rule, verbatim from the brief: *"Render numbers as speech:
 * 'forty-eight thousand dirhams', never '48,000 AED'."*
 *
 * ## Why this is a deterministic pass and not a prompt instruction
 *
 * The drafter's system prompt already asks the model to write small numbers as
 * words. A prompt is a request; this is a check on the bytes that will be
 * synthesised. It runs inside `prepareSpeech`, so EVERY voice path — the
 * media-stream worker, the buffered and streamed TTS endpoints, TwiML — gets
 * it, and a model (or a tenant, or a hard-coded script) cannot opt out.
 *
 * ## What it deliberately does NOT touch
 *
 * A number is only rewritten when it is unambiguously a QUANTITY a human wrote
 * to be read aloud. Identifier-shaped digit groups are left exactly as they
 * are, for two independent reasons:
 *
 *   1. **Redaction must still recognise them.** `redactPII` matches card
 *      numbers, phones and SSNs by their digit shapes, and it runs AFTER this
 *      pass. Rewriting "4111 1111 1111 1111" into words would make a PAN
 *      unredactable — the one outcome worse than a mispronounced amount.
 *   2. **Digits are the right audio.** A synthesiser reads "050 123 4567" as a
 *      phone number perfectly well; "oh five oh, one two three..." is worse.
 *
 * So: comma-grouped numbers of a plausible amount size, and short bare digit
 * runs that are not part of a larger digit structure, are converted. Everything
 * else — 13-digit card runs, phone numbers with separators, reference numbers,
 * anything adjacent to other digits — passes through untouched.
 */

/** Words a synthesiser reads cleanly. Kept small on purpose. */
const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
] as const;

const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
] as const;

const SCALES = ["", "thousand", "million", "billion", "trillion"] as const;

/**
 * Currencies, in every form a transcript or a tenant's copy might carry them.
 *
 * The word is what gets spoken: "AED" is an acronym, and a synthesiser that
 * reads it letter-by-letter ("A-E-D") is the exact failure rule 5 bans. An
 * UNRECOGNISED three-letter code is dropped rather than spelled out: a
 * missing currency word loses a little precision, "G-B-P" is simply wrong
 * audio. The Arabic forms cover the deployment's own script.
 */
const CURRENCY_WORDS: readonly [RegExp, string][] = [
  [/\b(?:aed|dhs|dh|dirhams?)\b|د\.?إ|درهم|دراهم/i, "dirhams"],
  [/\b(?:usd|dollars?)\b|\$/i, "dollars"],
  [/\b(?:euros?)\b|€/i, "euros"],
  [/\b(?:sar|sr|riyals?)\b|ريال|ريالات/i, "riyals"],
  [/\b(?:inr|rs\.?|rupees?)\b/i, "rupees"],
  [/\b(?:kes|ksh|shillings?)\b/i, "shillings"],
];

/**
 * Minor units, for the fractional part of a currency amount. "48,000.50 AED"
 * spoken as "forty-eight thousand point five dirhams" is wrong in a way a
 * customer notices instantly; the fils are the part they actually hold.
 */
const MINOR_UNITS: Record<string, string> = {
  dirhams: "fils",
  dollars: "cents",
  euros: "cents",
  riyals: "halalas",
  rupees: "paise",
  shillings: "cents",
};

const ORDINAL_SUFFIX = /^(st|nd|rd|th)$/i;

/** 0..999. "and" joins hundreds to a remainder: "one hundred and five". */
function smallToWords(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds]} hundred`);
  if (rest > 0) {
    if (rest < 20) parts.push(ONES[rest]);
    else {
      const tens = Math.floor(rest / 10);
      const unit = rest % 10;
      parts.push(unit > 0 ? `${TENS[tens]}-${ONES[unit]}` : TENS[tens]);
    }
  }
  if (parts.length === 0) return ONES[0];
  return hundreds > 0 && rest > 0 ? `${parts[0]} and ${parts[1]}` : parts.join(" ");
}

/** Integer to words, up to the trillions. */
export function integerToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return smallToWords(n);
  const groups: number[] = [];
  let v = Math.floor(n);
  while (v > 0) {
    groups.push(v % 1000);
    v = Math.floor(v / 1000);
  }
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) continue;
    const scale = SCALES[i];
    parts.push(scale ? `${smallToWords(g)} ${scale}` : smallToWords(g));
  }
  return parts.join(" ");
}

/**
 * The ordinal form of a number phrase: "the 3rd charge" → "the third charge".
 *
 * Only the LAST word inflects ("one hundred and fifth"), and a hyphenated
 * compound inflects only its last segment ("twenty-first") — which is how
 * English ordinals actually work.
 */
function ordinalize(words: string): string {
  if (words.includes("-")) {
    const idx = words.lastIndexOf("-");
    return words.slice(0, idx + 1) + ordinalize(words.slice(idx + 1));
  }
  const map: Record<string, string> = {
    one: "first",
    two: "second",
    three: "third",
    five: "fifth",
    eight: "eighth",
    nine: "ninth",
    twelve: "twelfth",
  };
  if (map[words]) return map[words];
  if (words.endsWith("y")) return `${words.slice(0, -1)}ieth`;
  return `${words}th`;
}

/** "2024" → "twenty twenty-four". Years take the natural pair reading. */
function yearToWords(y: number): string {
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  const hiWords = smallToWords(hi);
  const loWords = lo === 0 ? "hundred" : lo < 10 ? `oh ${ONES[lo]}` : smallToWords(lo);
  return `${hiWords} ${loWords}`;
}

/** Digits of the fractional part read as a whole: ".50" → "fifty". */
function fractionToWords(digits: string): string {
  return integerToWords(Number.parseInt(digits, 10));
}

/**
 * Max digits in a comma-grouped number we are willing to convert.
 *
 * Twelve digits is a trillion — beyond any real amount on a fraud call — and
 * staying under thirteen keeps this pass away from card numbers, which are
 * 13–16 digits. A comma-grouped 13+ digit run is left for the redactor.
 */
const MAX_GROUPED_DIGITS = 12;

/** How far either side of a number to look for "this is part of an identifier". */
const CONTEXT_WINDOW = 13;

/** A candidate number: comma-grouped, or bare with an optional fraction. */
const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** Digits and separators interleaved: the shape of a phone, PAN or SSN. */
const IDENTIFIER_SHAPE = /\d[\s\-.()]*\d/;

/**
 * Should this bare (un-grouped) digit run be left alone because it is part of
 * a larger identifier?
 *
 * Two signals, either of which is enough:
 *   · another digit group sits within a separator's reach (a phone written
 *     "050 123 4567", an SSN "123-45-6789"), or
 *   · the run itself is long enough to be a reference (>= 7 digits).
 *
 * The window is scanned rather than just the immediate neighbours because a
 * separator may be missing on one side only — "call 050-1234567" still has to
 * survive, and it does: the second run is adjacent through the dash.
 */
function isIdentifierContext(text: string, start: number, end: number): boolean {
  if (end - start >= 7) return true;
  const window =
    text.slice(Math.max(0, start - CONTEXT_WINDOW), start) +
    text.slice(end, Math.min(text.length, end + CONTEXT_WINDOW));
  return IDENTIFIER_SHAPE.test(window);
}

type CurrencyHit = { word: string; start: number; end: number };

/** A currency token immediately BEFORE a number. Symbols may abut the number
 *  ("$500"); word forms need whitespace ("AED 48,000"). */
function currencyBefore(text: string, numberStart: number): CurrencyHit | null {
  // Symbol currencies sit directly against the number: "$500", "€40".
  const abutting = text[numberStart - 1];
  if (abutting === "$" || abutting === "€" || abutting === "£") {
    for (const [pattern, word] of CURRENCY_WORDS) {
      if (pattern.test(abutting)) return { word, start: numberStart - 1, end: numberStart };
    }
  }
  const before = text.slice(0, numberStart);
  if (!/\s$/.test(before)) return null;
  // Walk back over the whitespace gap, then over the token itself.
  let gapStart = numberStart;
  while (gapStart > 0 && /\s/.test(text[gapStart - 1]!)) gapStart--;
  let tokenStart = gapStart;
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1]!)) tokenStart--;
  if (tokenStart === gapStart) return null; // only whitespace, no token
  const token = text.slice(tokenStart, gapStart);
  for (const [pattern, word] of CURRENCY_WORDS) {
    if (pattern.test(token)) return { word, start: tokenStart, end: gapStart };
  }
  return null;
}

/** A currency token or unknown code immediately AFTER a number. */
function currencyAfter(text: string, numberEnd: number): CurrencyHit | null {
  const rest = text.slice(numberEnd);
  if (!/^\s/.test(rest)) return null;
  const m = /^\s+([^\s]+)/.exec(rest);
  if (!m) return null;
  // Sentence punctuation after the token ("48,000 AED.") belongs to the
  // sentence; only the token itself is consumed.
  const stripped = m[1].replace(/[.,!?;:)\]]+$/, "");
  const tokenEnd = numberEnd + m[0].length - (m[1].length - stripped.length);
  for (const [pattern, word] of CURRENCY_WORDS) {
    if (pattern.test(stripped)) {
      return { word, start: numberEnd, end: tokenEnd };
    }
  }
  // Unknown ISO-style code: drop it rather than spell its letters aloud.
  // Only the three letters are consumed — the punctuation that may follow
  // ("48,000 GBP.") belongs to the sentence, not the currency.
  if (/^[A-Z]{3}$/.test(stripped)) {
    return { word: "", start: numberEnd, end: tokenEnd };
  }
  return null;
}

/**
 * Render quantities as speech. Pure, total, never throws: on any internal
 * fault the input is returned unchanged, because a number left as digits is a
 * cosmetic failure and a mangled sentence is not.
 */
export function renderNumbersAsSpeech(text: string): string {
  if (!text || !/\d/.test(text)) return text;
  try {
    return renderGuarded(text);
  } catch {
    return text;
  }
}

function renderGuarded(input: string): string {
  let out = "";
  let copiedTo = 0;
  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RE.exec(input)) !== null) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;

    const grouped = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/.exec(raw);
    const bare = /^(\d+)(?:\.(\d+))?$/.exec(raw);
    if (!grouped && !bare) continue; // unreachable given the regex; keeps types honest

    const digitsOnly = (grouped ? grouped[1] : bare![1]).replace(/,/g, "");
    const fraction = grouped?.[2] ?? bare?.[2] ?? "";

    // Bare runs that are part of an identifier are nobody's quantity.
    if (!grouped && isIdentifierContext(input, start, end)) continue;
    // A comma-grouped 13+ digit run is a card number wearing commas.
    if (grouped && digitsOnly.length > MAX_GROUPED_DIGITS) continue;

    const value = Number(digitsOnly);
    if (!Number.isSafeInteger(value)) continue;

    // An ordinal suffix rides along with its number: "the 3rd charge".
    const afterNumber = input.slice(end);
    const ordinal = ORDINAL_SUFFIX.exec(afterNumber.slice(0, 2).toLowerCase());

    // A percent sign right after the number is part of the quantity.
    const percent = /^\s*%/.test(afterNumber);

    const before = currencyBefore(input, start);
    const after = currencyAfter(input, end);

    let words: string;
    let unitInWords = false;
    if (fraction && (before || after)?.word && MINOR_UNITS[(before ?? after)!.word]) {
      const unit = (before ?? after)!.word;
      words = `${integerToWords(value)} ${unit} and ${fractionToWords(fraction)} ${MINOR_UNITS[unit]}`;
      unitInWords = true;
    } else if (fraction) {
      words = `${integerToWords(value)} point ${fractionToWords(fraction)}`;
    } else if (
      !grouped &&
      value >= 1900 &&
      value <= 2099 &&
      digitsOnly.length === 4 &&
      !before &&
      !after
    ) {
      // Years: "in March 2024" reads naturally as pairs. Only for un-grouped
      // four-digit values with no currency attached — "2000 dirhams" is an
      // amount, not a year.
      words = yearToWords(value);
    } else {
      words = integerToWords(value);
    }

    if (ordinal) words = ordinalize(words);
    else if (percent) words = `${words} percent`;

    // English speech puts the currency word AFTER the number whichever side
    // it was written on: "$500" and "500 dollars" are both "five hundred
    // dollars" aloud. The minor-unit branch already names the unit.
    const currencyWord = (before ?? after)?.word ?? "";
    const spoken = currencyWord && !unitInWords ? `${words} ${currencyWord}` : words;

    const spanStart = before ? before.start : start;
    let spanEnd = end;
    if (ordinal) spanEnd = end + 2;
    else if (percent) {
      const pct = /^\s*%/.exec(afterNumber);
      if (pct) spanEnd = end + pct[0].length;
    } else if (after) spanEnd = after.end;

    out += input.slice(copiedTo, spanStart) + spoken;
    copiedTo = spanEnd;
  }
  out += input.slice(copiedTo);
  return out;
}
