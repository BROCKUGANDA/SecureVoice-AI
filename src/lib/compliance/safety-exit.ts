/**
 * The hang-up-safe exit — the sentence a fraudster can never afford to say.
 *
 * This is the single most valuable line the product speaks, and it exists for a
 * structural reason rather than a presentational one. Vishing works by removing
 * the victim's second channel: the call keeps them on the line, confused, and
 * away from a bank branch or a family member who would say "that is not us". A
 * bank that volunteers "hang up and call us" is giving away the exact leverage
 * the attack depends on. **A fraudster cannot afford to say it**, which makes it
 * a trust signal that is expensive to fake — and expense is what makes a signal
 * worth trusting.
 *
 * Two properties are load-bearing, so they are enforced rather than documented:
 *
 *  1. **It is always spoken.** `prepareSpeech` treats a present safety exit as
 *     protected text and will trim the rest of the reply rather than the exit.
 *     The speech gate's word cap previously cut replies at the clause boundary,
 *     which silently deleted the trailing sentence whenever a reply was long —
 *     i.e. exactly when the reassurance mattered most.
 *  2. **It is never fabricated at call time.** These are per-language constants,
 *     written rather than generated. An LLM paraphrase of "hang up and call the
 *     number on your card" is a paraphrase of the most important sentence in the
 *     product, and the one place where a dropped clause is catastrophic.
 *
 * The "stays valid for 30 minutes" clause is not decoration: it tells the
 * customer that hanging up costs them nothing, which is precisely what stops them
 * from staying on a call they do not trust.
 */

export type SafetyLang = "en" | "ar" | "hi" | "ur" | "fr" | "sw";

/**
 * Per-language exit line. Kept to roughly 20–28 words so it survives the 30-word
 * spoken cap on its own, and so it can be appended to a reply that is already
 * near the limit.
 */
export const SAFETY_EXIT: Record<SafetyLang, string> = {
  en: "You may hang up now and call your bank's official number from the back of your card. This verification stays valid for thirty minutes.",
  ar: "يمكنك إنهاء المكالمة الآن والاتصال بالرقم الرسمي لمصرفك الموجود خلف بطاقتك. يبقى هذا التحقق سارياً لمدة ثلاثين دقيقة.",
  hi: "आप अभी कॉल काट सकते हैं और कार्ड के पीछे दिए गए अपने बैंक के आधिकारिक नंबर पर कॉल कर सकते हैं। यह सत्यापन तीस मिनट तक मान्य रहेगा।",
  ur: "آپ ابھی کال کاٹ کر کارڈ کے پیچھے دیے گئے اپنے بینک کے سرکاری نمبر پر کال کر سکتے ہیں۔ یہ تصدیق تیس منٹ تک درست رہے گی۔",
  fr: "Vous pouvez raccrocher maintenant et appeler le numéro officiel de votre banque au dos de votre carte. Cette vérification reste valable trente minutes.",
  sw: "Unaweza kukatika simu sasa na kupiga namba rasmi ya benki yako iliyo nyuma ya kadi yako. Uthibitisho huu utabaki wa muda dakika thelathini.",
};

/** Stable id used in audit rows, so an operator can prove the line was spoken. */
export const SAFETY_EXIT_ID = "hang_up_safe_exit";

/**
 * Does this text already carry the exit?
 *
 * Matched on a MULTILINGUAL signal set rather than one English template. The
 * sentence is spoken in six languages and each of them has its own verb for
 * hanging up, so an English-only matcher silently stopped protecting every
 * non-English caller — which, in a UAE deployment, is most of them.
 *
 * Two signals are required together: a "stop the call" instruction and a
 * "reach the bank another way" instruction. Requiring both is what keeps the
 * detection honest — "hang up" alone appears in the platform's `doubt` reply,
 * which does offer the same exit, and "call the number" alone appears in copy
 * that does not.
 *
 * The bias is deliberate: a false negative costs a duplicated sentence, while a
 * false positive costs a missing one, so extra matches are preferable.
 */
export function hasSafetyExit(text: string): boolean {
  const raw = text ?? "";
  if (!raw.trim()) return false;
  const t = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;

  // No `\b` fence on the non-English forms. `\b` is defined over ASCII word
  // characters, so `\bkatika simu` never matches inside "kukatika simu" — the
  // Swahili line would silently stop being detected. These forms are specific
  // enough not to need it.
  const HANG_UP =
    /(?:hang\s*up|raccrochez|raccrocher|ponte\s*fin|lac\w*\s*simu|cortar\s*a\s*chamada|katika\s*simu)/u.test(
      t,
    ) ||
    /(?:أنهِ|إنهاء|انه)\s*المكالمة/u.test(raw) ||
    /(?:कॉल\s*काट|कॉल\W*काट)/u.test(raw) ||
    /(?:کال\s*کاٹ)/u.test(raw);

  const REACH_US =
    /(?:official\s+number|number\s+on\s+the\s+back|back\s+of\s+your\s+card|num[eé]ro\s+officiel|au\s+dos\s+de\s+votre\s*carte|namba\s+rasmi|nyuma\s+ya\s+kadi)/u.test(
      t,
    ) ||
    /(?:الرقم\s*(?:الرسمي|المطبوع))/u.test(raw) ||
    /(?:कार्ड\s*के\s*पीछे)/u.test(raw) ||
    /(?:کارڈ\s*کے\s*پیچھے)/u.test(raw);

  return HANG_UP && REACH_US;
}
