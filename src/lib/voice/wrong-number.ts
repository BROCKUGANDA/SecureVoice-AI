import "server-only";
/**
 * Wrong-number and call-back-later handling for the intervention call.
 *
 * ## The two failures this exists to prevent
 *
 *   1. **The call continues.** The intervention agent has already recited
 *      merchant and amount to answer the phone. If the person on the line is not
 *      the cardholder — a spouse, a flatmate, a wrong number, a shop that gave
 *      out a phone number instead of an extension — every word after that is a
 *      disclosure of one customer's financial data to a third party, on a live
 *      recorded line, in a country whose PDPL makes that the bank's problem and
 *      not the stranger's. Continuing is not embarrassment; it is a breach that
 *      gets discovered in an incident review rather than prevented.
 *   2. **The call ends with no record.** The other failure is administrative
 *      and just as expensive: the bank is told nothing, the case sits open, and
 *      the fraud it was raised for is still out there.
 *
 * ## The single most important invariant in this file
 *
 * **WRONG-NUMBER DETECTION MUST NEVER CAUSE A CARD FREEZE OR AN ESCALATION.**
 *
 * A stranger saying "that's not my number" is not a fraud signal. The card being
 * called about belongs to someone else and the risk engine has already decided
 * what to do with it. Freezing on a wrong number would let anyone freeze any
 * card by answering the phone and saying four words — a denial-of-service on
 * the fraud programme, delivered by the attacker's own voice. Every function
 * here therefore returns `mustNotFreeze: true` and `mustNotEscalate: true` as
 * literal types, and `closurePath()` is constrained to reject any route through
 * FREEZE_STAGED or ESCALATED even if one existed.
 *
 * ## WHY THERE IS NO STATE MACHINE HERE
 *
 * `src/lib/case-state-machine.ts` is the ONE writer of case state, and this
 * module does not import a writer. It imports `canTransition` — the canonical
 * gate — and computes, rather than asserts, whether a path to CLOSED (wrong
 * number) or NOTIFIED (callback) exists from wherever the case currently sits.
 * The caller applies each edge through `transitionCase`, which throws on an
 * illegal one. If the answer is `null`, the caller has found a real gap in the
 * machine rather than a missing `if`.
 *
 * The gap it found is stated in the report and encoded here: a caller who asks
 * for a call-back MIDDLE of verification cannot be re-dialled, because
 * RETRY_SCHEDULED is only reachable from the unreachable family
 * (NO_ANSWER / BUSY / VOICEMAIL / UNREACHABLE). A new EDGE — not a new state —
 * is the fix, and adding one is a change to another file.
 */

import { z } from "zod";
import { append as auditAppend } from "@/lib/audit-chain";
import { canTransition, CASE_STATES } from "@/lib/case-state-machine";
import { asCallCategory } from "@/lib/call-categories";
import * as redact from "@/lib/redact";

export type WrongNumberLang = "en" | "ar";

export type WrongNumberVerdict = {
  kind: "wrong_number" | "callback_requested" | "not_detected";
  /**
   * How strongly the phrase implies the caller is not the cardholder.
   *
   * The two tiers exist because "this is not my number" and "who is this?" are
   * both true of a stranger, and only one of them is safe to hang up on. The
   * second is what a real cardholder asks in the first ten seconds of a fraud
   * call. Closing on it would drop the customer the product exists to serve, so
   * it scores below `MIN_ACTIONABLE_CONFIDENCE` and `buildWrongNumberClosure`
   * refuses to produce a closing line for it.
   */
  confidence: number;
  /** The phrase that fired, or null. Present so a human can audit the decision. */
  matched: string | null;
};

export type CallbackWhen = "later_today" | "tomorrow" | "unspecified";

export type CallbackRequest = {
  requested: boolean;
  when?: CallbackWhen;
  matched: string | null;
};

/**
 * Below this, a detection is reported but NOT acted on.
 *
 * It exists because the consequence of being wrong is asymmetric in the worst
 * possible way: a missed wrong-number is one more disclosure in a log nobody
 * reads; a false positive here hangs up on the actual cardholder and loses the
 * fraud review.
 */
