/**
 * Customer-facing copy for the channels that are NOT a live conversation: the
 * "blind ping" SMS and the voicemail message. Pure - no server imports - so the
 * wording can be unit-tested and reused anywhere.
 *
 * ## The SMS is a BLIND PING
 *
 * It names no merchant and no amount. SMS is unencrypted, sits on lock screens
 * and passes through carrier logs; if the customer's phone is already
 * compromised, a merchant name and amount are exactly what a scammer needs to
 * build a convincing follow-up ("this is your bank about the AED 2,500 at
 * Electronics World..."). The last four digits of the card let the genuine
 * customer recognise the alert without handing anything useful to anyone else.
 *
 * The reply tokens are the English words YES / NO in EVERY language. That is a
 * deliberate contract with the inbound parser (src/lib/sms-verdict.ts): matching
 * Swahili or Urdu free text is exactly where a fraud verdict gets mis-read.
 *
 * ## Review status
 *
 * The ur / fr / sw wording needs a qualified native-speaker review before a
 * production pilot. Nobody on this project has done that yet; this file does not
 * claim otherwise.
 */

import type { InstitutionType } from "@/lib/institution-types";

export type OutreachLang = "en" | "ar" | "hi" | "ur" | "fr" | "sw";

type SmsFn = (ref: string) => string;

/** `ref` is already localised ("ending 4242") or "" when unknown. */
const SMS: Record<InstitutionType, Record<OutreachLang, SmsFn>> = {
  bank: {
    en: (r) =>
      `SecureVoice Alert: suspicious activity on your card${r}. Reply YES if this was you, or NO if it was not. Do not reply with anything else.`,
    ar: (r) =>
      `تنبيه SecureVoice: نشاط مشبوه على بطاقتك${r}. أرسل YES إذا كان هذا أنت، أو NO إذا لم يكن كذلك. لا ترسل أي معلومات أخرى.`,
    hi: (r) =>
      `SecureVoice अलर्ट: आपके कार्ड${r} पर संदिग्ध गतिविधि। यदि यह आप थे तो YES भेजें, यदि नहीं तो NO भेजें। कोई अन्य जानकारी न भेजें।`,
    ur: (r) =>
      `SecureVoice الرٹ: آپ کے کارڈ${r} پر مشکوک سرگرمی۔ اگر یہ آپ تھے تو YES بھیجیں، ورنہ NO بھیجیں۔ کوئی اور معلومات نہ بھیجیں۔`,
    fr: (r) =>
      `Alerte SecureVoice : activité suspecte sur votre carte${r}. Répondez YES si c'était vous, ou NO sinon. N'envoyez aucune autre information.`,
    sw: (r) =>
      `Onyo la SecureVoice: shughuli ya kutiliwa shaka kwenye kadi yako${r}. Jibu YES kama ulifanya, au NO kama hukufanya. Usitume taarifa nyingine yoyote.`,
  },
  insurer: {
    en: (r) =>
      `SecureVoice Alert: suspicious activity on your policy${r}. Reply YES if this was you, or NO if it was not. Do not reply with anything else.`,
    ar: (r) =>
      `تنبيه SecureVoice: نشاط مشبوه على وثيقتك${r}. أرسل YES إذا كان هذا أنت، أو NO إذا لم يكن كذلك. لا ترسل أي معلومات أخرى.`,
    hi: (r) =>
      `SecureVoice अलर्ट: आपकी पॉलिसी${r} पर संदिग्ध गतिविधि। यदि यह आप थे तो YES भेजें, यदि नहीं तो NO भेजें। कोई अन्य जानकारी न भेजें।`,
    ur: (r) =>
      `SecureVoice الرٹ: آپ کی پالیسی${r} پر مشکوک سرگرمی۔ اگر یہ آپ تھے تو YES بھیجیں، ورنہ NO بھیجیں۔ کوئی اور معلومات نہ بھیجیں۔`,
    fr: (r) =>
      `Alerte SecureVoice : activité suspecte sur votre contrat${r}. Répondez YES si c'était vous, ou NO sinon. N'envoyez aucune autre information.`,
    sw: (r) =>
      `Onyo la SecureVoice: shughuli ya kutiliwa shaka kwenye bima yako${r}. Jibu YES kama ulifanya, au NO kama hukufanya. Usitume taarifa nyingine yoyote.`,
  },
};

const ENDING: Record<OutreachLang, (d: string) => string> = {
  en: (d) => ` ending ${d}`,
  ar: (d) => ` المنتهية بـ ${d}`,
  hi: (d) => ` (अंतिम अंक ${d})`,
  ur: (d) => ` (آخری ہندسے ${d})`,
  fr: (d) => ` se terminant par ${d}`,
  sw: (d) => ` inayoishia ${d}`,
};

/**
 * Four digits and nothing else. Anything else is dropped rather than echoed:
 * this value is rendered into an SMS, so it is never interpolated unvalidated.
 */
