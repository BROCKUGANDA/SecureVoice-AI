/**
 * Multi-agent intent router.
 *
 * Classifies the customer's utterance into one of the specialist roles the
 * voice agent can hand off to. This is intentionally lightweight: a small
 * keyword/pattern classifier rather than a second LLM call on every turn.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE PHRASE TABLES ARE EXPLICIT IN EVERY LANGUAGE
 *
 * The legacy agent route (src/app/api/agent/route.ts) already carried Urdu
 * denial phrases. This router did not — it was written with an English-only
 * regex, and on the media-stream path that silently dropped the single most
 * consequential classification in the product:
 *
 *   A fraud victim calls in Urdu and says "یہ میرا نہیں" (this is not mine).
 *   FRAUD_PATTERNS is /\b(no|not me|deny)\b/i. "نہیں" contains no ASCII
 *   word boundary match. The turn routes to `clarify`.
 *   The JIT AuthZ soft freeze in src/lib/ai/ai-authz.ts never fires.
 *   The card is NOT protected, and the audit chain records a routine
 *   clarification on a call that was actually a fraud report.
 *
 * That failure is silent and worst-in-the-product: it looks like a working
 * call, and it is a customer whose money is moving. So each language gets its
 * own phrase table, and `routeAgentIntent` checks ALL of them regardless of
 * which language the caller picked — because ASR on a code-switching UAE call
 * routinely returns Urdu words inside an English transcript, and pinning the
 * table to the declared `lang` would miss exactly the turns that matter.
 *
 * Adding a language means adding phrases here. The test
 * (tests/unit/router-urdu.test.ts) is what keeps that honest.
 */

export type AgentRole = "fraud_specialist" | "compliance_officer" | "empathy_agent" | "clarify";

/**
 * Bare denial TOKENS, as opposed to denial PHRASES.
 *
 * "no" is simultaneously the single most important answer on a fraud call (the
 * reply to "was this charge yours?") and one of the most common words in an
 * innocuous sentence ("no problem", "no questions", "no, wait — actually...").
 * Matching it anywhere over-triggers, and over-triggering here is a real harm:
 * it stages a pre-approved protective action on a card with no fraud report
 * behind it, which the bank then has to unwind and explain.
 *
 * The resolution is that a bare token is only a denial in the shape a denial
 * actually takes on a voice call — a short, isolated answer. "No." is an answer.
 * "No, I was asking about something else" is not. So bare tokens are gated on
 * utterance length, while explicit phrases ("not me", "میرا نہیں", "احتيال")
 * are matched at any length, because they are unambiguous wherever they appear.
 *
 * The threshold is in TOKENS rather than characters on purpose: these are
 * transcripts, and a caller who says "نہیں، نہیں میرا نہیں ہے" is 6 tokens but
 * unambiguous — which is why the Urdu phrases are also in the phrase table and
 * not only in the token table.
 */
const BARE_DENIAL_TOKENS = [
  "no",
  "nope",
  "nah",
  "yeah no",
  "yes no",
  // ar — "لا" is also the ordinary word for "no" in every dialect. Same
  // false-positive risk as English "no problem", so it is gated identically.
  "لا",
  "لأ",
  // hi — "नहीं" is both the standalone "no" and the negation suffix, which is
  // exactly why it must not be phrase-matched (see the Urdu note above).
  "नही",
  "नहीं",
  "ना",
  // ur — "نہیں" alone.
  "نہیں",
  "نہي",
  // fr
  "non",
  // sw
  "wala",
  "hapana",
];

/**
 * A bare token is only a denial when it is the WHOLE utterance.
 *
 * One token, not three, and that is a correction rather than a rounding. At a
 * 3-token threshold "no problem" — two words, utterly innocuous — classified as
 * a fraud report and staged a card freeze. Every compound that contains a bare
 * negation is innocuous far more often than it is a denial ("no problem", "no
 * questions", "no rush", "not at the moment" is a phrase and needs none of
 * this). Meanwhile a caller who says something longer but IS denying has
 * almost always included an explicit denial phrase — "not me", "میرا نہیں",
 * "I didn't do it" — which the phrase table already catches at any length.
 *
 * So the single-token case is the only one a bare token needs to cover, and the
 * phrase table covers everything else. Cutting this at one token is what makes
 * the classification safe to put in front of an irreversible action.
 */
