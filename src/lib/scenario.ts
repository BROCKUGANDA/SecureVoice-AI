/**
 * SecureVoice AI — fraud scenario library + simulated call scripts.
 * Trilingual call delivery (EN / AR / HI) — the language selector represents
 * the language the AGENT speaks on the call:
 *   en → Marcus (EN-UK) · ar → Fatima (AR-Gulf) · hi → Kavita (HI-IN)
 * Timings are virtual seconds from call start; the demo player scales them.
 *
 * Three triggerable cases so any visitor can TEST the pipeline, not just
 * watch one canned playback:
 *   card — card-not-present retail fraud (Dubai, device mismatch)
 *   atm  — cloned-card ATM cash-out (Abu Dhabi, geo mismatch)
 *   wire — social-engineering wire scam (fake "bank security team")
 */

export type Phase =
  | "alert"
  | "dial"
  | "intro"
  | "verify"
  | "confirm"
  | "action"
  | "handoff";

export type CallLang = "en" | "ar" | "hi";

export const VOICE_BY_LANG: Record<CallLang, string> = {
  en: "MARCUS (EN-UK)",
  ar: "FATIMA (AR-GULF)",
  hi: "KAVITA (HI-IN)",
};

export const CALL_LANG_LABEL: Record<CallLang, string> = {
  en: "English",
  ar: "العربية",
  hi: "हिन्दी",
};

export interface PhaseMeta {
  id: Phase;
  n: number;
  en: string;
  ar: string;
}

export const PHASES: PhaseMeta[] = [
  { id: "alert", n: 0, en: "Fraud Signal", ar: "إشارة الاحتيال" },
  { id: "dial", n: 1, en: "Outbound Call", ar: "الاتصال الصادر" },
  { id: "intro", n: 2, en: "Introduction", ar: "التعريف" },
  { id: "verify", n: 3, en: "Verification", ar: "التحقق" },
  { id: "confirm", n: 4, en: "Fraud Confirmation", ar: "تأكيد الاحتيال" },
  { id: "action", n: 5, en: "Protective Action", ar: "إجراء الحماية" },
  { id: "handoff", n: 6, en: "Human Handoff", ar: "التسليم لأخصائي" },
];

export type Speaker = "system" | "agent" | "customer" | "api";

export interface ScenarioEvent {
  id: string;
  t: number; // virtual seconds from start
  phase: Phase;
  speaker: Speaker;
  en: string;
  ar: string;
  hi?: string;
  tag?: string; // mono chip e.g. "webhook", "POST /freeze"
}

export type ScenarioKind = "card" | "atm" | "wire";

export interface ScenarioMeta {
  kind: ScenarioKind;
  title: { en: string; ar: string };
  desc: { en: string; ar: string };
  vector: { en: string; ar: string };
  risk: string;
  amount: { en: string; ar: string };
  merchant: { en: string; ar: string };
  signals: { en: string; ar: string };
  customer: string;
  phone: string;
  assetId: string; // stage header tail, e.g. "CARD •• 4417"
  caseId: string;
  preventedLoss: { en: string; ar: string };
  freezePath: string;
  freezeOk: string[]; // mono response block once executed
}

