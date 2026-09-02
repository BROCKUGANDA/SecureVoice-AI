/**
 * SecureVoice AI — fraud scenario library + simulated call scripts.
 * Bilingual (EN primary / AR mirror). Timings are virtual seconds
 * from call start; the demo player scales them by playback speed.
 *
 * Three triggerable cases so judges can TEST the pipeline, not just
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
  assetLine: string; // stage header mono line
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
    assetLine: "VOICE · FATIMA (AR-GULF) · CARD •• 4417",
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
    assetLine: "VOICE · FATIMA (AR-GULF) · CARD •• 9034",
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
    assetLine: "VOICE · MARCUS (EN) · TRANSFER TRX-99127",
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

interface Pack {
  alert: [string, string];
  dial: [string, string];
  connected: [string, string];
  verify: [string, string];
  verifyAns: [string, string];
  verifyOk: [string, string];
  confirm: [string, string];
  confirmAns: [string, string];
  protect: [string, string];
  apiTag: string;
  api: [string, string];
  done: [string, string];
}

const PACKS: Record<ScenarioKind, Pack> = {
  /* ————————— CARD-NOT-PRESENT ————————— */
  card: {
    alert: [
      "FRAUD SIGNAL RECEIVED — Card •• 4417, AED 2,500.00 at Electronics World, Dubai. Risk score 0.94 (critical). Device mismatch + velocity anomaly detected.",
      "تم استلام إشارة احتيال — البطاقة •• ٤٤١٧، مبلغ ٢,٥٠٠.٠٠ درهم لدى Electronics World، دبي. درجة الخطورة ٠.٩٤ (حرجة). عدم تطابق الجهاز ونمط سرعة غير معتاد.",
    ],
    dial: [
      "Outbound call placed to registered number +971 •• ••• 4567 (Ahmed Al-Rashid). Pre-warmed channel, Gulf Arabic voice profile: Fatima.",
      "اتصال صادر إلى الرقم المسجل +٩٧١ •• ••• ٤٥٦٧ (أحمد الرشيد). صوت عربي خليجي: فاطمة.",
    ],
    connected: [
      "Call connected in 1.2s. Recording enabled. Agent locked to Arabic after first response detected.",
      "تم توصيل المكالمة خلال ١.٢ ثانية. التسجيل مُفعّل. تم تثبيت الوكيل على اللغة العربية.",
    ],
    verify: [
      "Thank you, Ahmed. To verify your identity, please tell me which of these recent transactions you recognize: One — AED 45.50 at Carrefour, September 15. Two — AED 120.00 at Amazon, September 16. Three — AED 2,500.00 at Electronics World, today.",
      "شكراً أحمد. للتحقق من هويتك، أخبرني أي من هذه المعاملات الأخيرة تعرفها: أولاً — ٤٥.٥٠ درهم في كارفور، ١٥ سبتمبر. ثانياً — ١٢٠.٠٠ درهم في أمازون، ١٦ سبتمبر. ثالثاً — ٢,٥٠٠.٠٠ درهم في Electronics World، اليوم.",
    ],
    verifyAns: [
      "The first two are mine. The twenty-five hundred at Electronics World — I did not make that purchase.",
      "أول معاملتين ليّ. أما المبلغ ٢٥٠٠ في Electronics World — أنا لم أقم بهذه العملية.",
    ],
    verifyOk: [
      "Verification passed — 2 of 3 transactions recognized, challenge answered without prompts. Sentiment: mild concern. No PIN or password requested at any point.",
      "نجح التحقق — تم التعرف على معاملتين من ثلاث، دون طلب رمز سري أو كلمة مرور في أي مرحلة.",
    ],
    confirm: [
      "I understand your concern, Ahmed. Let me confirm clearly: you did NOT authorize the AED 2,500.00 transaction at Electronics World — is that correct?",
      "أتفهم قلقك يا أحمد. أؤكد بوضوح: أنت لم تُصرح بعملية ٢,٥٠٠.٠٠ درهم لدى Electronics World — أهذا صحيح؟",
    ],
    confirmAns: ["Correct. That was not me.", "صحيح. هذه العملية ليست مني."],
    protect: [
      "For your protection, I am placing a temporary freeze on your card ending 4417 right now. This blocks any further unauthorized transactions and can be reversed instantly once your account is secured.",
      "من أجل حمايتك، سأضع الآن تجميداً مؤقتاً على بطاقتك المنتهية بـ ٤٤١٧. هذا يمنع أي عمليات غير مصرح بها ويمكن إلغاؤه فوراً بعد تأمين حسابك.",
    ],
    apiTag: "POST /api/v1/cards/••4417/freeze",
    api: [
      "200 OK · 240ms — freeze_type: temporary · reason: fraud_suspicion · agent_id: sv-agent-01 · verification: challenge_pass_2of3",
      "200 OK · ٢٤٠ms — تجميد مؤقت · السبب: اشتباه احتيال · التحقق: نجاح ٢ من ٣",
    ],
    done: [
      "Done — your card is frozen. I'm now connecting you to my colleague Sara, a fraud specialist who will secure your account and arrange your replacement card. Please stay on the line.",
      "تم — بطاقتك مجمّدة الآن. سأحولك الآن إلى زميلتي سارة، أخصائية احتيال، لتأمين حسابك وإصدار بطاقة بديلة. ابقَ على الخط من فضلك.",
    ],
  },

  /* ————————— ATM CASH-OUT ————————— */
  atm: {
    alert: [
      "FRAUD SIGNAL RECEIVED — Card •• 9034, AED 8,000.00 cash withdrawal at ATM · Corniche Street, Abu Dhabi. Risk score 0.97 (critical). Cloned-card pattern: magnetic-skim signature + 3rd attempt in 10 minutes.",
      "تم استلام إشارة احتيال — البطاقة •• ٩٠٣٤، سحب نقدي ٨,٠٠٠.٠٠ درهم من صراف آلي في شارع الكورنيش، أبوظبي. درجة الخطورة ٠.٩٧ (حرجة). نمط بطاقة مستنسخة: ثلاث محاولات خلال عشر دقائق.",
    ],
    dial: [
      "Outbound call placed to registered number +971 •• ••• 7831 (Mariam Haddad). Pre-warmed channel, Gulf Arabic voice profile: Fatima. Card still active — withdrawal in progress.",
      "اتصال صادر إلى الرقم المسجل +٩٧١ •• ••• ٧٨٣١ (مريم حداد). صوت عربي خليجي: فاطمة. البطاقة لا تزال نشطة — عملية السحب جارية.",
    ],
    connected: [
      "Call connected in 1.1s. Recording enabled. Agent locked to Arabic after first response detected.",
      "تم توصيل المكالمة خلال ١.١ ثانية. التسجيل مُفعّل. تم تثبيت الوكيل على اللغة العربية.",
    ],
    verify: [
      "Thank you, Mariam. To verify your identity, please tell me which of these recent transactions you recognize: One — AED 34.00 at Spinneys, September 14. Two — AED 250.00 at ADNOC, September 16. Three — an AED 8,000.00 cash withdrawal on Corniche Street, happening right now.",
      "شكراً مريم. للتحقق من هويتك، أخبريني أي من هذه العمليات الأخيرة تعرفينها: أولاً — ٣٤.٠٠ درهم في سبنيس، ١٤ سبتمبر. ثانياً — ٢٥٠.٠٠ درهم في أدنوك، ١٦ سبتمبر. ثالثاً — سحب نقدي ٨,٠٠٠.٠٠ درهم من شارع الكورنيش، في هذه اللحظة.",
    ],
    verifyAns: [
      "The first two are mine. I am not at any ATM — I am at home in Sharjah. Someone is using my card!",
      "أول عمليتين ليّ. أنا لست عند أي صراف آلي — أنا في بيتي في الشارقة. أحدهم يستخدم بطاقتي!",
    ],
    verifyOk: [
      "Verification passed — 2 of 3 transactions recognized, geo-mismatch corroborated (customer registered in Sharjah). Sentiment: acute distress. Priority escalation enabled. No PIN or password requested at any point.",
      "نجح التحقق — تم التعرف على عمليتين من ثلاث، مع تأكيد عدم تطابق الموقع (العميلة مسجلة في الشارقة). مشاعر: ضيق شديد. تم تمكين التصعيد الفوري. دون طلب رمز سري في أي مرحلة.",
    ],
    confirm: [
      "I believe you, Mariam. Let me confirm clearly: you did NOT authorize the AED 8,000.00 withdrawal at the Corniche Street ATM — is that correct?",
      "أصدقك يا مريم. أؤكد بوضوح: أنتِ لم تُصرحي بسحب ٨,٠٠٠.٠٠ درهم من الصراف في شارع الكورنيش — أهذا صحيح؟",
    ],
    confirmAns: ["Correct. That is not me — please stop it!", "صحيح. هذه العملية ليست مني — أرجوكي أوقفيها!"],
    protect: [
      "I am stopping it right now. I am placing a temporary freeze on your card ending 9034 — the withdrawal will be declined mid-transaction. This is reversible instantly once your new card arrives.",
      "سأوقفها الآن. سأضع تجميداً مؤقتاً على بطاقتك المنتهية بـ ٩٠٣٤ — سيُرفض السحب أثناء العملية. ويمكن إلغاء التجميد فوراً عند وصول بطاقتك الجديدة.",
    ],
    apiTag: "POST /api/v1/cards/••9034/freeze",
    api: [
      "200 OK · 210ms — freeze_type: temporary · reason: cloned_card_cashout · agent_id: sv-agent-01 · verification: challenge_pass_2of3 + geo_mismatch",
      "200 OK · ٢١٠ms — تجميد مؤقت · السبب: بطاقة مستنسخة · التحقق: نجاح ٢ من ٣ مع عدم تطابق الموقع",
    ],
    done: [
      "Done — the withdrawal was declined and your card is frozen. I'm now connecting you to my colleague Sara, a fraud specialist who will secure your account and issue your replacement card. Please stay on the line.",
      "تم — رُفضت عملية السحب وبطاقتك مجمّدة الآن. سأحولك إلى زميلتي سارة، أخصائية احتيال، لتأمين حسابك وإصدار بطاقة بديلة. ابقي على الخط من فضلك.",
    ],
  },

  /* ————————— IMPERSONATION WIRE SCAM ————————— */
  wire: {
    alert: [
      "FRAUD SIGNAL RECEIVED — Outbound transfer AED 48,000.00 to new payee M. TRADING LLC, pending authorization. Risk score 0.99 (critical). Payee flagged as known mule account; concurrent social-engineering pattern on recent calls.",
      "تم استلام إشارة احتيال — حوالة صادرة بمبلغ ٤٨,٠٠٠.٠٠ درهم إلى مستفيد جديد M. TRADING LLC، بانتظار التفويض. درجة الخطورة ٠.٩٩ (حرجة). المستفيد مدرج كحساب غسيل معروف، مع نمط انتحال شخصية في مكالمات حديثة.",
    ],
    dial: [
      "Outbound call placed to registered number +971 •• ••• 2210 (Khalid Al-Mansoori). Pre-warmed channel, English voice profile: Marcus. Customer is currently on another line — suspected scammer call.",
      "اتصال صادر إلى الرقم المسجل +٩٧١ •• ••• ٢٢١٠ (خالد المنصوري). صوت إنجليزي: ماركوس. العميل متصل حالياً بخط آخر — يُشتبه أنه خط المحتال.",
    ],
    connected: [
      "Call connected in 1.0s. Call-waiting interrupt applied. Recording enabled. Agent locked to English after first response detected.",
      "تم توصيل المكالمة خلال ١.٠ ثانية مع مقاطعة انتظار الاتصال. التسجيل مُفعّل. تم تثبيت الوكيل على اللغة الإنجليزية.",
    ],
    verify: [
      "Thank you, Khalid. To verify your identity, please tell me which of these recent account activities you recognize: One — AED 210.00 at Talabat, September 15. Two — your rent payment of AED 5,500.00, September 1. Three — a new payee, M. TRADING LLC, for AED 48,000.00, awaiting your approval right now.",
      "شكراً خالد. للتحقق من هويتك، أخبرني أي من هذه العمليات الأخيرة تعرفها: أولاً — ٢١٠.٠٠ درهم في طلبات، ١٥ سبتمبر. ثانياً — دفع إيجار ٥,٥٠٠.٠٠ درهم، ١ سبتمبر. ثالثاً — مستفيد جديد M. TRADING LLC بمبلغ ٤٨,٠٠٠.٠٠ درهم بانتظار موافقتك الآن.",
    ],
    verifyAns: [
      "The first two are mine. The transfer — a man from my bank's security team told me to move my savings to a safe account. Is that not you?",
      "أول عمليتين ليّ. أما الحوالة — فرجل من فريق الأمان في مصرفي طلب مني نقل مدخراتي إلى حساب آمن. ألستم أنتم؟",
    ],
    verifyOk: [
      "Verification passed — 2 of 3 items recognized. Live impersonation scam confirmed: the “bank security team” is not the bank. No PIN or password requested at any point.",
      "نجح التحقق — تم التعرف على بُضعتين من ثلاث. تأكد انتحال شخصية حي: «فريق الأمان» ليس المصرف. دون طلب رمز سري في أي مرحلة.",
    ],
    confirm: [
      "Khalid, listen carefully: that call was not your bank. Your bank will NEVER ask you to move money to a safe account. Let me confirm: you did NOT authorize the AED 48,000.00 transfer to M. TRADING LLC — correct?",
      "يا خالد، استمع جيداً: تلك المكالمة لم تكن من مصرفك. مصرفك لن يطلب منك أبداً نقل أموالك إلى حساب آمن. أؤكد: أنت لم تُصرح بحوالة ٤٨,٠٠٠.٠٠ درهم إلى M. TRADING LLC — أهذا صحيح؟",
    ],
    confirmAns: [
      "Correct. I never authorized it. Thank God you called.",
      "صحيح. لم أُصرح بها أبداً. الحمد لله أنتم اتصلتم.",
    ],
    protect: [
      "For your protection, I am placing an immediate hold on the AED 48,000.00 transfer — the money never leaves your account. I am also blocking the new payee. Both actions are fully logged and reversible by our fraud team.",
      "من أجل حمايتك، سأضع الآن حجزاً فورياً على حوالة ٤٨,٠٠٠.٠٠ درهم — لن يخرج المبلغ من حسابك، وسأحظر المستفيد الجديد أيضاً. كلا الإجراءين مسجل ويمكن لفريق الاحتيال إلغاؤهما.",
    ],
    apiTag: "POST /api/v1/transfers/TRX-99127/hold",
    api: [
      "200 OK · 260ms — hold_type: transfer_hold · reason: social_engineering · payee_status: blocked · agent_id: sv-agent-01 · verification: challenge_pass_2of3",
      "200 OK · ٢٦٠ms — حجز حوالة · السبب: انتحال شخصية · المستفيد: محظور · التحقق: نجاح ٢ من ٣",
    ],
    done: [
      "Done — the transfer is held and your money is safe. I'm now connecting you to my colleague Sara, a fraud specialist who will secure your account and file the report. Please stay on the line.",
      "تم — الحوالة محجوزة وأموالك آمنة. سأحولك إلى زميلتي سارة، أخصائية احتيال، لتأمين حسابك وتقديم التقرير. ابقَ على الخط من فضلك.",
    ],
  },
};

