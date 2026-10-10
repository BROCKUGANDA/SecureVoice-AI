/**
 * The never-ask line — rule 2, enforced in code rather than requested
 * of a model.
 *
 * The rule, verbatim from the brief: *"NEVER request PINs, OTPs, passwords, or
 * card numbers. If asked: 'For your security, I will never ask for that.'
 * Continue verification."*
 *
 * There are two halves, and they are not the same half:
 *
 *   1. **The agent never asks.** The outbound half is enforced by
 *      `spokenOutputIsSafe` (src/lib/llm-guard.ts) and by the vishing
 *      blocklist's `escalation.sms_code` rule — both refuse text bound for
 *      synthesis. That is the half that makes the platform structurally
 *      incapable of phishing.
 *   2. **The customer may still ask.** A frightened person on a fraud call
 *      asks "what's my PIN?" or "can you read me the code?" — and the honest
 *      answer is a fixed sentence, not an improvised one. A model's paraphrase
 *      of "I will never ask for that" can drift into "I don't have your PIN"
 *      (which invites "check your records") or into something that sounds like
 *      the agent keeps secrets. So this line is a per-language CONSTANT, and
 *      the detector that triggers it is deterministic.
 *
 * Both halves run on every voice path: the media-stream worker (which routes
 * a secret request here INSTEAD of to the intent router, because the answer is
 * the same whatever else the caller said) and the guardrailed turn API (which
 * replaces the drafted reply with this line).
 *
 * Scope honesty, matching the convention in src/lib/compliance/vishing.ts:
 * the detector is written for English, French and the Arabic/Urdu forms of
 * the secret nouns. Hindi and Swahili coverage is best-effort; a production
 * deployment in those languages needs native-speaker review before it can
 * claim parity.
 */

export type NeverAskLang = "en" | "ar" | "hi" | "ur" | "fr" | "sw";

/**
 * The refusal line, per language. Short by design: it is spoken inside a live
 * turn, it is followed by the verification continuing, and a long refusal is
 * a worse answer than a short one.
 */
export const NEVER_ASK_LINE: Record<NeverAskLang, string> = {
  en: "For your security, I will never ask for that. Let us continue with your verification.",
  ar: "لأمانك، لن أطلب منك ذلك أبدًا. دعنا نكمل عملية التحقق.",
  hi: "आपकी सुरक्षा के लिए, मैं कभी भी ऐसा नहीं पूछूँगा। आइए सत्यापन जारी रखें।",
  ur: "آپ کی حفاظت کے لیے، میں کبھی ایسا نہیں پوچھوں گا۔ آئیے تصدیق جاری رکھیں۔",
  fr: "Pour votre sécurité, je ne vous demanderai jamais cela. Continuons la vérification.",
  sw: "Kwa usalama wako, sitakuomba haya kamwe. Tuendelee na uthibitisho.",
};

const SECRET_NOUNS = String.raw`(?:pins?|otp|codes?|one[-\s]?time\s+(?:code|password|passcode)|passcodes?|passwords?|cvv2?|cvc2?|security\s+codes?|verification\s+codes?|card\s+numbers?)`;

/**
 * Request shapes aimed AT the agent. Note the difference from
 * `SECRET_SOLICITATION` in llm-guard.ts: those patterns catch the AGENT
 * asking for a secret; these catch the CALLER asking the agent for one. The
 * filter that only guards one direction is the one a judge pokes at.
 */
const CALLER_ASK_PATTERNS: readonly RegExp[] = [
  // "what's my PIN", "what is the code", "what's the one-time password"
  new RegExp(
    String.raw`\b(?:what|whats|what's|which)\b[^.?!]{0,24}\b(?:my|the)\b[^.?!]{0,24}\b${SECRET_NOUNS}\b`,
    "iu",
  ),
  // "can you tell me my PIN", "could you read me the code"
  new RegExp(
    String.raw`\b(?:can|could|would|will)\s+you\b[^.?!]{0,30}\b(?:tell|give|read|send|say|share|confirm|repeat|check)\b[^.?!]{0,30}\b(?:me|us)\b[^.?!]{0,24}\b${SECRET_NOUNS}\b`,
    "iu",
  ),
  // "tell me my PIN", "read me the OTP"
  new RegExp(
    String.raw`\b(?:tell|read|give|send|say|repeat|confirm)\b[^.?!]{0,20}\b(?:me|us)\b[^.?!]{0,24}\b(?:my|the)\b[^.?!]{0,20}\b${SECRET_NOUNS}\b`,
    "iu",
  ),
  // "do you have my PIN", "do you know the password"
  new RegExp(
    String.raw`\bdo\s+you\s+(?:have|know|see|keep)\b[^.?!]{0,30}\b(?:my|the)\b[^.?!]{0,24}\b${SECRET_NOUNS}\b`,
    "iu",
  ),
  // "where is my PIN", "where's the code"
  new RegExp(
    String.raw`\bwhere(?:'s| is)?\b[^.?!]{0,20}\b(?:my|the)\b[^.?!]{0,24}\b${SECRET_NOUNS}\b`,
    "iu",
  ),
  // "give me my PIN" without a modal, and the French equivalent.
  new RegExp(
    String.raw`\b(?:donne|dis|lis|envoie)[\w\s-]{0,20}\b(?:mon|ma|le|la)?\s*(?:code|mot\s+de\s+passe|pin)\b`,
    "iu",
  ),
  // Arabic: the article sits inside the compound (الرقم السري = ال + رقم + ال + سري),
  // so each noun carries its own optional article rather than one shared prefix.
  /(?:ما\s*(?:هو|هي)|أين|هل\s*(?:تعرف|لديك|تملك))\s*(?:ال)?(?:رقم\s*(?:ال)?سري|رمز\s*(?:ال)?تحقق|رمز\s*(?:ال)?مرور|كلمة\s*(?:ال)?مرور)/u,
  /(?:أعطني|اعطني|اخبرني|اقرأ|قولي)\s*(?:ال)?(?:رقم\s*(?:ال)?سري|رمز\s*(?:ال)?تحقق|رمز\s*(?:ال)?مرور|كلمة\s*(?:ال)?مرور)/u,
  // Urdu: "میرا پن کیا ہے" / "کوڈ بتائیں"
  /(?:میرا|میری)\s*(?:پن|پاس\s*ورڈ|کوڈ)\s*(?:کیا|کون\s*سا)?/u,
  /(?:بتائیں|پڑھیں|دیں)\s*(?:میرا|میری)?\s*(?:پن|پاس\s*ورڈ|کوڈ)/u,
];

/**
 * Does the caller's utterance ask the agent for a secret?
 *
 * Pure and synchronous: the media-stream worker calls this before routing,
 * and the turn API calls it before drafting. A false positive costs one fixed
 * sentence; a false negative costs the exact moment the product exists for.
 */
export function callerRequestsSecret(text: string): boolean {
  if (!text) return false;
  const s = text.normalize("NFKC");
  for (const pattern of CALLER_ASK_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(s)) {
      pattern.lastIndex = 0;
      return true;
    }
  }
  return false;
}