export const SCENARIO_LIBRARY: ScenarioMeta[] = [
  {
    kind: "card",
    title: { en: "Card-not-present fraud", ar: "احتيال بطاقة" },
    desc: {
      en: "AED 2,500 at a Dubai electronics store — device mismatch + velocity anomaly.",
      ar: "٢,٥٠٠ درهم في متجر إلكترونيات بدبي — عدم تطابق الجهاز ونمط سرعة غير معتاد.",
    },
    vector: { en: "Retail card · CNP", ar: "بطاقة تجزئة" },
    risk: "0.94 · critical",
    amount: { en: "AED 2,500.00", ar: "٢,٥٠٠.٠٠ درهم" },
    merchant: { en: "Electronics World · Dubai", ar: "إلكترونيات وورلد · دبي" },
    signals: { en: "velocity + device mismatch", ar: "سرعة غير معتادة + عدم تطابق الجهاز" },
    customer: "Ahmed Al-Rashid",
    phone: "+971 •• ••• 4567",
    assetId: "CARD •• 4417",
    caseId: "FRAUD-2026-08612",
    preventedLoss: { en: "AED 2,500", ar: "٢,٥٠٠ درهم" },
    freezePath: "POST /api/v1/cards/••4417/freeze",
    freezeOk: [
      "→ 200 OK · 240ms",
      '  freeze_type:  "temporary"',
      '  reason:       "fraud_suspicion"',
      '  agent_id:     "sv-agent-01"',
      '  verification: "challenge_2of3"',
    ],
  },
  {
    kind: "atm",
    title: { en: "ATM cash-out", ar: "سحب من الصراف" },
    desc: {
      en: "Cloned card draining AED 8,000 at an Abu Dhabi ATM — third attempt in 10 minutes.",
      ar: "بطاقة مستنسخة تسحب ٨,٠٠٠ درهم من صراف في أبوظبي — المحاولة الثالثة خلال عشر دقائق.",
    },
    vector: { en: "Cloned card · ATM", ar: "بطاقة مستنسخة" },
    risk: "0.97 · critical",
    amount: { en: "AED 8,000.00", ar: "٨,٠٠٠.٠٠ درهم" },
    merchant: { en: "ATM · Corniche St, Abu Dhabi", ar: "صراف آلي · شارع الكورنيش، أبوظبي" },
    signals: { en: "cloned card · geo mismatch", ar: "بطاقة مستنسخة · عدم تطابق الموقع" },
    customer: "Mariam Haddad",
    phone: "+971 •• ••• 7831",
    assetId: "CARD •• 9034",
    caseId: "FRAUD-2026-08633",
    preventedLoss: { en: "AED 8,000", ar: "٨,٠٠٠ درهم" },
    freezePath: "POST /api/v1/cards/••9034/freeze",
    freezeOk: [
      "→ 200 OK · 210ms",
      '  freeze_type:  "temporary"',
      '  reason:       "cloned_card_cashout"',
      '  agent_id:     "sv-agent-01"',
      '  verification: "challenge_2of3 + geo_mismatch"',
    ],
  },
  {
    kind: "wire",
    title: { en: "Impersonation wire scam", ar: "احتيال انتحال شخصية" },
    desc: {
      en: "A fake “bank security team” tricks a customer into a AED 48,000 transfer — the agent interrupts mid-call.",
      ar: "«فريق أمان» مزيف يخدع العميل لحوالة ٤٨,٠٠٠ درهم — الوكيل يقاطع المكالمة أولاً بأول.",
    },
    vector: { en: "Social engineering · wire", ar: "هندسة اجتماعية · حوالة" },
    risk: "0.99 · critical",
    amount: { en: "AED 48,000.00", ar: "٤٨,٠٠٠.٠٠ درهم" },
    merchant: { en: "M. TRADING LLC · new payee", ar: "M. TRADING LLC · مستفيد جديد" },
    signals: { en: "mule payee + live scam call", ar: "حساب غسيل + مكالمة احتيال حية" },
    customer: "Khalid Al-Mansoori",
    phone: "+971 •• ••• 2210",
    assetId: "TRANSFER TRX-99127",
    caseId: "FRAUD-2026-08647",
    preventedLoss: { en: "AED 48,000", ar: "٤٨,٠٠٠ درهم" },
    freezePath: "POST /api/v1/transfers/TRX-99127/hold",
    freezeOk: [
      "→ 200 OK · 260ms",
      '  hold_type:    "transfer_hold"',
      '  reason:       "social_engineering"',
      '  payee_status: "blocked"',
      '  verification: "challenge_2of3"',
    ],
  },
];

/** [en, ar, hi] — every pack is a self-consistent call in that language. */
interface Pack {
  alert: [string, string, string];
  dial: [string, string, string];
  connected: [string, string, string];
  verify: [string, string, string];
  verifyAns: [string, string, string];
  verifyOk: [string, string, string];
  confirm: [string, string, string];
  confirmAns: [string, string, string];
  protect: [string, string, string];
  apiTag: string;
  api: [string, string, string];
  done: [string, string, string];
}