export function cleanLast4(v: string | null | undefined): string | null {
  return typeof v === "string" && /^\d{4}$/.test(v) ? v : null;
}

/** The blind-ping SMS. No merchant. No amount. Ever. */
export function blindPingSms(
  lang: OutreachLang,
  opts: { last4?: string | null; institution?: InstitutionType } = {},
): string {
  const inst: InstitutionType = opts.institution ?? "bank";
  const l4 = cleanLast4(opts.last4);
  const ref = l4 ? ENDING[lang](l4) : "";
  return SMS[inst][lang](ref);
}

/** What an answering machine hears when the tenant is an insurer. */
export const VOICEMAIL_INSURER: Record<OutreachLang, string> = {
  en: "Hello, this is your insurer's automated AI security assistant. We tried to reach you about recent activity on your policy or claim. If you do not recognise recent activity, please call your insurer now using the number on your policy documents. We will never ask for your PIN, password or one-time passcode. Thank you.",
  ar: "مرحباً، أنا مساعد الأمان الآلي المعتمد على الذكاء الاصطناعي لدى شركة التأمين الخاصة بك. حاولنا الاتصال بك بخصوص نشاط حديث على وثيقتك أو مطالبتك. إذا لم تتعرّف على نشاط حديث، يرجى الاتصال بشركة التأمين الآن على الرقم المدوّن في مستندات وثيقتك. لن نطلب منك أبداً رمز PIN أو كلمة المرور أو رمز التحقق لمرة واحدة. شكراً لك.",
  hi: "नमस्ते, मैं आपकी बीमा कंपनी का स्वचालित AI सुरक्षा सहायक हूं। हमने आपकी पॉलिसी या क्लेम पर हाल की गतिविधि के बारे में आपसे संपर्क करने की कोशिश की। यदि आप हाल की किसी गतिविधि को नहीं पहचानते, तो कृपया अपनी पॉलिसी दस्तावेज़ों में दिए नंबर पर अभी अपनी बीमा कंपनी को कॉल करें। हम कभी आपका PIN, पासवर्ड या वन-टाइम पासकोड नहीं मांगेंगे। धन्यवाद।",
  ur: "ہیلو، میں آپ کی انشورنس کمپنی کا خودکار AI سیکیورٹی اسسٹنٹ ہوں۔ ہم نے آپ کی پالیسی یا کلیم پر حالیہ سرگرمی کے بارے میں آپ سے رابطہ کرنے کی کوشش کی۔ اگر آپ کسی حالیہ سرگرمی کو نہیں پہچانتے تو براہ کرم اپنی پالیسی دستاویزات میں دیے گئے نمبر پر ابھی اپنی انشورنس کمپنی کو کال کریں۔ ہم کبھی آپ سے PIN، پاس ورڈ یا ون ٹائم کوڈ نہیں مانگیں گے۔ شکریہ۔",
  fr: "Bonjour, je suis l'assistant de sécurité automatisé par IA de votre assureur. Nous avons essayé de vous joindre au sujet d'une activité récente sur votre contrat ou votre sinistre. Si vous ne reconnaissez pas une activité récente, veuillez appeler votre assureur dès maintenant au numéro figurant sur vos documents de contrat. Nous ne vous demanderons jamais votre code PIN, votre mot de passe ni votre code à usage unique. Merci.",
  sw: "Habari, mimi ni msaidizi wa usalama wa kiotomatiki wa AI wa kampuni yako ya bima. Tulijaribu kukupigia simu kuhusu shughuli ya hivi karibuni kwenye bima au madai yako. Usipoitambua shughuli ya hivi karibuni, tafadhali piga simu kwa kampuni yako ya bima sasa kwa namba iliyo kwenye nyaraka za bima yako. Hatutakuomba kamwe PIN, nenosiri wala msimbo wa matumizi moja. Asante.",
};

/** Confirmation texts sent back after a valid YES / NO. Still no merchant, no amount. */
export const SMS_REPLY: Record<
  "yes" | "no" | "invalid" | "expired" | "unknown" | "ambiguous",
  Record<OutreachLang, string>