const BARE_TOKEN_MAX_TOKENS = 1;

function isShortAnswer(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  return tokens.length <= BARE_TOKEN_MAX_TOKENS;
}

/**
 * Denial / fraud-report phrases.
 *
 * Ordered longest-phrase-first within each language and matched with a
 * letter/number boundary rather than `\b`, because `\b` is defined over
 * `[A-Za-z0-9_]` and therefore never matches around Arabic or Devanagari
 * script — a `\bنہیں\b` pattern silently matches nothing at all. Same reason the
 * Shariah filter in compliance/speech-gate.ts fences its Arabic rules.
 *
 * Negation-safety, which is why these are phrases and not stems: Urdu marks
 * negation as a separate word (نہیں) that also appears in AFFIRMATIVE
 * sentences ("میرا نہیں سوال" — "I have no question"), and a bare stem match on
 * نہیں would freeze a card because the caller asked something unrelated.
 */
const FRAUD_PHRASES: readonly string[] = [
  // en — the original set, preserved exactly.
  "not me",
  "wasn't me",
  "wasnt me",
  "didn't do it",
  "did not do it",
  "i didn't",
  "i did not",
  "don't recognise",
  "don't recognize",
  // Bare "no"/"nope" are NOT here — see BARE_DENIAL_TOKENS above. A bare token
  // in a long sentence ("no problem") is not a denial, and matching it there
  // would freeze a card because the caller said "no problem".
  "deny",
  "denied",
  "fraud",
  "scam",
  "stolen",
  "unauthorized",
  "unauthorised",
  "cancel",
  "block",
  "it wasn't me",
  // "not mine" is its own phrase, not a variant of "not me": the object a
  // caller denies is the TRANSACTION ("this is not mine") far more often than
  // it is themselves. Matching only "not me" missed the most literal way a
  // customer states fraud, in English as well as in every other language here.
  "not mine",
  "not my transaction",
  "not my charge",
  "i didn't make",
  // The last-resort recognition of an UNRECOGNISED transaction, which is what a
  // caller says when they are not yet sure it is fraud. "I don't know this
  // charge" must still reach a human, even without an explicit denial.
  "don't recognise",
  "don't recognize",
  "not authorised",
  "not authorized",
  "i don't recognise",
  "i don't recognize",

  // ur — "میرا نہیں" (not mine), "مجاز نہیں" (not authorised), "فراڈ" (fraud).
  //
  // Every form below is a DISAPPROVED phrase, not a stem. That is the whole
  // design constraint: Urdu marks negation as a separate word (نہیں) which also
  // appears in affirmative, innocuous sentences — "میرا نہیں سوال" ("I have no
  // question"), "مجھے کچھ نہیں چاہیے" ("I don't need anything"). A stem match on
  // نہیں would freeze a customer's card because they asked the agent to repeat
  // something. Only a full disapproval phrase can carry that consequence.
  //
  // Phrasal agreement also splits the possessive across three inflections
  // (میرا masculine / میری feminine / میرے plural), so listing one form would
  // miss half the callers — and the ones it misses are exactly the ones the
  // caller base that prompted the Urdu requirement represents.
  "میرا نہیں",
  "میری نہیں",
  "میرے نہیں",
  "مجھ سے نہیں",
  "مجھ کا نہیں",
  "مجاز نہیں",
  "میں نے نہیں کیا",
  "میں نے نہیں کی",
  "میں نے نہیں کھیلا",
  "میں نے نہیں بھیجا",
  "میں نے نہیں کرائی",
  // The verb carries the object, so the denial is not adjacent to the negation:
  // "میں نے کوئی خریداری نہیں کی" ("I made no purchase") puts خریداری between
  // نہیں and کی. Matching only the contiguous form misses the most natural way
  // an Urdu speaker denies a transaction, because Urdu is verb-final.
  "خریداری نہیں کی",
  "ادائیگی نہیں کی",
  "لین دین نہیں کیا",
  "پیسے نہیں بھیجے",
  "یہ میرا نہیں",
  "یہ مجھ کا نہیں",
  "میرا نہیں ہے",
  "فراڈ",
  "دھوکہ",
  "نہیں کیا",
  "چوری",
  "گمیاب",
  "مجاز نہیں بنایا",
  "بند کر دیں",
  "روک دیں",
  "کسی کو مت بھیج",

  // ar — Gulf/MSA. Same reasoning: gender inflection on the possessed noun
  // (لي masculine / لي feminine across dialects) plus the standalone negation.
  // ar — Gulf/MSA. "ليس لي" is the masculine form and "ليست لي" the feminine;
  // which one a caller uses depends on the object referred to (the charge is
  // masculine, the card is feminine), so both are listed rather than guessed.
  "ما هو بني",
  "مو بيه",
  "ليس لي",
  "ليست لي",
  "ما بستعملت",
  "لا أعرف",
  "ما أعرف",
  "لا أسمح",
  "ليس مسموح",
  "غير مصرح",
  "غير مصرّح",
  "احتيال",
  "نصب",
  "مزيف",
  "سرقة",
  "غريب",
  "ما أقبل",
  "مو أنا",

  // hi
  "मेरा नहीं",
  "मेरी नहीं",
  "मैंने नहीं",
  "मैंने नहीं किया",
  "धोखाधड़ी",
  "ठगी",
  "चोरी",
  "अनजान",

  // fr — "pas moi" (not me), "je n'ai pas" (I did not).
  "ce n'est pas moi",
  "pas moi",
  "je n'ai pas",
  "fraude",
  "arnaque",
  "vol",
  "inconnu",

  // sw
  "ni mimi",
  "sijaikuwa",
  "udanganyifu",
  "wizi",
  "sijui",
];

