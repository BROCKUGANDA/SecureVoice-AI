/**
 * The speech gate — the last stop before text becomes a customer's audio.
 *
 * Everything upstream (prompt, router, compliance gate) is advisory: an LLM can
 * still produce a card number, a markdown bullet, or "your insurance premium" on
 * a takaful call. This module is the enforcement point, and it is deliberately
 * placed at the send boundary so that every voice path — the Twilio media-stream
 * socket, the buffered TTS endpoint, the streamed one, and TwiML `<Say>` — passes
 * through one implementation rather than four copies of it.
 *
 * Two different failure directions, on purpose:
 *
 *   - PII and voice-safety cleaning is UNCONDITIONAL. A leaked PAN on a
 *     recorded call is a breach whatever the tenant's religion or product, so
 *     there is no flag that can turn this off.
 *   - Shariah terminology substitution is OPT-IN per tenant. Rewriting
 *     "insurance" to "takaful" for a conventional insurer tells the customer
 *     something false about their own policy, which is the same class of harm
 *     the filter exists to prevent. It runs only when the organisation has said
 *     it is an Islamic institution.
 */

import { redactPII } from "./redactor";

/** Spoken answers are short by rule; a rambling agent cannot be interrupted
 *  politely and burns the caller's patience on a fraud call. */
export const MAX_SPEECH_WORDS = 30;

export type SpeechContext = {
  /** The tenant has declared itself an Islamic bank or takaful operator. */
  shariahCompliant?: boolean;
  /** Base language tag, used to pick the Latin or Arabic rule set. */
  lang?: string;
  /**
   * Spoken-length cap for THIS utterance's source. Unset means uncapped.
   *
   * Deliberately opt-in. The 30-word rule is a constraint on what a model may
   * improvise mid-call; it is not a constraint on the compliance-approved
   * opening disclosure, which is longer on purpose because it has to state the
   * recording notice, the temporary hold, and the never-ask-for-a-PIN promise in
   * one breath. Capping that text silently deleted the last two sentences — a
   * guardrail destroying the thing it was installed to protect.
   */
  maxWords?: number;
};

export type SpeechGateResult = {
  text: string;
  /** Marker names actually inserted by redaction, e.g. ["PAN"]. */
  redactions: string[];
  /** Terminology pairs actually applied, e.g. ["interest" -> "profit rate"]. */
  substitutions: string[];
  truncated: boolean;
};

type TermRule = { from: RegExp; to: string };

/**
 * Latin-term rules. Ordered longest-first and matched in a SINGLE pass so a
 * replacement can never be re-scanned by a later rule: applied naively,
 * "interest rate" becomes "profit rate rate".
 */
const LATIN_RULES: [string, string][] = [
  ["interest rate", "profit rate"],
  ["interest payment", "profit payment"],
  ["credit card", "financing card"],
  ["claim payout", "fund disbursement"],
  ["life insurance", "family protection"],
  ["insurance", "takaful"],
  ["insurer", "takaful operator"],
  ["premiums", "contributions"],
  ["premium", "contribution"],
  ["underwriting", "risk assessment"],
  ["borrower", "customer"],
  ["lender", "provider"],
  ["debtor", "customer"],
  ["borrow", "finance"],
  ["loans", "financings"],
  ["loan", "financing"],
  ["usury", "profit rate"],
  ["apr", "profit rate"],
  ["late fee", "late payment compensation"],
  ["penalty", "charity contribution"],
  ["gambling", "speculation"],
  ["interest", "profit rate"],
];

/**
 * Arabic rules. The caller base is not English — Gulf and Egyptian scripts are
 * where a Shariah breach would actually be spoken — so the same concepts are
 * enforced in the language the customer hears.
 *
 * The definite article is prefixed in Arabic orthography, not separate, so
 * `التأمين` contains `تأمين` behind a letter boundary and would never match a
 * bare-key rule. Each form therefore carries its own prefixed rule; ordering is
 * longest-first, so the article form wins over the bare one.
 */
