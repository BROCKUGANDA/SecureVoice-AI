/**
 * SecureVoice AI — simulated fraud-intervention call script.
 * Bilingual (EN primary / AR mirror). Timings are virtual seconds
 * from call start; the demo player scales them by playback speed.
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

export const SCENARIO: ScenarioEvent[] = [
  // — 0 · FRAUD SIGNAL —
  {
    id: "e01",
    t: 0,
    phase: "alert",
    speaker: "system",
    tag: "webhook · POST /fraud/alerts",
    en: "FRAUD SIGNAL RECEIVED — Card •• 4417, AED 2,500.00 at Electronics World, Dubai. Risk score 0.94 (critical). Device mismatch + velocity anomaly detected.",
    ar: "تم استلام إشارة احتيال — البطاقة •• ٤٤١٧، مبلغ ٢,٥٠٠.٠٠ درهم لدى Electronics World، دبي. درجة الخطورة ٠.٩٤ (حرجة).",
  },
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
  {
    id: "e03",
    t: 4,
    phase: "dial",
    speaker: "system",
    tag: "telephony · twilio",
    en: "Outbound call placed to registered number +971 •• ••• 4567 (Ahmed Al-Rashid). Pre-warmed channel, Gulf Arabic voice profile: Fatima.",
    ar: "اتصال صادر إلى الرقم المسجل +٩٧١ •• ••• ٤٥٦٧ (أحمد الرشيد). صوت عربي خليجي: فاطمة.",
  },
  {
    id: "e04",
    t: 6,
    phase: "dial",
    speaker: "system",
    tag: "status",
    en: "Call connected in 1.2s. Recording enabled. Agent locked to Arabic after first response detected.",
    ar: "تم توصيل المكالمة خلال ١.٢ ثانية. التسجيل مُفعّل. تم تثبيت الوكيل على اللغة العربية.",
  },

  // — 2 · INTRODUCTION —
  {
    id: "e05",
    t: 9,
    phase: "intro",
    speaker: "agent",
    en: "Hello, this is your bank's AI security assistant calling about recent activity on your account. This call is recorded to protect your account. Am I speaking with Ahmed Al-Rashid?",
    ar: "مرحباً، أنا مساعد الأمان الذكي في مصرفك، أتصل بخصوص نشاط حديث على حسابك. هذه المكالمة مسجلة لحماية حسابك. هل أتحدث مع أحمد الرشيد؟",
  },
  {
    id: "e06",
    t: 15,
    phase: "intro",
    speaker: "customer",
    en: "Yes, this is Ahmed speaking.",
    ar: "نعم، أنا أحمد.",
  },

  // — 3 · VERIFICATION —
  {
    id: "e07",
    t: 18,
    phase: "verify",
    speaker: "agent",
    en: "Thank you, Ahmed. To verify your identity, please tell me which of these recent transactions you recognize: One — AED 45.50 at Carrefour, September 15. Two — AED 120.00 at Amazon, September 16. Three — AED 2,500.00 at Electronics World, today.",
    ar: "شكراً أحمد. للتحقق من هويتك، أخبرني أي من هذه المعاملات الأخيرة تعرفها: أولاً — ٤٥.٥٠ درهم في كارفور، ١٥ سبتمبر. ثانياً — ١٢٠.٠٠ درهم في أمازون، ١٦ سبتمبر. ثالثاً — ٢,٥٠٠.٠٠ درهم في Electronics World، اليوم.",
  },
  {
    id: "e08",
    t: 28,
    phase: "verify",
    speaker: "customer",
    en: "The first two are mine. The twenty-five hundred at Electronics World — I did not make that purchase.",
    ar: "أول معاملتين ليّ. أما المبلغ ٢٥٠٠ في Electronics World — أنا لم أقم بهذه العملية.",
  },
  {
    id: "e09",
    t: 33,
    phase: "verify",
    speaker: "system",
    tag: "scribe v2 · stt",
    en: "Verification passed — 2 of 3 transactions recognized, challenge answered without prompts. Sentiment: mild concern. No PIN or password requested at any point.",
    ar: "نجح التحقق — تم التعرف على معاملتين من ثلاث، دون طلب رمز سري أو كلمة مرور في أي مرحلة.",
  },

  // — 4 · FRAUD CONFIRMATION —
  {
    id: "e10",
    t: 36,
    phase: "confirm",
    speaker: "agent",
    en: "I understand your concern, Ahmed. Let me confirm clearly: you did NOT authorize the AED 2,500.00 transaction at Electronics World — is that correct?",
    ar: "أتفهم قلقك يا أحمد. أؤكد بوضوح: أنت لم تُصرح بعملية ٢,٥٠٠.٠٠ درهم لدى Electronics World — أهذا صحيح؟",
  },
  {
    id: "e11",
    t: 42,
    phase: "confirm",
    speaker: "customer",
    en: "Correct. That was not me.",
    ar: "صحيح. هذه العملية ليست مني.",
  },

  // — 5 · PROTECTIVE ACTION —
  {
    id: "e12",
    t: 45,
    phase: "action",
    speaker: "agent",
    en: "For your protection, I am placing a temporary freeze on your card ending 4417 right now. This blocks any further unauthorized transactions and can be reversed instantly once your account is secured.",
    ar: "من أجل حمايتك، سأضع الآن تجميداً مؤقتاً على بطاقتك المنتهية بـ ٤٤١٧. هذا يمنع أي عمليات غير مصرح بها ويمكن إلغاؤه فوراً بعد تأمين حسابك.",
  },
  {
    id: "e13",
    t: 50,
    phase: "action",
    speaker: "api",
    tag: "POST /api/v1/cards/••4417/freeze",
    en: "200 OK · 240ms — freeze_type: temporary · reason: fraud_suspicion · agent_id: sv-agent-01 · verification: challenge_pass_2of3",
    ar: "200 OK · ٢٤٠ms — تجميد مؤقت · السبب: اشتباه احتيال · التحقق: نجاح ٢ من ٣",
  },
  {
    id: "e14",
    t: 53,
    phase: "action",
    speaker: "agent",
    en: "Done — your card is frozen. I'm now connecting you to my colleague Sara, a fraud specialist who will secure your account and arrange your replacement card. Please stay on the line.",
    ar: "تم — بطاقتك مجمّدة الآن. سأحولك الآن إلى زميلتي سارة، أخصائية احتيال، لتأمين حسابك وإصدار بطاقة بديلة. ابقَ على الخط من فضلك.",
  },

  // — 6 · HUMAN HANDOFF —
  {
    id: "e15",
    t: 58,
    phase: "handoff",
    speaker: "system",
    tag: "transfer · priority",
    en: "Warm transfer to human specialist (Sara H.) — full context passed: verification status, confirmed fraud event, freeze confirmation, sentiment flags. Case FRAUD-2026-08612 created.",
    ar: "تحويل مباشر إلى الأخصائية (سارة ح.) — تم تمرير السياق الكامل: حالة التحقق، تأكيد الاحتيال، التجميد. تم إنشاء حالة FRAUD-2026-08612.",
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
    en: "RESOLVED — Fraud signal to protective action in 61 seconds. Estimated prevented loss: AED 2,500. Old way: 38 minutes. This call: 61 seconds.",
    ar: "تم الحل — من إشارة الاحتيال إلى إجراء الحماية خلال ٦١ ثانية. الخسارة المتوقعة التي تم منعها: ٢,٥٠٠ درهم.",
  },
];

export const SCENARIO_TOTAL = 70; // virtual seconds
