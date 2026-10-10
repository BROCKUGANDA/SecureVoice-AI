/**
 * The speech gate — the last stop before text becomes a customer's audio.
 *
 * Everything upstream (prompt, router, compliance gate) is advisory: an LLM can
 * still produce a card number, a markdown bullet, "your insurance premium" on a
 * takaful call, or — the one this platform is uniquely exposed to — a vishing
 * opener. This module is the enforcement point, and it is deliberately placed at
 * the send boundary so that every voice path — the Twilio media-stream socket,
 * the buffered TTS endpoint, the streamed one, and TwiML `<Say>` — passes through
 * one implementation rather than four copies of it.
 *
 * Three different failure directions, on purpose:
 *
 *   - **PII redaction and the vishing blocklist are UNCONDITIONAL.** A leaked PAN
 *     on a recorded call is a breach whatever the tenant's religion or product,
 *     and an agent that can say "your account will be closed" is the attack rather
 *     than the defence. Neither has a flag that can turn it off.
 *   - Shariah terminology substitution is OPT-IN per tenant. Rewriting
 *     "insurance" to "takaful" for a conventional insurer tells the customer
 *     something false about their own policy, which is the same class of harm
 *     the filter exists to prevent. It runs only when the organisation has said
 *     it is an Islamic institution.
 */

import { redactPII } from "./redactor";
import { verdictFor, describeHits, type VishingVerdict } from "./vishing";
import { hasSafetyExit } from "./safety-exit";
import { speaksToken } from "@/lib/verification-token";
import { renderNumbersAsSpeech } from "./spoken-numbers";

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
  /**
   * Vishing rule ids this tenant has switched off.
   *
   * Only rules marked `overridable` can be disabled this way, and only the one
   * legal-deadline notice is. A tenant cannot switch off "do not tell anyone"
   * however it asks — see `verdictFor`.
   */
  disabledVishingRules?: readonly string[];
  /**
   * The case's out-of-band verification token, bound to this utterance.
   *
   * When set, the gate REFUSES any text that contains it. This is the single
   * enforcement point for the most important invariant of the token feature: the
   * token travels on the customer's second channel and **never on the call**.
   *
   * It has to be here, at the speech boundary, rather than in a prompt or a
   * reviewer rule, because the ways it could leak are all ways that bypass prose:
   * a tenant-authored line, an LLM draft, a hard-coded script, a future
   * contributor. A guardrail that lives in a document is a guardrail that gets
   * violated the first time someone adds a feature and does not read the document.
   *
   * A refusal here is not an incident — it is the feature working.
   */
  verificationToken?: string;
};