const ARABIC_RULES: [string, string][] = [
  ["الفائدة", "نسبة الربح"],
  ["الفوائد", "الأرباح"],
  ["فائدة", "ربح"],
  ["الربا", "الربح"],
  ["ربا", "ربح"],
  ["القروض", "التمويلات"],
  ["القرض", "التمويل"],
  ["قروض", "تمويلات"],
  ["قرض", "تمويل"],
  ["شركة التأمين", "مشغل التكافل"],
  ["التأمين", "التكافل"],
  ["تأمين", "تكافل"],
  ["العلاوة", "الاشتراك"],
  ["علاوة", "اشتراك"],
  ["أقساط التأمين", "الاشتراكات"],
  ["قسط التأمين", "الاشتراك"],
  ["القسط", "الاشتراك"],
  ["بطاقة الائتمان", "بطاقة التمويل"],
  ["بطاقة ائتمان", "بطاقة تمويل"],
  ["فائدة تأخير", "تعويض التأخر"],
  ["مخالفات", "مساهمات خيرية"],
];

/**
 * Urdu Shariah terms — the P1-3 gap. The filter had a Latin and an Arabic
 * ruleset but no Urdu one, so a takaful customer speaking Urdu heard
 * "insurance" (انشورنس) rather than "takaful" (تکافل): the substitution the
 * tenant declared it needed was simply absent for that script.
 *
 * Written in Urdu orthography (ک/ی/ہ), not the Arabic spellings, because the
 * words a caller actually uses are the Urdu forms and termRules is script-aware
 * (`\p{L}` fence, not `\b`), so the two rulesets do not collide. Longest-first
 * inside termRules consumes compounds ("لائف انشورنس") before the bare noun.
 */
const URDU_RULES: [string, string][] = [
  ["لائف انشورنس", "تکافل"],
  ["انشورنس کمپنی", "تکافل کمپنی"],
  ["انسورر", "تکافل آپریٹر"],
  ["انشورنس", "تکافل"],
  ["سود", "منافع"],
  ["بیمہ", "تکافل"],
  ["کارڈ کریڈٹ", "کارڈ تمویل"],
  ["جرمانے", "چیریٹی"],
  ["جرمانہ", "چیریٹی"],
];

/**
 * A letter/number-fenced boundary rather than `\b`, because `\b` is defined
 * over `[A-Za-z0-9_]` and therefore never matches around Arabic script — a
 * `\bقرض\b` pattern silently matches nothing at all.
 */
function termRules(pairs: [string, string][]): TermRule[] {
  // Longest key first, so a compound is consumed before any of its parts:
  // applied the other way round, "interest" rewrites the head of "interest
  // rate" and the residue is spoken as "profit rate rate".
  const ordered = [...pairs].sort((a, b) => b[0].length - a[0].length);
  return ordered.map(([from, to]) => ({
    from: new RegExp(`(?<![\\p{L}\\p{N}])${escapePattern(from)}(?![\\p{L}\\p{N}])`, "giu"),
    to,
  }));
}

const LATIN = termRules(LATIN_RULES);
const ARABIC = termRules(ARABIC_RULES);
const URDU = termRules(URDU_RULES);

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Keep the caller's casing: an emphasised or sentence-initial term must not
 *  arrive mid-sentence as a lowercase substitution. */