const PACKS: Record<ScenarioKind, Pack> = {
  /* ————————— CARD-NOT-PRESENT ————————— */
  card: {
    alert: [
      "FRAUD SIGNAL RECEIVED — Card •• 4417, AED 2,500.00 at Electronics World, Dubai. Risk score 0.94 (critical). Device mismatch + velocity anomaly detected.",
      "تم استلام إشارة احتيال — البطاقة •• ٤٤١٧، مبلغ ٢,٥٠٠.٠٠ درهم لدى Electronics World، دبي. درجة الخطورة ٠.٩٤ (حرجة). عدم تطابق الجهاز ونمط سرعة غير معتاد.",
      "धोखाधड़ी का संकेत प्राप्त — कार्ड •• 4417, 2,500.00 दिरहम, Electronics World, दुबई। जोखिम स्कोर 0.94 (अत्यंत गंभीर)। डिवाइस मिसमैच और लेनदेन की असामान्य गति पाई गई।",
    ],
    dial: [
      "Outbound call placed to registered number +971 •• ••• 4567 (Ahmed Al-Rashid). Pre-warmed channel, English voice profile: Marcus.",
      "اتصال صادر إلى الرقم المسجل +٩٧١ •• ••• ٤٥٦٧ (أحمد الرشيد). صوت عربي خليجي: فاطمة.",
      "पंजीकृत नंबर +971 •• ••• 4567 (अहमद अल-रशीद) पर आउटबाउंड कॉल। चैनल पहले से तैयार, हिंदी वॉयस प्रोफ़ाइल: कविता।",
    ],
    connected: [
      "Call connected in 1.2s. Recording enabled. Agent locked to English after first response detected.",
      "تم توصيل المكالمة خلال ١.٢ ثانية. التسجيل مُفعّل. تم تثبيت الوكيل على اللغة العربية.",
      "कॉल 1.2 सेकंड में जुड़ी। रिकॉर्डिंग चालू। पहली प्रतिक्रिया पर एजेंट हिंदी में लॉक हो गया।",
    ],
    verify: [
      "Thank you, Ahmed. To verify your identity, please tell me which of these recent transactions you recognize: One — AED 45.50 at Carrefour, September 15. Two — AED 120.00 at Amazon, September 16. Three — AED 2,500.00 at Electronics World, today.",
      "شكراً أحمد. للتحقق من هويتك، أخبرني أي من هذه المعاملات الأخيرة تعرفها: أولاً — ٤٥.٥٠ درهم في كارفور، ١٥ سبتمبر. ثانياً — ١٢٠.٠٠ درهم في أمازون، ١٦ سبتمبر. ثالثاً — ٢,٥٠٠.٠٠ درهم في Electronics World، اليوم.",
      "धन्यवाद अहमद। अपनी पहचान सत्यापित करने के लिए मुझे बताइए कि इन हालिया लेनदेन में से आप किसे पहचानते हैं: पहला — 45.50 दिरहम, Carrefour, 15 सितंबर। दूसरा — 120.00 दिरहम, Amazon, 16 सितंबर। तीसरा — 2,500.00 दिरहम, Electronics World, आज।",
    ],
    verifyAns: [
      "The first two are mine. The twenty-five hundred at Electronics World — I did not make that purchase.",
      "أول معاملتين ليّ. أما المبلغ ٢٥٠٠ في Electronics World — أنا لم أقم بهذه العملية.",
      "पहले दो मेरे हैं। Electronics World के ढाई हज़ार दिरहम — मैंने वह खरीदारी नहीं की।",
    ],
    verifyOk: [
      "Verification passed — 2 of 3 transactions recognized, challenge answered without prompts. Sentiment: mild concern. No PIN or password requested at any point.",
      "نجح التحقق — تم التعرف على معاملتين من ثلاث، دون طلب رمز سري أو كلمة مرور في أي مرحلة.",
      "सत्यापन सफल — 3 में से 2 लेनदेन पहचाने गए, बिना किसी संकेत के चुनौती पूरी। भावना: हल्की चिंता। कहीं भी PIN या पासवर्ड नहीं माँगा गया।",
    ],
    confirm: [
      "I understand your concern, Ahmed. Let me confirm clearly: you did NOT authorize the AED 2,500.00 transaction at Electronics World — is that correct?",
      "أتفهم قلقك يا أحمد. أؤكد بوضوح: أنت لم تُصرح بعملية ٢,٥٠٠.٠٠ درهم لدى Electronics World — أهذا صحيح؟",
      "मैं आपकी चिंता समझता हूँ, अहमद। एक बार स्पष्ट रूप से पुष्टि करें: Electronics World में 2,500.00 दिरहम का लेनदेन आपने अधिकृत नहीं किया — क्या यह सही है?",
    ],
    confirmAns: [
      "Correct. That was not me.",
      "صحيح. هذه العملية ليست مني.",
      "सही है। वह मैं नहीं था।",
    ],
    protect: [
      "For your protection, I am placing a temporary freeze on your card ending 4417 right now. This blocks any further unauthorized transactions and can be reversed instantly once your account is secured.",
      "من أجل حمايتك، سأضع الآن تجميداً مؤقتاً على بطاقتك المنتهية بـ ٤٤١٧. هذا يمنع أي عمليات غير مصرح بها ويمكن إلغاؤه فوراً بعد تأمين حسابك.",
      "आपकी सुरक्षा के लिए मैं इसी समय आपके कार्ड (4417 पर समाप्त होने वाले) पर अस्थायी फ्रीज़ लगा रहा हूँ। इससे आगे का कोई अनधिकृत लेनदेन नहीं होगा, और खाता सुरक्षित होते ही इसे तुरंत हटाया जा सकता है।",
    ],
    apiTag: "POST /api/v1/cards/••4417/freeze",
    api: [
      "200 OK · 240ms — freeze_type: temporary · reason: fraud_suspicion · agent_id: sv-agent-01 · verification: challenge_pass_2of3",
      "200 OK · ٢٤٠ms — تجميد مؤقت · السبب: اشتباه احتيال · التحقق: نجاح ٢ من ٣",
      "200 OK · 240ms — अस्थायी फ्रीज़ · कारण: धोखाधड़ी का संदेह · सत्यापन: 2/3 सफल",
    ],
    done: [
      "Done — your card is frozen. I'm now connecting you to my colleague Sara, a fraud specialist who will secure your account and arrange your replacement card. Please stay on the line.",
      "تم — بطاقتك مجمّدة الآن. سأحولك الآن إلى زميلتي سارة، أخصائية احتيال، لتأمين حسابك وإصدار بطاقة بديلة. ابقَ على الخط من فضلك.",
      "हो गया — आपका कार्ड फ्रीज़ है। मैं आपको अब मेरी सहकर्मी सारा से जोड़ रहा हूँ — वे फ्रॉड विशेषज्ञ हैं और आपका खाता सुरक्षित करके नया कार्ड व्यवस्थित करेंगी। कृपया लाइन पर बने रहें।",
    ],
  },

  /* ————————— ATM CASH-OUT ————————— */
  atm: {
    alert: [
      "FRAUD SIGNAL RECEIVED — Card •• 9034, AED 8,000.00 cash withdrawal at ATM · Corniche Street, Abu Dhabi. Risk score 0.97 (critical). Cloned-card pattern: magnetic-skim signature + 3rd attempt in 10 minutes.",
      "تم استلام إشارة احتيال — البطاقة •• ٩٠٣٤، سحب نقدي ٨,٠٠٠.٠٠ درهم من صراف آلي في شارع الكورنيش، أبوظبي. درجة الخطورة ٠.٩٧ (حرجة). نمط بطاقة مستنسخة: ثلاث محاولات خلال عشر دقائق.",
      "धोखाधड़ी का संकेत प्राप्त — कार्ड •• 9034, 8,000.00 दिरहम की नकद निकासी, ATM · कॉर्निश स्ट्रीट, अबू धाबी। जोखिम स्कोर 0.97 (अत्यंत गंभीर)। क्लोन कार्ड पैटर्न: 10 मिनट में तीसरी कोशिश।",
    ],
    dial: [
      "Outbound call placed to registered number +971 •• ••• 7831 (Mariam Haddad). Pre-warmed channel, English voice profile: Marcus. Card still active — withdrawal in progress.",
      "اتصال صادر إلى الرقم المسجل +٩٧١ •• ••• ٧٨٣١ (مريم حداد). صوت عربي خليجي: فاطمة. البطاقة لا تزال نشطة — عملية السحب جارية.",
      "पंजीकृत नंबर +971 •• ••• 7831 (मरियम हदाद) पर आउटबाउंड कॉल। हिंदी वॉयस प्रोफ़ाइल: कविता। कार्ड अभी सक्रिय है — निकासी जारी है।",
    ],
    connected: [
      "Call connected in 1.1s. Recording enabled. Agent locked to English after first response detected.",
      "تم توصيل المكالمة خلال ١.١ ثانية. التسجيل مُفعّل. تم تثبيت الوكيل على اللغة العربية.",
      "कॉल 1.1 सेकंड में जुड़ी। रिकॉर्डिंग चालू। एजेंट हिंदी में लॉक हो गया।",
    ],
    verify: [
      "Thank you, Mariam. To verify your identity, please tell me which of these recent transactions you recognize: One — AED 34.00 at Spinneys, September 14. Two — AED 250.00 at ADNOC, September 16. Three — an AED 8,000.00 cash withdrawal on Corniche Street, happening right now.",
      "شكراً مريم. للتحقق من هويتك، أخبريني أي من هذه العمليات الأخيرة تعرفينها: أولاً — ٣٤.٠٠ درهم في سبنيس، ١٤ سبتمبر. ثانياً — ٢٥٠.٠٠ درهم في أدنوك، ١٦ سبتمبر. ثالثاً — سحب نقدي ٨,٠٠٠.٠٠ درهم من شارع الكورنيش، في هذه اللحظة.",
      "धन्यवाद मरियम। अपनी पहचान सत्यापित करने के लिए मुझे बताइए कि इनमें से आप कौन-से लेनदेन पहचानती हैं: पहला — 34.00 दिरहम, Spinneys, 14 सितंबर। दूसरा — 250.00 दिरहम, ADNOC, 16 सितंबर। तीसरा — 8,000.00 दिरहम की नकद निकासी, कॉर्निश स्ट्रीट, इसी समय।",
    ],
    verifyAns: [
      "The first two are mine. I am not at any ATM — I am at home in Sharjah. Someone is using my card!",
      "أول عمليتين ليّ. أنا لست عند أي صراف آلي — أنا في بيتي في الشارقة. أحدهم يستخدم بطاقتي!",
      "पहले दो मेरे हैं। मैं किसी एटीएम पर नहीं हूँ — मैं शारजाह में अपने घर पर हूँ। कोई मेरा कार्ड इस्तेमाल कर रहा है!",
    ],
    verifyOk: [
      "Verification passed — 2 of 3 transactions recognized, geo-mismatch corroborated (customer registered in Sharjah). Sentiment: acute distress. Priority escalation enabled. No PIN or password requested at any point.",
      "نجح التحقق — تم التعرف على عمليتين من ثلاث، مع تأكيد عدم تطابق الموقع (العميلة مسجلة في الشارقة). مشاعر: ضيق شديد. تم تمكين التصعيد الفوري. دون طلب رمز سري في أي مرحلة.",
      "सत्यापन सफल — 3 में से 2 लेनदेन पहचाने गए, जगह की बेमेल की पुष्टि (ग्राहक शारजाह में पंजीकृत)। भावना: तीव्र संकट। प्रायोरिटी एस्केलेशन चालू। कहीं भी PIN या पासवर्ड नहीं माँगा गया।",
    ],
    confirm: [
      "I believe you, Mariam. Let me confirm clearly: you did NOT authorize the AED 8,000.00 withdrawal at the Corniche Street ATM — is that correct?",
      "أصدقك يا مريم. أؤكد بوضوح: أنتِ لم تُصرحي بسحب ٨,٠٠٠.٠٠ درهم من الصراف في شارع الكورنيش — أهذا صحيح؟",
      "मैं आप पर विश्वास करता हूँ, मरियम। स्पष्ट रूप से पुष्टि करें: कॉर्निश स्ट्रीट के एटीएम से 8,000.00 दिरहम की निकासी आपने अधिकृत नहीं की — क्या यह सही है?",
    ],
    confirmAns: [
      "Correct. That is not me — please stop it!",
      "صحيح. هذه العملية ليست مني — أرجوكي أوقفيها!",
      "सही है। वह मैं नहीं हूँ — कृपया उसे रोकिए!",
    ],
    protect: [
      "I am stopping it right now. I am placing a temporary freeze on your card ending 9034 — the withdrawal will be declined mid-transaction. This is reversible instantly once your new card arrives.",
      "سأوقفها الآن. سأضع تجميداً مؤقتاً على بطاقتك المنتهية بـ ٩٠٣٤ — سيُرفض السحب أثناء العملية. ويمكن إلغاء التجميد فوراً عند وصول بطاقتك الجديدة.",
      "मैं इसे अभी रोक रहा हूँ। आपके कार्ड (9034) पर अस्थायी फ्रीज़ लगा रहा हूँ — लेनदेन के बीच में ही निकासी अस्वीकार कर दी जाएगी। नया कार्ड आते ही इसे तुरंत हटाया जा सकता है।",
    ],
    apiTag: "POST /api/v1/cards/••9034/freeze",
    api: [
      "200 OK · 210ms — freeze_type: temporary · reason: cloned_card_cashout · agent_id: sv-agent-01 · verification: challenge_pass_2of3 + geo_mismatch",
      "200 OK · ٢١٠ms — تجميد مؤقت · السبب: بطاقة مستنسخة · التحقق: نجاح ٢ من ٣ مع عدم تطابق الموقع",
      "200 OK · 210ms — अस्थायी फ्रीज़ · कारण: क्लोन कार्ड निकासी · सत्यापन: 2/3 + जगह का मिसमैच",
    ],
    done: [
      "Done — the withdrawal was declined and your card is frozen. I'm now connecting you to my colleague Sara, a fraud specialist who will secure your account and issue your replacement card. Please stay on the line.",
      "تم — رُفضت عملية السحب وبطاقتك مجمّدة الآن. سأحولك إلى زميلتي سارة، أخصائية احتيال، لتأمين حسابك وإصدار بطاقة بديلة. ابقي على الخط من فضلك.",
      "हो गया — निकासी अस्वीकार कर दी गई और आपका कार्ड फ्रीज़ है। मैं आपको फ्रॉड विशेषज्ञ सारा से जोड़ रहा हूँ जो आपका खाता सुरक्षित करके नया कार्ड जारी करेंगी। कृपया लाइन पर बने रहें।",
    ],
  },

  /* ————————— IMPERSONATION WIRE SCAM ————————— */
  wire: {
    alert: [
      "FRAUD SIGNAL RECEIVED — Outbound transfer AED 48,000.00 to new payee M. TRADING LLC, pending authorization. Risk score 0.99 (critical). Payee flagged as known mule account; concurrent social-engineering pattern on recent calls.",
      "تم استلام إشارة احتيال — حوالة صادرة بمبلغ ٤٨,٠٠٠.٠٠ درهم إلى مستفيد جديد M. TRADING LLC، بانتظار التفويض. درجة الخطورة ٠.٩٩ (حرجة). المستفيد مدرج كحساب غسيل معروف، مع نمط انتحال شخصية في مكالمات حديثة.",
      "धोखाधड़ी का संकेत प्राप्त — आउटबाउंड ट्रांसफ़र 48,000.00 दिरहम, नए लाभार्थी M. TRADING LLC को, अधिकृत होने की प्रतीक्षा में। जोखिम स्कोर 0.99 (अत्यंत गंभीर)। लाभार्थी ज्ञात म्यूल खाता; हालिया कॉल्स में सोशल-इंजीनियरिंग पैटर्न।",
    ],
    dial: [
      "Outbound call placed to registered number +971 •• ••• 2210 (Khalid Al-Mansoori). Pre-warmed channel, English voice profile: Marcus. Customer is currently on another line — suspected scammer call.",
      "اتصال صادر إلى الرقم المسجل +٩٧١ •• ••• ٢٢١٠ (خالد المنصوري). صوت إنجليزي: ماركوس. العميل متصل حالياً بخط آخر — يُشتبه أنه خط المحتال.",
      "पंजीकृत नंबर +971 •• ••• 2210 (खालिद अल-मनसूरी) पर आउटबाउंड कॉल। हिंदी वॉयस प्रोफ़ाइल: कविता। ग्राहक इस समय दूसरी लाइन पर है — संदिग्ध ठगी कॉल।",
    ],
    connected: [
      "Call connected in 1.0s. Call-waiting interrupt applied. Recording enabled. Agent locked to English after first response detected.",
      "تم توصيل المكالمة خلال ١.٠ ثانية مع مقاطعة انتظار الاتصال. التسجيل مُفعّل. تم تثبيت الوكيل على اللغة الإنجليزية.",
      "कॉल 1.0 सेकंड में जुड़ी, कॉल-वेटिंग इंटरप्ट लागू। रिकॉर्डिंग चालू। एजेंट हिंदी में लॉक हो गया।",
    ],
    verify: [
      "Thank you, Khalid. To verify your identity, please tell me which of these recent account activities you recognize: One — AED 210.00 at Talabat, September 15. Two — your rent payment of AED 5,500.00, September 1. Three — a new payee, M. TRADING LLC, for AED 48,000.00, awaiting your approval right now.",
      "شكراً خالد. للتحقق من هويتك، أخبرني أي من هذه العمليات الأخيرة تعرفها: أولاً — ٢١٠.٠٠ درهم في طلبات، ١٥ سبتمبر. ثانياً — دفع إيجار ٥,٥٠٠.٠٠ درهم، ١ سبتمبر. ثالثاً — مستفيد جديد M. TRADING LLC بمبلغ ٤٨,٠٠٠.٠٠ درهم بانتظار موافقتك الآن.",
      "धन्यवाद खालिद। अपनी पहचान सत्यापित करने के लिए मुझे बताइए कि इनमें से आप क्या पहचानते हैं: पहला — 210.00 दिरहम, Talabat, 15 सितंबर। दूसरा — किराया 5,500.00 दिरहम, 1 सितंबर। तीसरा — नया लाभार्थी M. TRADING LLC, 48,000.00 दिरहम, अभी आपकी मंज़ूरी की प्रतीक्षा में।",
    ],
    verifyAns: [
      "The first two are mine. The transfer — a man from my bank's security team told me to move my savings to a safe account. Is that not you?",
      "أول عمليتين ليّ. أما الحوالة — فرجل من فريق الأمان في مصرفي طلب مني نقل مدخراتي إلى حساب آمن. ألستم أنتم؟",
      "पहले दो मेरे हैं। ट्रांसफ़र — मेरे बैंक की सिक्योरिटी टीम का एक आदमी बोला कि मेरी बचत सुरक्षित खाते में शिफ्ट करूँ। क्या वह आप ही नहीं थे?",
    ],
    verifyOk: [
      "Verification passed — 2 of 3 items recognized. Live impersonation scam confirmed: the “bank security team” is not the bank. No PIN or password requested at any point.",
      "نجح التحقق — تم التعرف على بُضعتين من ثلاث. تأكد انتحال شخصية حي: «فريق الأمان» ليس المصرف. دون طلب رمز سري في أي مرحلة.",
      "सत्यापन सफल — 3 में से 2 पहचाने गए। लाइव इंपर्सनेशन ठगी की पुष्टि: 'सिक्योरिटी टीम' बैंक नहीं है। कहीं भी PIN या पासवर्ड नहीं माँगा गया।",
    ],
    confirm: [
      "Khalid, listen carefully: that call was not your bank. Your bank will NEVER ask you to move money to a safe account. Let me confirm: you did NOT authorize the AED 48,000.00 transfer to M. TRADING LLC — correct?",
      "يا خالد، استمع جيداً: تلك المكالمة لم تكن من مصرفك. مصرفك لن يطلب منك أبداً نقل أموالك إلى حساب آمن. أؤكد: أنت لم تُصرح بحوالة ٤٨,٠٠٠.٠٠ درهم إلى M. TRADING LLC — أهذا صحيح؟",
      "खालिद, ध्यान से सुनिए: वह कॉल आपके बैंक की नहीं थी। आपका बैंक कभी भी पैसा 'सुरक्षित खाते' में भेजने के लिए नहीं कहेगा। पुष्टि करें: M. TRADING LLC को 48,000.00 दिरहम का ट्रांसफ़र आपने अधिकृत नहीं किया — सही है ना?",
    ],
    confirmAns: [
      "Correct. I never authorized it. Thank God you called.",
      "صحيح. لم أُصرح بها أبداً. الحمد لله أنتم اتصلتم.",
      "सही है। मैंने कभी अधिकृत नहीं किया। भगवान का शुक्र है कि आपने कॉल किया।",
    ],
    protect: [
      "For your protection, I am placing an immediate hold on the AED 48,000.00 transfer — the money never leaves your account. I am also blocking the new payee. Both actions are fully logged and reversible by our fraud team.",
      "من أجل حمايتك، سأضع الآن حجزاً فورياً على حوالة ٤٨,٠٠٠.٠٠ درهم — لن يخرج المبلغ من حسابك، وسأحظر المستفيد الجديد أيضاً. كلا الإجراءين مسجل ويمكن لفريق الاحتيال إلغاؤهما.",
      "आपकी सुरक्षा के लिए मैं 48,000.00 दिरहम के ट्रांसफ़र पर तुरंत रोक लगा रहा हूँ — पैसा आपके खाते से निकलेगा ही नहीं। साथ ही नए लाभार्थी को ब्लॉक कर रहा हूँ। दोनों कार्य लॉग किए गए हैं और फ्रॉड टीम इन्हें रद्द कर सकती है।",
    ],
    apiTag: "POST /api/v1/transfers/TRX-99127/hold",
    api: [
      "200 OK · 260ms — hold_type: transfer_hold · reason: social_engineering · payee_status: blocked · agent_id: sv-agent-01 · verification: challenge_pass_2of3",
      "200 OK · ٢٦٠ms — حجز حوالة · السبب: انتحال شخصية · المستفيد: محظور · التحقق: نجاح ٢ من ٣",
      "200 OK · 260ms — ट्रांसफ़र होल्ड · कारण: सोशल इंजीनियरिंग · लाभार्थी: ब्लॉक · सत्यापन: 2/3",
    ],
    done: [
      "Done — the transfer is held and your money is safe. I'm now connecting you to my colleague Sara, a fraud specialist who will secure your account and file the report. Please stay on the line.",
      "تم — الحوالة محجوزة وأموالك آمنة. سأحولك إلى زميلتي سارة، أخصائية احتيال، لتأمين حسابك وتقديم التقرير. ابقَ على الخط من فضلك.",
      "हो गया — ट्रांसफ़र रोक दिया गया है और आपका पैसा सुरक्षित है। मैं आपको फ्रॉड विशेषज्ञ सारा से जोड़ रहा हूँ जो खाता सुरक्षित करके रिपोर्ट दर्ज करेंगी। कृपया लाइन पर बने रहें।",
    ],
  },
};