export type SpeechGateResult = {
  /**
   * What may be spoken. **Empty means NOTHING may be spoken** — either the source
   * was empty/non-verbal, or the vishing blocklist refused it. Callers must treat
   * "" as "do not call the synthesiser", never as "speak nothing quickly".
   */
  text: string;
  /** Marker names actually inserted by redaction, e.g. ["PAN"]. */
  redactions: string[];
  /** Terminology pairs actually applied, e.g. ["interest" -> "profit rate"]. */
  substitutions: string[];
  truncated: boolean;
  /**
   * Why the text is empty. `none` for the ordinary cases, otherwise the blocklist
   * that refused it. This is the field an operator reads, and it is the reason
   * the refusal is safe to surface rather than merely fail silently.
   */
  vishing: VishingVerdict;
  /**
   * True when the utterance was refused for containing the case's out-of-band
   * verification token. Distinct from a vishing refusal because it means a bug in
   * this codebase rather than a bad model output, and the two are triaged
   * differently.
   */
  tokenLeak?: boolean;
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
 *
 * `protected` is the important argument. Some sentences must not be shortened
 * away, because losing them makes the guardrail destroy the thing it exists to
 * deliver:
 *
 *   - the opening disclosure ("this call is recorded to protect you"), and
 *   - the hang-up-safe exit ("you may hang up and call your bank's number").
 *
 * When a cap would drop a protected sentence, the sentence is kept and the
 * removable remainder is what gets trimmed. That is the opposite of the usual
 * instinct, and it is right: a 30-word agent reply that drops the disclosure is
 * an illegal call, and one that drops the exit hands the customer back to the
 * fraudster.
 */
export function withinWordLimit(
  text: string,
  maxWords = MAX_SPEECH_WORDS,
  mustKeep?: readonly string[],
): { text: string; truncated: boolean } {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return { text, truncated: false };

  const clause = /[,;:.!?؛،]\s+\S/;
  const head = words.slice(0, maxWords).join(" ");
  const boundaries = [...head.matchAll(new RegExp(clause.source, "g"))];
  const last = boundaries.at(-1);
  const trimmed =
    last && last.index !== undefined && last.index > head.length * 0.4
      ? head.slice(0, last.index + 1).trim()
      : `${head}.`;

  const keep = (mustKeep ?? []).filter(
    (p) =>
      p.trim().length > 0 && !trimmed.toLowerCase().includes(p.trim().slice(0, 40).toLowerCase()),
  );
  if (keep.length === 0) return { text: trimmed, truncated: true };

  // Drop the sentence that was truncated, then append what must survive. The exit
  // is appended rather than spliced so it is always the LAST thing said — which
  // is where a customer needs to hear it.
  const remnant = trimmed
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !keep.some((p) => s.toLowerCase().includes(p.trim().slice(0, 40).toLowerCase())))
    .join(" ")
    .trim();
  const budget = Math.max(0, maxWords - keep.join(" ").split(/\s+/).filter(Boolean).length);
  const keptRemnant = budget > 0 ? remnant.split(/\s+/).slice(0, budget).join(" ") : "";
  const out = [keptRemnant, ...keep].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return { text: out.length > 0 ? out : trimmed, truncated: true };
}

/**
 * Which sentences in this utterance must survive the word cap.
 *
 * Two things qualify, and both are sentences whose ABSENCE is a compliance
 * failure rather than a style problem: the recording disclosure, and the
 * hang-up-safe exit. `hasSafetyExit` is checked against the PRE-rewrite text as
 * well as the spoken form, because the Shariah substitution rewrites words the
 * matcher may key on.
 */
function protectedSentences(spoken: string, beforeRewrite: string): string[] {
  const out: string[] = [];
  const hasExit = hasSafetyExit(spoken) || hasSafetyExit(beforeRewrite);
  if (hasExit) {
    // The exit may be the LAST sentence rather than the whole tail, so extract
    // from the first clause that looks like the start of it.
    const sentences = spoken.split(/(?<=[.!?؟])\s+/);
    for (let i = sentences.length - 1; i >= 0; i--) {
      if (hasSafetyExit(sentences[i]!)) {
        out.push(sentences.slice(i).join(" ").trim());
        break;
      }
    }
  }
  return out;
}

/**
 * The gate. Call it immediately before handing text to any TTS transport.
 *
 * Order matters and is stated here because it is the security property:
 * the vishing blocklist runs on the SPOKEN FORM, after markdown has been stripped
 * and before anything else rewrites the text. Running it earlier would let a
 * tenant hide "act now" behind markdown, and running it later would let the Shariah
 * substitution rewrite a phrase into something the blocklist never saw.
 *
 * The blocklist's outcome is expressed as an EMPTY `text`, reusing the
 * "nothing renderable" signal the transports already handle. That is deliberate:
 * a refusal is then indistinguishable from an empty utterance at the transport
 * boundary, so a new call site cannot accidentally ship it — it inherits the
 * refusal for free instead of having to remember it.
 */