function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase() && source.length > 1) return replacement.toUpperCase();
  if (source[0] === source[0]?.toUpperCase()) {
    return replacement[0]?.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export function applyShariahTerms(text: string): { text: string; applied: string[] } {
  let out = text;
  const applied: string[] = [];
  for (const rules of [LATIN, ARABIC, URDU]) {
    for (const rule of rules) {
      if (!rule.from.test(out)) continue;
      rule.from.lastIndex = 0;
      const before = out;
      out = out.replace(rule.from, (match) => matchCase(match, rule.to));
      if (out !== before) applied.push(`${rule.from.source.slice(0, 24)} -> ${rule.to}`);
    }
  }
  return { text: out, applied };
}

/**
 * Each rule carries its own replacement. A single shared "$1" is wrong here:
 * the patterns without a capture group (bullets, headings, images) would
 * rewrite to the literal text "$1", which is worse than the markdown.
 */
const MARKDOWN: [RegExp, string][] = [
  [/```[\s\S]*?```/g, " "], // fenced code
  [/`([^`]*)`/g, "$1"], // inline code
  [/\*\*([^*]*)\*\*/g, "$1"],
  [/\*([^*]*)\*/g, "$1"],
  [/__([^_]*)__/g, "$1"],
  [/_([^_]*)_/g, "$1"],
  [/^#{1,6}\s*/gm, ""], // headings, with or without a trailing space
  [/^\s*[-*+](?:\s+|$)/gm, ""], // bullets; a bare leading "-" before a digit is a
  // negative number and must survive, which is why the marker needs a space or
  // an end-of-line after it.
  [/^\s*>\s?/gm, ""], // blockquote
  [/![[^\]]*\]\([^)]*\)/g, " "], // images, dropped entirely
  [/\[([^\]]*)\]\([^)]*\)/g, "$1"], // links, keep the label
];

const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]+/gu;

/**
 * Make text safe to synthesise. ElevenLabs reads markdown literally — an agent
 * that answers in bullets gets asterisks spoken as "star" — and emoji become
 * either silence or gibberish.
 */
export function toSpokenForm(text: string): string {
  let out = text;
  for (const [pattern, replacement] of MARKDOWN) out = out.replace(pattern, replacement);
  out = out.replace(EMOJI, " ");
  // One space between every surviving word: a synthesiser reads a newline as a
  // paragraph break, and a bullet list is not a paragraph.
  return out
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?؛،])/g, "$1")
    .trim();
}

/**
 * Trim to the spoken-length rule without cutting mid-word: prefer the last
 * clause boundary, and only hard-truncate when there is no sentence to end on.
 */
export function withinWordLimit(
  text: string,
  maxWords = MAX_SPEECH_WORDS,
): { text: string; truncated: boolean } {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return { text, truncated: false };

  const clause = /[,;:.!?؛،]\s+\S/;
  const head = words.slice(0, maxWords).join(" ");
  const boundaries = [...head.matchAll(new RegExp(clause.source, "g"))];
  const last = boundaries.at(-1);
  if (last && last.index !== undefined && last.index > head.length * 0.4) {
    return { text: head.slice(0, last.index + 1).trim(), truncated: true };
  }
  return { text: `${head}.`, truncated: true };
}

/**
 * The gate. Call it immediately before handing text to any TTS transport.
 */
export function prepareSpeech(input: string, ctx: SpeechContext = {}): SpeechGateResult {
  const source = (input ?? "").trim();
  if (!source) return { text: "", redactions: [], substitutions: [], truncated: false };

  const spoken = toSpokenForm(source);

  // Nothing a synthesiser could render: no letter and no digit survives. This is
  // checked here rather than at each call site so that "***", "###" and a
  // lone emoji are all treated the same way — as no utterance at all, which the
  // transports must not turn into a billable request or a moment of dead air.
  if (!/[\p{L}\p{N}]/u.test(spoken)) {
    return { text: "", redactions: [], substitutions: [], truncated: false };
  }

  const seen: string[] = [];
  const redacted = redactPII(spoken).replace(/\[REDACTED_([A-Z]+)\]/g, (whole, kind) => {
    seen.push(String(kind));
    return whole;
  });

  const shariah = ctx.shariahCompliant
    ? applyShariahTerms(redacted)
    : { text: redacted, applied: [] };
  const capped =
    ctx.maxWords === undefined
      ? { text: shariah.text, truncated: false }
      : withinWordLimit(shariah.text, ctx.maxWords);

  return {
    text: capped.text,
    redactions: seen,
    substitutions: shariah.applied,
    truncated: capped.truncated,
  };
}

/** Convenience wrapper for transports that only want the string. */
export function speechForTts(input: string, ctx?: SpeechContext): string {
  return prepareSpeech(input, ctx).text;
}
