/**
 * One home for the question every outbound credential guard asks:
 *
 *   is this sentence ASKING the customer for a secret, or WARNING them about it?
 *
 * Three modules used to answer it independently — `auditAgentReply` in
 * src/lib/compliance/policy.ts, `spokenOutputIsSafe` in src/lib/llm-guard.ts, and
 * the caller-direction detector in src/lib/compliance/never-ask.ts — and the two
 * agent-direction copies had already drifted: one refused "Never share your PIN
 * with anyone", the other did not; one knew what a card expiry request sounded
 * like, the other did not know the word. A guard whose rules live in two places is
 * two guards, and they disagree in production.
 *
 * WHAT THIS IS NOT: a detector for the customer asking the agent. That is
 * `callerRequestsSecret` in never-ask.ts, and it is deliberately separate — the
 * two directions need opposite responses (a refusal line versus a safe draft) and
 * merging them is how one direction's false positive starts silencing the other.
 *
 * THE TRADE-OFF, stated because it is a choice and not an oversight: a sentence
 * containing any negation is read as a warning, so "Please tell me your PIN, I
 * will not need anything else" gets through. The asymmetry justifies it. A missed
 * ask is still caught twice downstream — the agent's policy text forbids asking,
 * and a freeze is only ever STAGED for a human to commit, so nothing an agent can
 * say mutates an account. A false refusal is customer-facing and immediate: the
 * reassuring sentence is thrown away mid-call and replaced by a canned line, which
 * is how a fraud intervention comes to sound like the scam it is calling about.
 */

/**
 * Secret shapes. `card expiry` is here because expiry + number + CVV is everything
 * needed to use a card, and a caller who already has two of the three asks for the
 * third — which is exactly the request an older deny list in policy.ts named, and
 * which the live patterns had silently dropped.
 */
const CREDENTIAL_TERMS =
  "pins?|otps?|passcodes?|passwords?|passphrases?|\\bpwds?\\b|cvv2?|cvc2?|2fa|mfa\\s+code|" +
  "one[-\\s]?time\\s+(?:code|password|passcode)|verification\\s+codes?|security\\s+codes?|" +
  "card\\s+verification|full\\s+(?:card|pan)(?:\\s+number)?|(?:card|pan)\\s+number|" +
  "16[-\\s]?digit|\\d{1,2}[-\\s]digit\\s+number|read\\s+(?:me|out)\\s+the\\s+number|" +
  "expiry(?:\\s+date)?|expiration\\s+date";

/** A verb that puts the asking on the agent. */
const REQUEST_CUES =
  "\\b(?:please|give|send|tell|read|share|provide|enter|type|confirm|verify|repeat|state|" +
  "ask(?:ing)?\\s+for|need|want|require|key\\s+in|input|what(?:'s|\\s+is))\\b";

/**
 * NON-LATIN-SCRIPT BLIND SPOT, stated rather than implied. The verbs above are
 * English, so an Arabic- or Hindi-script extraction request ("أرسل الرقم السري")
 * is not caught even though the noun lists in never-ask.ts reach those languages.
 * A Gulf caller who code-switches mid-sentence ("please send الـPIN") IS caught,
 * because the Latin cue and the Latin noun both appear. Full parity needs the
 * agent's policy text reviewed by a native speaker per language and a cue list
 * written from that review — not a regex bolted onto this file, which would trade
 * a known gap for an unknown false-positive rate in a language nobody here reads.
 */

/**
 * Negation tokens. Their presence anywhere in a sentence makes that sentence
 * advice rather than a request — see the trade-off at the top of this file.
 *
 * "only" is deliberately NOT in here. "We only need your OTP" is a solicitation,
 * and a word that appears in both an ask and a warning is not a negation.
 */
const NEGATION_CUES =
  "\\b(?:no|not|never|nobody|nor|without|cannot|neither)\\b|" +
  "\\b(?:don'?t|won'?t|can'?t|isn'?t|aren'?t|doesn'?t)\\b|" +
  "\\bkeep\\s+(?:it|this|your)\\b";

const NEGATION_RE = new RegExp(NEGATION_CUES, "i");

/**
 * How far an asking verb may sit from the secret and still be asking for it. Bound
 * because "share" and "PIN" eight clauses apart in a long turn are not a request;
 * 60 characters is roughly one spoken clause.
 */
const MAX_REQUEST_DISTANCE = 60;

const CREDENTIAL_RE = new RegExp(
  `(${REQUEST_CUES})([^.!?\\n]{0,${MAX_REQUEST_DISTANCE}}?)(${CREDENTIAL_TERMS})`,
  "i",
);

/** Split into sentences on terminal punctuation or a line break. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/);
}

/** True when a sentence warns the customer about a secret instead of asking for it. */
function isWarningSentence(sentence: string): boolean {
  return NEGATION_RE.test(sentence);
}

/**
 * `text` with the warning sentences removed, sentence boundaries preserved.
 *
 * For guards that bring their own solicitation patterns and just need the veto
 * applied per sentence. Boundaries are re-joined with a period rather than a space
 * because those patterns bound the gap between verb and noun with `[^.?!]` — a
 * plain join would let one guard's verb pair with another sentence's noun.
 */
export function warningFreeText(text: string): string {
  return sentences(text)
    .filter((s) => !isWarningSentence(s))
    .join(". ");
}

/**
 * The reply-level question: does any NON-warning sentence in this text ask the
 * customer for a credential?
 *
 * `text` is scanned as-is; callers that normalise whitespace and homoglyphs first
 * (see `spokenOutputIsSafe`) should pass their normalised form so this stays a
 * pure predicate.
 */
export function asksForCredential(text: string): boolean {
  if (!text) return false;
  return sentences(text).some((s) => !isWarningSentence(s) && CREDENTIAL_RE.test(s));
}