export function prepareSpeech(input: string, ctx: SpeechContext = {}): SpeechGateResult {
  const source = (input ?? "").trim();
  const CLEAN: VishingVerdict = { ok: true, hits: [] };
  if (!source)
    return { text: "", redactions: [], substitutions: [], truncated: false, vishing: CLEAN };

  const cleaned = toSpokenForm(source);

  // THE TOKEN CHECK, before anything rewrites the text.
  //
  // Deliberately placed ahead of the vishing blocklist, because the failure it
  // prevents is different in kind: a vishing refusal means "the model said
  // something a fraudster would say", whereas a token refusal means "something in
  // this codebase tried to move an out-of-band credential onto the call". The
  // second is a bug with an author, and it should be reported as one.
  //
  // It also runs ahead of the number pass for the same reason: a numeric token
  // rendered into words would no longer match, and the one check that keeps the
  // second-channel credential off the call must see the original bytes.
  if (ctx.verificationToken && speaksToken(cleaned, ctx.verificationToken)) {
    return {
      text: "",
      redactions: [],
      substitutions: [],
      truncated: false,
      vishing: CLEAN,
      tokenLeak: true,
    };
  }

  // RULE 5 — numbers as speech, deterministically.
  //
  // "forty-eight thousand dirhams", never "48,000 AED". This is the second
  // rewrite in the pipeline and its position is load-bearing: it runs AFTER
  // markdown/emoji stripping (so nothing hides inside formatting) and BEFORE
  // redaction (which matches card numbers and phones by their digit shapes —
  // rewriting them first would make a PAN unredactable) and BEFORE the vishing
  // verdict (so the blocklist judges the exact bytes that will be synthesised,
  // the same "checked on the bytes that will be spoken" discipline the final
  // re-check below enforces).
  const spoken = renderNumbersAsSpeech(cleaned);

  // Nothing a synthesiser could render: no letter and no digit survives. This is
  // checked here rather than at each call site so that "***", "###" and a
  // lone emoji are all treated the same way — as no utterance at all, which the
  // transports must not turn into a billable request or a moment of dead air.
  if (!/[\p{L}\p{N}]/u.test(spoken)) {
    return { text: "", redactions: [], substitutions: [], truncated: false, vishing: CLEAN };
  }

  // THE vishing refusal. Deliberately after normalisation and before the
  // optional rewrites: this is the check that makes the agent incapable of
  // speaking like an impersonator.
  const vishing = verdictFor(spoken, ctx.disabledVishingRules);
  if (!vishing.ok) {
    return {
      text: "",
      redactions: [],
      substitutions: [],
      truncated: false,
      vishing,
    };
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
      : withinWordLimit(shariah.text, ctx.maxWords, protectedSentences(shariah.text, spoken));

  // Re-checked after the rewrites. The Shariah substitution and the word-limit
  // truncation both run AFTER the first check above, so a rewrite could in
  // principle assemble a banned phrase out of innocuous pieces. This is cheap
  // (one regex sweep) and it is the difference between "checked once" and
  // "checked on exactly the bytes that will be synthesised".
  const finalVerdict = verdictFor(capped.text, ctx.disabledVishingRules);
  if (!finalVerdict.ok) {
    return {
      text: "",
      redactions: seen,
      substitutions: shariah.applied,
      truncated: capped.truncated,
      vishing: finalVerdict,
    };
  }

  return {
    text: capped.text,
    redactions: seen,
    substitutions: shariah.applied,
    truncated: capped.truncated,
    vishing: finalVerdict,
  };
}

/**
 * Refuse an utterance, loudly.
 *
 * `prepareSpeech` is the normal path and it already refuses. This exists for the
 * places that need to make the refusal an EVENT rather than a silent empty string:
 * the audit row, the operator console, and the media-stream worker.
 */
export function assertSpeakable(text: string, ctx: SpeechContext = {}): SpeechGateResult {
  return prepareSpeech(text, ctx);
}

export { describeHits };

/** Convenience wrapper for transports that only want the string. */
export function speechForTts(input: string, ctx?: SpeechContext): string {
  return prepareSpeech(input, ctx).text;
}