> = {
  yes: {
    en: "Thank you. We have recorded your answer. - SecureVoice",
    ar: "شكراً لك. تم تسجيل إجابتك. - SecureVoice",
    hi: "धन्यवाद। हमने आपका उत्तर दर्ज कर लिया है। - SecureVoice",
    ur: "شکریہ۔ ہم نے آپ کا جواب درج کر لیا ہے۔ - SecureVoice",
    fr: "Merci. Nous avons enregistré votre réponse. - SecureVoice",
    sw: "Asante. Tumerekodi jibu lako. - SecureVoice",
  },
  // Honest about what happens next: a person reviews it. Never "your card is
  // frozen" - the freeze is decided by the institution's human fraud team.
  no: {
    en: "Thank you. We have flagged this as possible fraud and a specialist will review it and contact you. - SecureVoice",
    ar: "شكراً لك. أبلغنا عن هذا كاحتيال محتمل وسيراجعه أخصائي ويتواصل معك. - SecureVoice",
    hi: "धन्यवाद। हमने इसे संभावित धोखाधड़ी के रूप में चिह्नित किया है; एक विशेषज्ञ इसकी समीक्षा करके आपसे संपर्क करेंगे। - SecureVoice",
    ur: "شکریہ۔ ہم نے اسے ممکنہ فراڈ کے طور پر نشان زد کیا ہے؛ ایک ماہر جائزہ لے کر آپ سے رابطہ کرے گا۔ - SecureVoice",
    fr: "Merci. Nous avons signalé une fraude possible ; un spécialiste l'examinera et vous contactera. - SecureVoice",
    sw: "Asante. Tumeweka alama ya udanganyifu unaowezekana; mtaalamu atakagua na kuwasiliana nawe. - SecureVoice",
  },
  invalid: {
    en: "Please reply with only YES or NO.",
    ar: "يرجى الرد بـ YES أو NO فقط.",
    hi: "कृपया केवल YES या NO से उत्तर दें।",
    ur: "براہ کرم صرف YES یا NO سے جواب دیں۔",
    fr: "Veuillez répondre uniquement par YES ou NO.",
    sw: "Tafadhali jibu kwa YES au NO pekee.",
  },
  expired: {
    en: "This alert has expired. Please call your institution using the number on your card or policy documents.",
    ar: "انتهت صلاحية هذا التنبيه. يرجى الاتصال بالجهة على الرقم المدوّن على بطاقتك أو وثيقتك.",
    hi: "यह अलर्ट समाप्त हो चुका है। कृपया अपने कार्ड या पॉलिसी दस्तावेज़ पर दिए नंबर पर संस्था को कॉल करें।",
    ur: "یہ الرٹ ختم ہو چکا ہے۔ براہ کرم اپنے کارڈ یا پالیسی دستاویزات پر دیے گئے نمبر پر ادارے کو کال کریں۔",
    fr: "Cette alerte a expiré. Veuillez appeler votre établissement au numéro figurant sur votre carte ou vos documents.",
    sw: "Tahadhari hii muda wake umeisha. Tafadhali piga simu taasisi yako kwa namba iliyo kwenye kadi au nyaraka zako.",
  },
  unknown: {
    en: "We have no open alert for this number. If you are worried about your account, call the number on your card or policy documents.",
    ar: "لا يوجد تنبيه مفتوح لهذا الرقم. إن كنت قلقاً بشأن حسابك فاتصل بالرقم المدوّن على بطاقتك أو وثيقتك.",
    hi: "इस नंबर के लिए कोई खुला अलर्ट नहीं है। यदि आप चिंतित हैं तो अपने कार्ड या पॉलिसी दस्तावेज़ पर दिए नंबर पर कॉल करें।",
    ur: "اس نمبر کے لیے کوئی کھلا الرٹ نہیں ہے۔ فکر ہو تو اپنے کارڈ یا پالیسی دستاویزات پر دیے گئے نمبر پر کال کریں۔",
    fr: "Aucune alerte ouverte pour ce numéro. En cas de doute, appelez le numéro figurant sur votre carte ou vos documents.",
    sw: "Hakuna tahadhari iliyo wazi kwa namba hii. Ukiwa na wasiwasi, piga simu kwa namba iliyo kwenye kadi au nyaraka zako.",
  },
  // More than one institution has an open alert for this number, so a bare
  // YES / NO could be applied to the wrong one. Fail safe: apply to NONE.
  ambiguous: {
    en: "We cannot match your reply to a single alert. Please call your institution using the number on your card or policy documents.",
    ar: "تعذّر ربط ردّك بتنبيه واحد. يرجى الاتصال بالجهة على الرقم المدوّن على بطاقتك أو وثيقتك.",
    hi: "हम आपके उत्तर को किसी एक अलर्ट से नहीं जोड़ पा रहे हैं। कृपया कार्ड या पॉलिसी दस्तावेज़ पर दिए नंबर पर संस्था को कॉल करें।",
    ur: "ہم آپ کے جواب کو ایک الرٹ سے نہیں جوڑ سکے۔ براہ کرم کارڈ یا پالیسی دستاویزات پر دیے گئے نمبر پر ادارے کو کال کریں۔",
    fr: "Nous ne pouvons pas associer votre réponse à une seule alerte. Appelez votre établissement au numéro figurant sur votre carte ou vos documents.",
    sw: "Hatuwezi kuoanisha jibu lako na tahadhari moja. Tafadhali piga simu taasisi yako kwa namba iliyo kwenye kadi au nyaraka zako.",
  },
};