/** Build the full 17-event bilingual call script for a given fraud case. */
export function buildScenario(kind: ScenarioKind): ScenarioEvent[] {
  const m = SCENARIO_LIBRARY.find((s) => s.kind === kind)!;
  const p = PACKS[kind];
  const first = m.customer.split(" ")[0];

  return [
    // — 0 · FRAUD SIGNAL —
    { id: "e01", t: 0, phase: "alert", speaker: "system", tag: "webhook · POST /fraud/alerts", en: p.alert[0], ar: p.alert[1] },
    {
      id: "e02",
      t: 2,
      phase: "alert",
      speaker: "system",
      tag: "event queue · P1",
      en: "Alert validated and enriched. Queued with priority P1 — SLA to customer contact: 60 seconds.",
      ar: "تم التحقق من التنبيه وإثراؤه. أُضيف إلى قائمة الانتظار بأولوية P1 — المهلة الزمنية للاتصال بالعميل: ٦٠ ثانية.",
    },

    // — 1 · OUTBOUND CALL —
    { id: "e03", t: 4, phase: "dial", speaker: "system", tag: "telephony · twilio", en: p.dial[0], ar: p.dial[1] },
    { id: "e04", t: 6, phase: "dial", speaker: "system", tag: "status", en: p.connected[0], ar: p.connected[1] },

    // — 2 · INTRODUCTION —
    {
      id: "e05",
      t: 9,
      phase: "intro",
      speaker: "agent",
      en: `Hello, this is your bank's AI security assistant calling about recent activity on your account. This call is recorded to protect your account. Am I speaking with ${m.customer}?`,
      ar: `مرحباً، أنا مساعد الأمان الذكي في مصرفك، أتصل بخصوص نشاط حديث على حسابك. هذه المكالمة مسجلة لحماية حسابك. هل أتحدث مع ${first}؟`,
    },
    {
      id: "e06",
      t: 15,
      phase: "intro",
      speaker: "customer",
      en: `Yes, this is ${first} speaking.`,
      ar: `نعم، أنا ${first}.`,
    },

    // — 3 · VERIFICATION —
    { id: "e07", t: 18, phase: "verify", speaker: "agent", en: p.verify[0], ar: p.verify[1] },
    { id: "e08", t: 28, phase: "verify", speaker: "customer", en: p.verifyAns[0], ar: p.verifyAns[1] },
    { id: "e09", t: 33, phase: "verify", speaker: "system", tag: "scribe v2 · stt", en: p.verifyOk[0], ar: p.verifyOk[1] },

    // — 4 · FRAUD CONFIRMATION —
    { id: "e10", t: 36, phase: "confirm", speaker: "agent", en: p.confirm[0], ar: p.confirm[1] },
    { id: "e11", t: 42, phase: "confirm", speaker: "customer", en: p.confirmAns[0], ar: p.confirmAns[1] },

    // — 5 · PROTECTIVE ACTION —
    { id: "e12", t: 45, phase: "action", speaker: "agent", en: p.protect[0], ar: p.protect[1] },
    { id: "e13", t: 50, phase: "action", speaker: "api", tag: p.apiTag, en: p.api[0], ar: p.api[1] },
    { id: "e14", t: 53, phase: "action", speaker: "agent", en: p.done[0], ar: p.done[1] },

    // — 6 · HUMAN HANDOFF —
    {
      id: "e15",
      t: 58,
      phase: "handoff",
      speaker: "system",
      tag: "transfer · priority",
      en: `Warm transfer to human specialist (Sara H.) — full context passed: verification status, confirmed fraud event, action confirmation, sentiment flags. Case ${m.caseId} created.`,
      ar: `تحويل مباشر إلى الأخصائية (سارة ح.) — تم تمرير السياق الكامل: حالة التحقق، تأكيد الاحتيال، تنفيذ الإجراء. تم إنشاء حالة ${m.caseId}.`,
    },
    {
      id: "e16",
      t: 62,
      phase: "handoff",
      speaker: "system",
      tag: "audit · immutable",
      en: "Audit log sealed — call recording, bilingual transcript, verification method, and action timestamp written to immutable storage (AES-256).",
      ar: "تم إقفال سجل التدقيق — تسجيل المكالمة، النص ثنائي اللغة، طريقة التحقق، وختم الإجراء مخزنة بتشفير AES-256.",
    },
    {
      id: "e17",
      t: 66,
      phase: "handoff",
      speaker: "system",
      tag: "outcome",
      en: `RESOLVED — Fraud signal to protective action in 61 seconds. Estimated prevented loss: ${m.preventedLoss.en}. Old way: 38 minutes. This call: 61 seconds.`,
      ar: `تم الحل — من إشارة الاحتيال إلى إجراء الحماية خلال ٦١ ثانية. الخسارة المتوقعة التي تم منعها: ${m.preventedLoss.ar}.`,
    },
  ];
}

export const SCENARIO_TOTAL = 70; // virtual seconds (same timing grid for every case)