/**
 * Statutory-rights / complaint phrases.
 *
 * Checked AFTER fraud so a caller who says "I want to complain about this
 * unauthorised charge" routes to the fraud path — that customer has reported
 * fraud AND wants their rights, and the protective action is the more urgent of
 * the two. Routing them to compliance first would leave the card exposed while
 * a script explains their rights.
 */
const COMPLIANCE_PHRASES: readonly string[] = [
  "complaint",
  "ombudsman",
  "fca",
  "regulation",
  "legal",
  "lawyer",
  "rights",
  "evidence",
  "disclosure",
  "record",
  "gdpr",
  "complain",
  // ar
  "شكوى",
  "الشكاوى",
  "حقي",
  "حقوقي",
  "محامي",
  "هيئة",
  // ur
  "شکایت",
  "حق",
  "حقوق",
  "وکیل",
  // hi
  "शिकायत",
  "अधिकार",
  "वकील",
  // fr
  "plainte",
  "droits",
  "avocat",
  // sw
  "sh complaint",
  "haki",
  "mwanasheria",
];

/**
 * Distress / vulnerability phrases.
 *
 * The brief for Support Through Difficult Moments: bereavement, serious illness
 * and job loss trigger account freezes, and the agent must recognise the
 * signal in the customer's own language and hand to a human rather than
 * continuing a script. These are the words that arrive when someone is not
 * describing a transaction at all.
 */
const EMPATHY_PHRASES: readonly string[] = [
  "scared",
  "worried",
  "anxious",
  "help",
  "please",
  "upset",
  "angry",
  "confused",
  "ill",
  "bereavement",
  "hospital",
  "died",
  "funeral",
  "lost my job",
  "unemployed",
  "i don't understand",
  // ar — bereavement and job loss are the Support Through Difficult Moments
  // triggers, and they arrive in Gulf Arabic on routine collections calls.
  "خائف",
  "خائفة",
  "قلق",
  "مساعدة",
  "أنقذوني",
  "مستشفى",
  "وفاة",
  "موت",
  "فقدت",
  "بلا عمل",
  "لا أفهم",
  "حزين",
  // ur — bereavement is where the euphemism matters most. Nobody volunteers
  // "موت" (death) on a recorded call to a collections agent; the conventional
  // Urdu is "انتقال" (literally "transfer / passing on") — "میری امی کا انتقال ہو
  // گیا" is how a bereaved customer says their mother died. Listing موت alone
  // would miss every real grief disclosure, and this is the Support Through
  // Difficult Moments path that is supposed to hand off to a human.
  "خوف",
  "مدد",
  "بیمار",
  "ہسپتال",
  "موت",
  "انتقال",
  "گزر گئے",
  "پر گئے",
  // "ڈر" is the Urdu noun for fear/danger and carries it alone: "مجھے ڈر لگ رہا
  // ہے" ("I am starting to feel afraid"). A stem is safe here where it was not
  // for the negation words above — no ordinary sentence uses ڈر without meaning
  // distress — and the same is true of گھبراہٹ (panic).
  "ڈر",
  "گھبراہٹ",
  "پریشانی",
  "نہیں سمجھ",
  "سمجھ نہیں",
  "سمجھا نہیں",
  "پریشان",
  "اداس",
  "رویا",
  // hi
  "डर",
  "मदद",
  "अस्पताल",
  "बीमार",
  // fr
  "j'ai peur",
  "aidez",
  "hôpital",
  "malade",
  // sw
  "ogopa",
  "msaada",
  "hospitalini",
  "magonjwa",
  "nimefanya",
  "sinipenda",
];