export const MIN_ACTIONABLE_CONFIDENCE = 0.9;

/** Confidence for an explicit denial. See the rule table. */
const CONFIDENT = 0.95;
/** Confidence for an identity question. Deliberately below the action threshold. */
const INDICATIVE = 0.55;

/* ─────────────────────────────── normalisation ─────────────────────────────── */

const ARABIC_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/**
 * Fold caller speech to a comparable form.
 *
 * The Arabic arm does more than strip marks. Speech-to-text emits "هٰذا" for
 * "هذا", "رقمي" for "رقمى", and an inconsistent alef form for the same speaker
 * twice in one call, so the letter forms are unified as well: أ إ آ ٱ → ا,
 * ى → ي, ة → ه. Written WITHOUT `\b` anywhere, because `\b` is a word boundary
 * defined on `\w` and it never matches around Arabic script — the same trap
 * `src/lib/compliance/vishing.ts` documents on its `ar.*` rules.
 */
function fold(raw: string): string {
  return (raw ?? "")
    .normalize("NFKC")
    .replace(ARABIC_MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    // Apostrophes fold away before punctuation, so "isn't" is ONE token and not
    // two. Without this, every contraction in the language — which is most of
    // how people actually speak — evades every phrase rule in this file.
    .replace(/['’`]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Arabic phrase rules, matched against a SPACE-SQUASHED form.
 *
 * Not a preference. Two reasons, and the first one is decisive:
 *
 *   1. Transcribed Arabic is full of spacing the writer never intended — a
 *      hesitation, a stray space, a word split across two tokens — and a phrase
 *      rule that requires exactly one space between two words misses those. The
 *      squashed form is why `هذاليسرقمي` matches regardless.
 *   2. `\s*` between two Arabic literals is not dependable across engines, and
 *      the repo's own note on `\b` (src/lib/compliance/vishing.ts) is that
 *      ASCII word-boundary machinery simply does not apply to this script.
 *      A substring test on a normalised string has neither problem.
 *
 * `key` is the squashed matcher; `phrase` is the readable form a human reads
 * in the audit trail. The ASR slice is deliberately NOT returned for Arabic —
 * raw Arabic ASR output is diacritics and spacing noise, which is useless to
 * an auditor, whereas the canonical phrase is what the rule was reviewed as.
 */
type ArRule = { key: string; phrase: string; confidence: number };

const squashed = (s: string) => s.replace(/\s+/g, "");

/**
 * Cap the returned phrase. A caller can say anything; an audit row is 500
 * characters of storage and a human's afternoon.
 */
const MATCH_CAP = 60;

function phraseOf(source: string, match: RegExpExecArray): string {
  const slice = source.slice(match.index, match.index + match[0].length);
  const clean = redact.transcript(slice).replace(/\s+/g, " ").trim();
  return clean.length > MATCH_CAP ? `${clean.slice(0, MATCH_CAP - 1)}…` : clean;
}

type Rule = { re: RegExp; confidence: number; lang: WrongNumberLang };

/**
 * Wrong-number phrases.
 *
 * Grouped by what they ASSERT rather than alphabetically, because the grouping
 * is the review argument: the first group is a denial of identity that no
 * cardholder would say about their own number, the second is a statement about
 * the household, and the third only asks a question — which is why it is
 * INDICATIVE and not CONFIDENT.
 *
 * Single tokens are excluded on purpose. "wrong" alone fires on "what's wrong
 * with my card", and "not mine" alone fires on "that charge is not mine" — which
 * is a fraud report, the single most valuable thing a customer can say on this
 * call, and it must NOT be classified as a wrong number.
 */
const WRONG_NUMBER_RULES: readonly Rule[] = [
  // — explicit denial of the number —
  {
    re: /\b(?:this|that|it)s?\s+(?:is\s+|the\s+)?wrong\s+(?:number|phone|person|caller)\b/iu,
    confidence: CONFIDENT,
    lang: "en",
  },
  {
    re: /\b(?:youve|you\s+have|you\s+got|youve\s+got)\s+(?:the\s+)?wrong\s+(?:number|phone|person|caller)\b/iu,
    confidence: CONFIDENT,
    lang: "en",
  },
  { re: /\bwrong\s+(?:phone\s+)?number\b/iu, confidence: CONFIDENT, lang: "en" },
  {
    re: /\b(?:this|that|it)s?\s+(?:is\s+not|isnt|not)\s+my\s+(?:number|phone|telephone|line)\b/iu,
    confidence: CONFIDENT,
    lang: "en",
  },
  { re: /\b(?:its|it\s+is)\s+not\s+mine\b[^.?!]{0,20}\bnumber\b/iu, confidence: CONFIDENT, lang: "en" },
  { re: /\bnot\s+the\s+(?:right|correct)\s+(?:number|person)\b/iu, confidence: CONFIDENT, lang: "en" },
  {
    re: /\bthis\s+number\s+belongs\s+to\s+(?:someone\s+else|somebody\s+else|another\s+person)\b/iu,
    confidence: CONFIDENT,
    lang: "en",
  },
  { re: /\bthis\s+(?:number|phone)\s+is\s+not\s+mine\b/iu, confidence: CONFIDENT, lang: "en" },
  { re: /\bsome(?:one|body)\s+elses\s+(?:number|phone)\b/iu, confidence: CONFIDENT, lang: "en" },
  // — statements about the household —
  {
    re: /\bno\s?(?:one|body)\s+(?:by\s+(?:that|this)\s+name|with\s+(?:that|this)\s+name)\s+(?:lives?|here|answers?)\b/iu,
    confidence: CONFIDENT,
    lang: "en",
  },
  {
    re: /\bno\s?(?:one|body)\s+(?:by\s+(?:that|this)\s+name|with\s+(?:that|this)\s+name)\b/iu,
    confidence: CONFIDENT,
    lang: "en",
  },
  {
    re: /\bthis\s+is\s+not\s+my\s+(?:spouse|wife|husband|partner|father|mother|son|daughter|sister|brother)\b/iu,
    confidence: CONFIDENT,
    lang: "en",
  },
  { re: /\bi\s+(?:dont|do\s+not)\s+know\s+you\b/iu, confidence: CONFIDENT, lang: "en" },
  { re: /\byou\s+(?:have|got|called)\s+the\s+wrong\b/iu, confidence: CONFIDENT, lang: "en" },
  // — identity questions. NOT sufficient on their own. —
  { re: /\bwho\s+is\s+this\b/iu, confidence: INDICATIVE, lang: "en" },
  { re: /\bwhos\s+this\b/iu, confidence: INDICATIVE, lang: "en" },
  { re: /\bwho\s+is\s+(?:calling|talking|on\s+the\s+line)\b/iu, confidence: INDICATIVE, lang: "en" },
  { re: /\bwhere\s+did\s+you\s+get\s+(?:my|this)\s+number\b/iu, confidence: INDICATIVE, lang: "en" },
];

/** Arabic wrong-number phrases. `key` is squashed — see the ArRule doc. */
const WRONG_NUMBER_AR: readonly ArRule[] = [
  { key: "رقمغيرصحيح", phrase: "رقم غير صحيح", confidence: CONFIDENT },
  { key: "رقمشخصاخر", phrase: "رقم شخص آخر", confidence: CONFIDENT },
  { key: "رقماخر", phrase: "رقم آخر", confidence: CONFIDENT },
  { key: "هذاليسرقمي", phrase: "هذا ليس رقمي", confidence: CONFIDENT },
  { key: "هذهليسترقمي", phrase: "هذه ليست رقمي", confidence: CONFIDENT },
  { key: "ليستهرقمي", phrase: "ليس رقمي", confidence: CONFIDENT },
  { key: "ليستهذا", phrase: "ليست هذا", confidence: CONFIDENT },
  { key: "لايوجداحدبهذاالاسم", phrase: "لا يوجد أحد بهذا الاسم", confidence: CONFIDENT },
  { key: "لايوجداحدبهذهالاسم", phrase: "لا يوجد أحد بهذا الاسم", confidence: CONFIDENT },
  { key: "لااحدبهذاالاسم", phrase: "لا أحد بهذا الاسم", confidence: CONFIDENT },
  { key: "لااحدبهذهالاسم", phrase: "لا أحد بهذا الاسم", confidence: CONFIDENT },
  { key: "ماهذاالرقم", phrase: "ما هذا الرقم", confidence: INDICATIVE },
  { key: "منهذا", phrase: "من هذا", confidence: INDICATIVE },
  { key: "منانت", phrase: "من أنت", confidence: INDICATIVE },
  { key: "منيتكلم", phrase: "من يتكلم", confidence: INDICATIVE },
  { key: "كيفحمصلكرقمي", phrase: "كيف حصلت على رقمي", confidence: INDICATIVE },
];

/**
 * Call-back requests, with the time window when the caller gave one.
 *
 * "not a good time" and "I'm driving" are requests in the sense that matters —
 * the caller is telling us not to continue on this line — but they are weaker
 * than "call me back", so they score lower and the closure line for them asks
 * rather than assumes.
 */
const CALLBACK_RULES: readonly Rule[] = [
  { re: /\bcall\s+me\s+back\b/iu, confidence: CONFIDENT, lang: "en" },
  { re: /\b(?:ring|call)\s+me\s+(?:back|later|another\s+time)\b/iu, confidence: CONFIDENT, lang: "en" },
  { re: /\b(?:try|phone)\s+(?:me\s+)?(?:back\s+)?(?:later|again\s+later|another\s+time)\b/iu, confidence: CONFIDENT, lang: "en" },
  { re: /\bget\s+back\s+to\s+me\b/iu, confidence: CONFIDENT, lang: "en" },
  { re: /\bnot\s+a\s+(?:good|right|convenient)\s+time\b/iu, confidence: 0.9, lang: "en" },
  { re: /\b(?:is|it)\s+not\s+(?:a\s+)?(?:good\s+)?time\s+(?:now|right\s+now)\b/iu, confidence: 0.9, lang: "en" },
  { re: /\b(?:i'?m|im)\s+(?:driving|at\s+work|in\s+(?:a\s+)?meeting|in\s+class)\b/iu, confidence: 0.85, lang: "en" },
  { re: /\b(?:i\s+cant|i\s+cannot|cant|cannot)\s+(?:talk|chat|speak)\s+(?:now|right\s+now)\b/iu, confidence: 0.85, lang: "en" },
  { re: /\b(?:email|text|message)\s+me\b/iu, confidence: 0.8, lang: "en" },
  { re: /\bsend\s+me\s+(?:a\s+)?(?:message|text|email)\b/iu, confidence: 0.8, lang: "en" },
  { re: /\bsome\s+other\s+time\b/iu, confidence: 0.8, lang: "en" },
  { re: /\bim\s+busy\b/iu, confidence: 0.7, lang: "en" },
];

/** Arabic call-back phrases. `key` is squashed — see the ArRule doc. */
const CALLBACK_AR: readonly ArRule[] = [
  { key: "اتصلبي", phrase: "اتصل بي", confidence: CONFIDENT },
  { key: "اتصلمع", phrase: "اتصل معي", confidence: CONFIDENT },
  { key: "راسلني", phrase: "راسلني", confidence: CONFIDENT },
  { key: "راسلوني", phrase: "راسلونا", confidence: CONFIDENT },
  { key: "الوقتغيرمناسب", phrase: "الوقت غير مناسب", confidence: 0.9 },
  { key: "وقتغيرمناسب", phrase: "وقت غير مناسب", confidence: 0.9 },
  { key: "مشوقتمناسب", phrase: "مش وقت مناسب", confidence: 0.9 },
  { key: "ماستطيع", phrase: "ما أستطيع", confidence: 0.85 },
  { key: "انامشغول", phrase: "أنا مشغول", confidence: 0.7 },
  { key: "فياجتماع", phrase: "في اجتماع", confidence: 0.85 },
];

/**
 * Time windows.
 *
 * English is matched as whole words (`\b` works here) and Arabic as squashed
 * substrings, for the reason given on ArRule: ASCII word-boundary machinery does
 * not apply to the Arabic script and the transcriber's spacing is unreliable.
 */
const TOMORROW_EN = ["tomorrow", "next day", "tmrw"];
const LATER_TODAY_EN = [
  "later today",
  "this afternoon",
  "this evening",
  "this morning",
  "later on",
  "tonight",
  "in an hour",
];
const TOMORROW_AR = ["غدا", "غداً", "بكرة", "بكره", "بكرة الصبح"];
const LATER_TODAY_AR = ["اليوم", "بعد شوية", "بعدين", "قريبا", "قريباً", "هذا المساء"];

function hasWord(text: string, words: readonly string[]): boolean {
  return words.some((w) => new RegExp(`\\b${w}\\b`, "iu").test(text));
}

function hasPhrase(sq: string, phrases: readonly string[]): boolean {
  return phrases.some((p) => sq.includes(squashed(p)));
}

function callbackWhenOf(folded: string): CallbackWhen {
  const sq = squashed(folded);
  if (hasWord(folded, TOMORROW_EN) || hasPhrase(sq, TOMORROW_AR)) return "tomorrow";
  if (hasWord(folded, LATER_TODAY_EN) || hasPhrase(sq, LATER_TODAY_AR)) return "later_today";
  return "unspecified";
}

type Hit = { confidence: number; matched: string };

function firstMatch(
  folded: string,
  rules: readonly Rule[],
  arRules: readonly ArRule[],
  lang?: WrongNumberLang,
): Hit | null {
  for (const rule of rules) {
    if (lang && rule.lang !== lang) continue;
    rule.re.lastIndex = 0;
    const m = rule.re.exec(folded);
    if (m) return { confidence: rule.confidence, matched: phraseOf(folded, m) };
  }
  if (lang === "en") return null;
  const squashedText = squashed(folded);
  for (const rule of arRules) {
    if (squashedText.includes(squashed(rule.key))) {
      return { confidence: rule.confidence, matched: rule.phrase };
    }
  }
  return null;
}

/**
 * Did the caller say the number is wrong?
 *
 * Deterministic and rule-based on purpose. This runs on a live call between a
 * stranger and a bank, and the cost of a wrong answer is a disclosure, so the
 * decision has to be reproducible, reviewable by a human, and free of any model
 * that might be persuaded by what the caller said. A confidence that is a
 * constant chosen per rule — not a score from a classifier — is the property
 * that makes the audit trail meaningful.
 *
 * `language` narrows matching to one script. Omitting it scans both, which is
 * the right default for a UAE deployment: the transcriber labels the language
 * of the whole call, and a code-switched "yes ما هو هذا الرقم" is labelled
 * `en` often enough that trusting the label alone loses the detection.
 */
export function detectWrongNumber(text: string, opts?: { language?: WrongNumberLang }): WrongNumberVerdict {
  const folded = fold(text);
  if (!folded) return { kind: "not_detected", confidence: 0, matched: null };

  const wrong = firstMatch(folded, WRONG_NUMBER_RULES, WRONG_NUMBER_AR, opts?.language);
  if (wrong) {
    return { kind: "wrong_number", confidence: wrong.confidence, matched: wrong.matched };
  }
  // A callback request is the other way this call should end, and it is
  // reported through the same verdict so the caller has ONE decision to make
  // rather than two that can disagree.
  const back = detectCallbackRequest(text, opts);
  if (back.requested) {
    // The callback detector's own confidence is used rather than a second
    // pass: two evaluations of the same deterministic table can only disagree
    // if the code changed between them, and the audit row should carry one
    // number, not two that have to be reconciled.
    const hit = firstMatch(folded, CALLBACK_RULES, CALLBACK_AR, opts?.language);
    return {
      kind: "callback_requested",
      confidence: hit?.confidence ?? 0,
      matched: back.matched,
    };
  }
  return { kind: "not_detected", confidence: 0, matched: null };
}

/**
 * Did the caller ask to be called back, and roughly when?
 *
 * A separate entry point because a busy cardholder and a stranger are two
 * different closures: one ends the case, the other does not.
 */
export function detectCallbackRequest(
  text: string,
  opts?: { language?: WrongNumberLang },
): CallbackRequest {
  const folded = fold(text);
  if (!folded) return { requested: false, matched: null };
  const hit = firstMatch(folded, CALLBACK_RULES, CALLBACK_AR, opts?.language);
  if (!hit) return { requested: false, matched: null };
  return { requested: true, when: callbackWhenOf(folded), matched: hit.matched };
}

/* ───────────────────────────── PDPL redaction ───────────────────────────── */

/**
 * What the attempt looked like. Validated, then IGNORED.
 *
 * The parameters exist so the control is testable: the function's entire claim
 * is that its output is INVARIANT to its input, and an empty parameter list
 * cannot demonstrate that. Everything here is parsed through zod so a caller
 * passing `amountMinor: -1` or `cardLast4: "1234567890123456"` gets the neutral
 * line rather than an accidental echo.
 */
const AttemptSchema = z.object({
  merchant: z.string().max(200).optional(),
  amountMinor: z.number().int().optional(),
  cardLast4: z.string().regex(/^\d{4}$/).optional(),
});

/**
 * The line that is safe to say to someone who is NOT the cardholder.
 *
 * No merchant. No amount. No last four. No case reference. No number of any
 * kind — `tests/unit/wrong-number.test.ts` asserts the output contains no digit
 * at all, which is stronger and simpler than auditing a list of fields.
 *
 * It also apologises and hangs up. That is not politeness: a stranger who is
 * handed transaction details has no way to know whether to be alarmed, and the
 * fastest way to stop them calling the bank's fraud line and reporting a
 * phishing attempt is to let them go quickly and without a sales pitch.
 */
export function redactForWrongNumber(
  attempt: { merchant?: string; amountMinor?: number; cardLast4?: string },
  opts?: { language?: WrongNumberLang },
): string {
  // Parsed for validation, deliberately unused for content.
  AttemptSchema.parse(attempt ?? {});
  const lang = opts?.language === "ar" ? "ar" : "en";
  if (lang === "ar") {
    return "أتصل من مصرفك بخصوص أحد الحسابات. ليس لديّ إذن لمشاركة التفاصيل، لذلك سأغلق المكالمة الآن.";
  }
  return "I am calling from your bank about an account. I am not authorised to share details with you, so I will end this call now. No action was taken.";
}

/* ─────────────────────────────── the closure ─────────────────────────────── */

/**
 * States a wrong-number or callback closure may never pass through.
 *
 * FREEZE_STAGED because a stranger must not be able to place a hold on someone
 * else's card; ESCALATED because a queue full of strangers reporting fraud is
 * how a bank's fraud team learns to ignore the queue.
 */
const FORBIDDEN_STATES: ReadonlySet<string> = new Set(["FREEZE_STAGED", "ESCALATED"]);

/**
 * Successors are visited in this order, so the path this publishes says the
 * LEAST that is still true.
 *
 * VERIFYING cannot close directly, and its two legal routes both work. Going
 * via UNCERTAIN records "we did not establish who this was"; going via
 * CONFIRMED_LEGITIMATE records "the customer confirmed the transaction was
 * theirs" — which a stranger did not, and which is published to the bank's
 * fraud team as evidence. Both are legal edges, so nothing here can pick the
 * right one by legality alone. It has to be chosen, and it has to be chosen in
 * one place rather than by enumeration order.
 */
const PREFERRED_SUCCESSORS: readonly string[] = ["UNCERTAIN", "NOTIFIED", "CLOSED", "RETRY_SCHEDULED"];

/**
 * The legal path from `from` to `target`, using the canonical machine only.
 *
 * Breadth-first over `CASE_STATES` with `canTransition` as the edge predicate, so
 * this is a QUERY against the machine rather than a second opinion about it.
 * Returns null when no legal path exists, which is the honest answer for a
 * caller asking for a redial mid-verification.
 */
export function closurePath(from: string, target: "CLOSED" | "NOTIFIED" | "RETRY_SCHEDULED"): string[] | null {
  if (!CASE_STATES.includes(from as (typeof CASE_STATES)[number])) return null;
  if (from === target) return [];
  const order = (s: string) => {
    const i = PREFERRED_SUCCESSORS.indexOf(s);
    return i === -1 ? PREFERRED_SUCCESSORS.length + CASE_STATES.indexOf(s as never) : i;
  };
  const successors = (state: string): string[] =>
    CASE_STATES.filter((s) => canTransition(state, s) && !FORBIDDEN_STATES.has(s)).sort(
      (a, b) => order(a) - order(b),
    );

  const queue: string[][] = [[from]];
  const seen = new Set<string>([from]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    for (const next of successors(path[path.length - 1]!)) {
      if (seen.has(next)) continue;
      const extended = [...path, next];
      if (next === target) return extended;
      seen.add(next);
      queue.push(extended);
    }
  }
  return null;
}

export type WrongNumberClosure = {
  outcome: WrongNumberVerdict["kind"];
  /** True only when the caller may hang up. See MIN_ACTIONABLE_CONFIDENCE. */
  actionable: boolean;
  /** What the agent says. Never contains merchant, amount, card digits or a case ref. */
  speech: string;
  language: WrongNumberLang;
  /** LITERAL TRUE, so the invariant is readable at the call site and in a diff. */
  mustNotFreeze: true;
  mustNotEscalate: true;
  record: {
    /** Audit intent. */
    intent: "wrong_number_detected" | "callback_requested" | "wrong_number_not_conclusive";
    /** Redacted, caller-text-free note for the bank's own log. */
    note: string;
    callbackWhen?: CallbackWhen;
    /** Terminal state, or null when the machine has no legal path from here. */
    suggestedState: "CLOSED" | "NOTIFIED" | null;
    /** Every edge, in order. The caller applies each through `transitionCase`. */
    path: readonly string[];
    /** True when the caller wants another attempt but the machine cannot express it. */
    redialRequired: boolean;
    /** Null from any state the machine cannot re-dial from. See the header note. */
    redialPath: readonly string[] | null;
  };
};

const SPEECH = {
  wrong_number: {
    en: "I am sorry, this is the wrong number. I will not share any account details. No action was taken on your account, and I am ending this call now.",
    ar: "آسف، هذا رقم غير صحيح. لن أشارك أي تفاصيل عن الحساب. لم يتم اتخاذ أي إجراء على حسابك، وسأنهي المكالمة الآن.",
  },
  callback_requested: {
    en: "Of course, I will not keep you. Is a call back later today alright, or would you prefer another time? No action was taken while we spoke.",
    ar: "بالتأكيد، لن أطيل عليك. هل يناسبك الاتصال لاحقاً اليوم أم وقتاً آخر؟ لم يتم اتخاذ أي إجراء أثناء حديثنا.",
  },
  not_detected: {
    en: "",
    ar: "",
  },
} as const satisfies Record<WrongNumberVerdict["kind"], Record<WrongNumberLang, string>>;

const NOTE = {
  wrong_number: "line reached a party who stated the number is not theirs; no account detail was disclosed",
  callback_requested: "cardholder asked to continue on another occasion; no freeze staged and no escalation queued",
  not_detected: "identity query or unrelated speech; call continued",
} as const;

/**
 * Turn a verdict into what the agent says and what must be written down.
 *
 * The `currentState` argument is optional, and its absence is handled honestly
 * rather than optimistically: with no state supplied there is no path to
 * publish, so `suggestedState` is null and the caller is told to derive it from
 * the real case row. Guessing `VERIFYING` here and emitting a path would put a
 * confident-looking transition plan in the audit record that may not be legal
 * from where the case actually is.
 */
export function buildWrongNumberClosure(
  verdict: WrongNumberVerdict,
  opts?: { language?: WrongNumberLang; currentState?: string; callback?: CallbackRequest },
): WrongNumberClosure {
  const language = opts?.language === "ar" ? "ar" : "en";
  const actionable = verdict.kind !== "not_detected" && verdict.confidence >= MIN_ACTIONABLE_CONFIDENCE;
  const outcome: WrongNumberVerdict["kind"] = actionable ? verdict.kind : "not_detected";
  const target: "CLOSED" | "NOTIFIED" | null =
    outcome === "wrong_number" ? "CLOSED" : outcome === "callback_requested" ? "NOTIFIED" : null;
  const path = target && opts?.currentState ? closurePath(opts.currentState, target) : null;
  // A call-back asked for mid-verification cannot be re-dialled: RETRY_SCHEDULED
  // is only reachable from the unreachable family. Reported, never papered over.
  const redialRequired = outcome === "callback_requested";
  const redialPath =
    redialRequired && opts?.currentState ? closurePath(opts.currentState, "RETRY_SCHEDULED") : null;

  const callbackWhen = outcome === "callback_requested" ? opts?.callback?.when : undefined;

  return {
    outcome,
    actionable,
    speech: actionable ? SPEECH[outcome][language] : "",
    language,
    mustNotFreeze: true,
    mustNotEscalate: true,
    record: {
      intent:
        outcome === "wrong_number"
          ? "wrong_number_detected"
          : outcome === "callback_requested"
            ? "callback_requested"
            : "wrong_number_not_conclusive",
      note: NOTE[outcome],
      ...(outcome === "callback_requested" && callbackWhen ? { callbackWhen } : {}),
      // `target` is already narrowed to the two terminal states by `outcome`,
      // so this is the terminal the BFS actually reached — not a guess.
      suggestedState: path && target ? target : null,
      path: path ?? [],
      redialRequired,
      redialPath,
    },
  };
}

/* ──────────────────────────────── the audit ──────────────────────────────── */

/**
 * Record the outcome on the tamper-evident chain.
 *
 * `redactedText` carries the MATCHED PHRASE, not the caller's turn: it is
 * already `redact.transcript`-ed and capped by `phraseOf`, and it is the only
 * thing that lets an auditor answer "why did the platform believe this person
 * was not the cardholder" months later. The rest of the utterance is never
 * stored — `src/lib/memory-guard.ts` exists precisely because stored caller text
 * becomes stored injection.
 *
 * Never throws. An audit write failing must not strand a stranger on the line;
 * the call ends either way and the missing row shows up in the chain
 * verification rather than as a customer complaint.
 */
export async function auditWrongNumber(args: {
  callRef: string;
  verdict: WrongNumberVerdict;
  callback?: CallbackRequest;
  orgId?: string | null;
  callerId?: string;
  currentState?: string;
}): Promise<boolean> {
  if (args.verdict.kind === "not_detected") return false;
  const closure = buildWrongNumberClosure(args.verdict, {
    ...(args.currentState ? { currentState: args.currentState } : {}),
  });
  try {
    await auditAppend(
      {
        callRef: args.callRef,
        action: "agent",
        intent: closure.record.intent,
        ...(args.callerId ? { callerId: args.callerId } : {}),
        ...(args.orgId ? { orgId: args.orgId } : {}),
        redactedText: args.verdict.matched
          ? `caller said: "${args.verdict.matched}" (confidence ${args.verdict.confidence})`
          : "caller stated the number was wrong",
        meta: {
          kind: args.verdict.kind,
          confidence: args.verdict.confidence,
          actionable: closure.actionable,
          // Stated, not merely omitted. A row that records "no freeze was
          // staged" is the evidence that a wrong-number call cannot be used to
          // attack the card it dialled.
          freezeStaged: false,
          escalated: false,
          callCategory: asCallCategory(null),
          ...(args.callback?.when ? { callbackWhen: args.callback.when } : {}),
          ...(closure.record.suggestedState ? { suggestedState: closure.record.suggestedState } : {}),
        },
      },
      { fast: true },
    );
    return true;
  } catch {
    return false;
  }
}

/** Exposed so a caller can enumerate what this module can detect. */
export function wrongNumberRuleCount(): { wrongNumber: number; callback: number } {
  return {
    wrongNumber: WRONG_NUMBER_RULES.length + WRONG_NUMBER_AR.length,
    callback: CALLBACK_RULES.length + CALLBACK_AR.length,
  };
}

/**
 * Can the canonical machine express this closure from `state`, without a freeze
 * and without an escalation?
 *
 * A convenience for the caller that would otherwise have to know which terminal
 * state each outcome targets. It answers the question by asking `closurePath`,
 * so it cannot disagree with the machine.
 */
export function canCloseFrom(state: string, outcome: "wrong_number" | "callback_requested"): boolean {
  return closurePath(state, outcome === "wrong_number" ? "CLOSED" : "NOTIFIED") !== null;
}
