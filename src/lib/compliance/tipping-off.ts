/**
 * FATF "tipping off" guard.
 *
 * Recommendation 20 requires a suspicious-activity report; the same framework
 * forbids telling the customer that one has been or will be filed. For a voice
 * agent that means a sentence like "we have reported this to the police" is a
 * legal offence even when the underlying escalation is correct. The guard is a
 * copy replacement, not a conversational hint: if a reply names a report, the
 * caller hears the approved restriction line instead.
 *
 * Kept separate from `policy.ts` and `speech-gate.ts` because both enforcement
 * points must judge the same bytes. A rule that lives in only one of them is a
 * rule a second voice path can miss.
 */

export type TippingOffLang = "en" | "ar" | "hi" | "ur" | "fr" | "sw";

/** A statement that a report has been, is being, or will be filed. */
const PATTERNS: Record<TippingOffLang, RegExp> = {
  en: /\b(str|suspicious (transaction|activity) report|report(ed|ing)? (it|this|the (case|transaction|matter)) to (the )?(police|authorities|regulator|regulatory body|financial intelligence|fiu)|(?:notif(?:y|ied)|inform(?:ed)?|contact(?:ed)?|alert(?:ed)?) (?:the )?(police|authorities|regulator|financial intelligence|fiu)|(file|filed|filing) (a |the )?(report|str)|police report|financial intelligence unit)\b/i,
  ar: /(تقرير|بلاغ).{0,40}(عملية|نشاط).{0,40}(مشبوه|مشبوهة)|تقرير الاشتباه|\bSTR\b|(إبلاغ|تقديم (بلاغ|تقرير)|رفع (بلاغ|تقرير)).{0,40}(الشرطة|السلطات|الجهات الرقابية|وحدة المعلومات المالية|النيابة)/,
  hi: /(संदिग्ध (लेनदेन|गतिविधि) (रिपोर्ट|रिपोर्टिंग)|\bSTR\b|(रिपोर्ट|सूचना).{0,40}(पुलिस|प्राधिकरण|वित्तीय खुफिया|एफआईयू)|(पुलिस|प्राधिकरण).{0,40}(रिपोर्ट|सूचना))/i,
  ur: /(مشکوک (لین دین|سرگرمی) (رپورٹ|رپورٹنگ)|\bSTR\b|(رپورٹ|اطلاع).{0,40}(پولیس|اتھارٹی|مالیاتی انٹیلیجنس|ایف آئی یو)|(پولیس|اتھارٹی).{0,40}(رپورٹ|اطلاع))/,
  // `police` is also the French word for an insurance policy. The tipping-off
  // sense needs the article or an authority phrase; "votre police" is a policy.
  fr: /\b(rapport|déclaration) (de |d')?(transaction|activité) suspecte|\bSTR\b|(signaler|déclarer|déposer (une )?plainte|rapport).{0,50}(la police|police nationale|police judiciaire|commissariat|autorités|autorité|renseignement financier|fiu)|(la police|autorités).{0,50}(rapport|signalement|plainte)/i,
  sw: /\bripoti ya (muamala|shughuli) (ya )?kutiliwa shaka|\bSTR\b|(kuripoti|ripoti|kufungua kesi).{0,50}(police|polisi|mamlaka|taasisi ya fedha|fiu)|(polisi|mamlaka).{0,50}(ripoti|malalamiko)/i,
};

/** The only thing the customer may hear when the prohibited sentence appears. */
const SAFE: Record<TippingOffLang, string> = {
  en: "Your account has been temporarily restricted to protect your funds. A specialist will follow up with you.",
  ar: "تم تقييد حسابك مؤقتاً لحماية أموالك. سيتواصل معك أخصائي للمتابعة.",
  hi: "आपके धन की सुरक्षा के लिए आपके खाते पर अस्थायी प्रतिबंध लगा दिया गया है। एक विशेषज्ञ आपसे संपर्क करेगा।",
  ur: "آپ کے پیسوں کی حفاظت کے لیے آپ کے اکاؤنٹ پر عارضی پابندی لگا دی گئی ہے۔ ایک ماہر آپ سے رابطہ کرے گا۔",
  fr: "Votre compte a été temporairement restreint pour protéger vos fonds. Un spécialiste vous contactera.",
  sw: "Akaunti yako imezuiwa kwa muda kulinda fedha zako. Mtaalamu atawasiliana nawe.",
};

function asLang(lang?: string): TippingOffLang {
  const key = (lang ?? "").toLowerCase().slice(0, 2);
  return (key in PATTERNS ? key : "en") as TippingOffLang;
}

/**
 * A report the speaker explicitly says they will NOT file is not a disclosure
 * of one. Blocking it would replace a safe denial with a restriction notice.
 */
function isNegatedBefore(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 48), index);
  return /(?:^|\W)(?:not|never|no|without)(?:\W+\w+){0,3}\W*$/i.test(before);
}

function hasUnnegatedMatch(text: string, re: RegExp): boolean {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const match of text.matchAll(global)) {
    if (isNegatedBefore(text, match.index ?? 0)) continue;
    return true;
  }
  return false;
}

/** True when the text tells the customer a report has been or will be filed. */
export function isTippingOff(text: string, lang?: string): boolean {
  return hasUnnegatedMatch(text, PATTERNS[asLang(lang)]);
}

/** The approved replacement, in the language the customer hears. */
export function tippingOffReply(lang?: string): string {
  return SAFE[asLang(lang)];
}