type PhraseSet = readonly string[];

function fences(phrase: string): string {
  return `(?<![\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`;
}

function buildMatcher(phrases: PhraseSet): RegExp {
  // Longest first, so "not me" is consumed before "no" can match its middle.
  // Without this, the two-word denial rewrites as "no" plus leftover text.
  const ordered = [...phrases].sort((a, b) => b.length - a.length);
  return new RegExp(ordered.map(fences).join("|"), "iu");
}

const FRAUD_RE = buildMatcher(FRAUD_PHRASES);
const COMPLIANCE_RE = buildMatcher(COMPLIANCE_PHRASES);
const EMPATHY_RE = buildMatcher(EMPATHY_PHRASES);
const BARE_DENIAL_RE = buildMatcher(BARE_DENIAL_TOKENS);

/**
 * Classify one customer turn.
 *
 * Deliberately NOT an LLM call: a second model round-trip inside a live voice
 * turn adds latency to the exact moment the customer is waiting, and an
 * LLM-decided classification would put a probabilistic model on the path that
 * triggers a protective action. The tables are deterministic and auditable,
 * which is what a bank compliance reviewer needs to see.
 *
 * Every table is checked for every turn — see the header for why the declared
 * language does not narrow the search.
 */
export async function routeAgentIntent(text: string): Promise<AgentRole> {
  if (typeof text !== "string" || !text.trim()) return "clarify";
  // Fraud first: a caller reporting unauthorised activity who ALSO mentions
  // their rights is a fraud report, and the protective action is time-critical.
  //
  // Two rungs, in this order:
  //   1. An explicit denial PHRASE. Unambiguous at any utterance length.
  //   2. A bare denial TOKEN, but ONLY when the caller said little else. "No."
  //      after "was this charge yours?" is a denial. "No problem" inside a long
  //      sentence is not, and freezing a card on it would be an irreversible
  //      action taken with no fraud report behind it.
  if (FRAUD_RE.test(text)) return "fraud_specialist";
  if (isShortAnswer(text) && BARE_DENIAL_RE.test(text)) return "fraud_specialist";
  if (COMPLIANCE_RE.test(text)) return "compliance_officer";
  if (EMPATHY_RE.test(text)) return "empathy_agent";
  return "clarify";
}

/** Unused-symbol guard: keeps the phrase tables from silently going dead. */
export const ROUTER_PHRASE_COUNTS = {
  fraud: FRAUD_PHRASES.length,
  compliance: COMPLIANCE_PHRASES.length,
  empathy: EMPATHY_PHRASES.length,
} as const;

export function getSpecialistPrompt(role: AgentRole, context: Record<string, unknown>): string {
  // Scope note for callers: the Shariah terminology filter is NOT applied here.
  // It runs at the send boundary (compliance/speech-gate.ts) so that every voice
  // path passes through one implementation. Applying it to a prompt would also
  // be wrong — rewriting "insurance" inside instructions the model reads can
  // change what the model decides to SAY.
  switch (role) {
    case "fraud_specialist":
      return "You are a fraud specialist. Verify whether the customer recognizes the transaction. If they deny it, mark fraud_confirmed. Never request PIN or OTP.";
    case "compliance_officer":
      return "You are a compliance officer. Explain the customer's rights and the next steps. Do not give legal advice.";
    case "empathy_agent":
      return "You are an empathy agent. De-escalate, reassure, and collect only the information needed for a human specialist. Offer a human handoff early.";
    default:
      return "You are a helpful assistant. Clarify the customer's answer before proceeding.";
  }
}