/** Build the full 17-event trilingual call script for a given fraud case. */
export function buildScenario(kind: ScenarioKind): ScenarioEvent[] {
  const m = SCENARIO_LIBRARY.find((s) => s.kind === kind)!;
  const p = PACKS[kind];
  const first = m.customer.split(" ")[0];

  return [
    // — 0 · FRAUD SIGNAL —
    { id: "e01", t: 0, phase: "alert", speaker: "system", tag: "webhook · POST /fraud/alerts", en: p.alert[0], ar: p.alert[1], hi: p.alert[2] },
    {
      id: "e02",
      t: 2,
      phase: "alert",
      speaker: "system",
      tag: "event queue · P1",
      en: "Alert validated and enriched. Queued with priority P1 — SLA to customer contact: 60 seconds.",
      ar: "تم التحقق من التنبيه وإثراؤه. أُضيف إلى قائمة الانتظار بأولوية P1 — المهلة الزمنية للاتصال بالعميل: ٦٠ ثانية.",
      hi: "अलर्ट सत्यापित और एनरिच किया गया। प्राथमिकता P1 के साथ कतार में — ग्राहक संपर्क की समय सीमा: 60 सेकंड।",
    },

    // — 1 · OUTBOUND CALL —
    { id: "e03", t: 4, phase: "dial", speaker: "system", tag: "telephony · twilio", en: p.dial[0], ar: p.dial[1], hi: p.dial[2] },
    { id: "e04", t: 6, phase: "dial", speaker: "system", tag: "status", en: p.connected[0], ar: p.connected[1], hi: p.connected[2] },

    // — 2 · INTRODUCTION —
    {
      id: "e05",
      t: 9,
      phase: "intro",
      speaker: "agent",
      en: `Hello, this is your bank's AI security assistant calling about recent activity on your account. This call is recorded to protect your account. Am I speaking with ${m.customer}?`,
      ar: `مرحباً، أنا مساعد الأمان الذكي في مصرفك، أتصل بخصوص نشاط حديث على حسابك. هذه المكالمة مسجلة لحماية حسابك. هل أتحدث مع ${first}؟`,
      hi: `नमस्ते, मैं आपके बैंक का AI सुरक्षा सहायक बोल रहा हूँ — आपके खाते की हालिया गतिविधि के बारे में। आपकी सुरक्षा के लिए यह कॉल रिकॉर्ड हो रही है। क्या मैं ${m.customer} से बात कर रहा हूँ?`,
    },
    {
      id: "e06",
      t: 15,
      phase: "intro",
      speaker: "customer",
      en: `Yes, this is ${first} speaking.`,
      ar: `نعم، أنا ${first}.`,
      hi: `जी, मैं ${first} ही हूँ।`,
    },

    // — 3 · VERIFICATION —
    { id: "e07", t: 18, phase: "verify", speaker: "agent", en: p.verify[0], ar: p.verify[1], hi: p.verify[2] },
    { id: "e08", t: 28, phase: "verify", speaker: "customer", en: p.verifyAns[0], ar: p.verifyAns[1], hi: p.verifyAns[2] },
    { id: "e09", t: 33, phase: "verify", speaker: "system", tag: "scribe v2 · stt", en: p.verifyOk[0], ar: p.verifyOk[1], hi: p.verifyOk[2] },

    // — 4 · FRAUD CONFIRMATION —
    { id: "e10", t: 36, phase: "confirm", speaker: "agent", en: p.confirm[0], ar: p.confirm[1], hi: p.confirm[2] },
    { id: "e11", t: 42, phase: "confirm", speaker: "customer", en: p.confirmAns[0], ar: p.confirmAns[1], hi: p.confirmAns[2] },

    // — 5 · PROTECTIVE ACTION —
    { id: "e12", t: 45, phase: "action", speaker: "agent", en: p.protect[0], ar: p.protect[1], hi: p.protect[2] },
    { id: "e13", t: 50, phase: "action", speaker: "api", tag: p.apiTag, en: p.api[0], ar: p.api[1], hi: p.api[2] },
    { id: "e14", t: 53, phase: "action", speaker: "agent", en: p.done[0], ar: p.done[1], hi: p.done[2] },

    // — 6 · HUMAN HANDOFF —
    {
      id: "e15",
      t: 58,
      phase: "handoff",
      speaker: "system",
      tag: "transfer · priority",
      en: `Warm transfer to human specialist (Sara H.) — full context passed: verification status, confirmed fraud event, action confirmation, sentiment flags. Case ${m.caseId} created.`,
      ar: `تحويل مباشر إلى الأخصائية (سارة ح.) — تم تمرير السياق الكامل: حالة التحقق، تأكيد الاحتيال، تنفيذ الإجراء. تم إنشاء حالة ${m.caseId}.`,
      hi: `मानव विशेषज्ञ (सारा ह.) को वॉर्म ट्रांसफ़र — पूरा संदर्भ साथ: सत्यापन स्थिति, पुष्ट धोखाधड़ी, कार्रवाई की पुष्टि, भावना संकेत। केस ${m.caseId} बनाया गया।`,
    },
    {
      id: "e16",
      t: 62,
      phase: "handoff",
      speaker: "system",
      tag: "audit · immutable",
      en: "Audit log sealed — call recording, full transcript, verification method, and action timestamp written to immutable storage (AES-256).",
      ar: "تم إقفال سجل التدقيق — تسجيل المكالمة، النص الكامل، طريقة التحقق، وختم الإجراء مخزنة بتشفير AES-256.",
      hi: "ऑडिट लॉग सील — कॉल रिकॉर्डिंग, पूरी ट्रांसक्रिप्ट, सत्यापन विधि और कार्रवाई का टाइमस्टैम्प अपरिवर्तनीय स्टोरेज (AES-256) में लिखा गया।",
    },
    {
      id: "e17",
      t: 66,
      phase: "handoff",
      speaker: "system",
      tag: "outcome",
      en: `RESOLVED — Fraud signal to protective action in 61 seconds. Estimated prevented loss: ${m.preventedLoss.en}. Old way: 38 minutes. This call: 61 seconds.`,
      ar: `تم الحل — من إشارة الاحتيال إلى إجراء الحماية خلال ٦١ ثانية. الخسارة المتوقعة التي تم منعها: ${m.preventedLoss.ar}.`,
      hi: `निराकृत — धोखाधड़ी संकेत से सुरक्षात्मक कार्रवाई तक 61 सेकंड। रोकी गई अनुमानित हानि: ${m.preventedLoss.en}।`,
    },
  ];
}

export const SCENARIO_TOTAL = 70; // virtual seconds (same timing grid for every case)
