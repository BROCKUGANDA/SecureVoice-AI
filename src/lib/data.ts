/**
 * SecureVoice AI — mock operational data for the dashboard.
 * All values consistent with the PRD baseline (Box C) and targets (Box J).
 */

export interface RecentCall {
  id: string;
  customer: string;
  lang: string;
  started: string;
  duration: string;
  trigger: string;
  action: string;
  outcome: "prevented" | "false_alarm" | "handoff" | "no_answer";
  csat: number | null;
}

export const RECENT_CALLS: RecentCall[] = [
  {
    id: "SV-8642",
    customer: "Ahmed Al-Rashid",
    lang: "AR-Gulf",
    started: "14:02:11",
    duration: "1:01",
    trigger: "Risk 0.94 · AED 2,500 · Electronics World",
    action: "Card freeze ••4417",
    outcome: "prevented",
    csat: 4.6,
  },
  {
    id: "SV-8641",
    customer: "Priya Nair",
    lang: "EN",
    started: "13:58:47",
    duration: "0:48",
    trigger: "Risk 0.91 · AED 8,120 · Online FX",
    action: "Card freeze ••7702",
    outcome: "prevented",
    csat: 4.4,
  },
  {
    id: "SV-8640",
    customer: "Mohammed Siddiq",
    lang: "UR",
    started: "13:51:03",
    duration: "2:14",
    trigger: "Risk 0.88 · AED 950 · Telecom top-up x4",
    action: "Freeze + handoff",
    outcome: "handoff",
    csat: 4.1,
  },
  {
    id: "SV-8639",
    customer: "Grace Mwangi",
    lang: "EN",
    started: "13:44:29",
    duration: "0:39",
    trigger: "Risk 0.83 · AED 320 · Grocery abroad",
    action: "None — customer confirmed",
    outcome: "false_alarm",
    csat: 4.8,
  },
  {
    id: "SV-8638",
    customer: "Rashid Al-Mansoori",
    lang: "AR-Gulf",
    started: "13:37:52",
    duration: "0:00",
    trigger: "Risk 0.87 · AED 4,400 · Crypto ramp",
    action: "Retry queued 09:00",
    outcome: "no_answer",
    csat: null,
  },
  {
    id: "SV-8637",
    customer: "Ana Lucia Reyes",
    lang: "TL",
    started: "13:29:14",
    duration: "1:12",
    trigger: "Risk 0.93 · AED 1,750 · Unknown e-commerce",
    action: "Card freeze ••2189",
    outcome: "prevented",
    csat: 4.7,
  },
  {
    id: "SV-8636",
    customer: "Joseph Mathew",
    lang: "ML",
    started: "13:21:40",
    duration: "0:58",
    trigger: "Risk 0.90 · AED 6,000 · Wire transfer",
    action: "Freeze + handoff",
    outcome: "handoff",
    csat: 4.0,
  },
  {
    id: "SV-8635",
    customer: "Omar Haddad",
    lang: "AR",
    started: "13:15:09",
    duration: "0:44",
    trigger: "Risk 0.85 · AED 210 · Subscription retry",
    action: "None — customer confirmed",
    outcome: "false_alarm",
    csat: 4.5,
  },
  {
    id: "SV-8634",
    customer: "Fatima Zahra",
    lang: "AR",
    started: "13:07:33",
    duration: "1:05",
    trigger: "Risk 0.96 · AED 12,300 · Luxury retail",
    action: "Card freeze ••9031",
    outcome: "prevented",
    csat: 4.9,
  },
  {
    id: "SV-8633",
    customer: "Sanjay Kumar",
    lang: "HI",
    started: "12:58:21",
    duration: "0:51",
    trigger: "Risk 0.89 · AED 780 · Gaming platform",
    action: "Card freeze ••5560",
    outcome: "prevented",
    csat: 4.3,
  },
  {
    id: "SV-8632",
    customer: "Mariam Qureshi",
    lang: "EN",
    started: "12:49:58",
    duration: "0:00",
    trigger: "Risk 0.84 · AED 1,100 · Travel booking",
    action: "Retry queued 09:00",
    outcome: "no_answer",
    csat: null,
  },
  {
    id: "SV-8631",
    customer: "Khalid Al-Suwaidi",
    lang: "AR-Gulf",
    started: "12:41:17",
    duration: "1:22",
    trigger: "Risk 0.95 · AED 9,900 · Electronics World",
    action: "Freeze + handoff",
    outcome: "handoff",
    csat: 4.2,
  },
];

export interface AuditEntry {
  ts: string;
  event: string;
  actor: string;
  detail: string;
  hash: string;
}

export const AUDIT_LOG: AuditEntry[] = [
  {
    ts: "14:03:12",
    event: "AUDIT_SEALED",
    actor: "system",
    detail: "Recording + bilingual transcript + metadata written to immutable store (AES-256)",
    hash: "0x8f3a…c21e",
  },
  {
    ts: "14:02:58",
    event: "CASE_CREATED",
    actor: "orchestrator",
    detail: "Case FRAUD-2026-08612 opened, priority P1, assigned to Sara H.",
    hash: "0x71bb…9d04",
  },
  {
    ts: "14:02:56",
    event: "HANDOFF_COMPLETED",
    actor: "telephony",
    detail:
      "Warm transfer to human specialist — context envelope: verification status, sentiment flags",
    hash: "0x44e2…77af",
  },
  {
    ts: "14:02:51",
    event: "CARD_FROZEN",
    actor: "sv-agent-01",
    detail: "POST /cards/••4417/freeze → 200 OK (240ms) · temporary · fraud_suspicion",
    hash: "0x90cd…31b6",
  },
  {
    ts: "14:02:45",
    event: "FRAUD_CONFIRMED",
    actor: "sv-agent-01",
    detail: "Customer denied authorizing AED 2,500.00 · Electronics World",
    hash: "0x2a9f…e8d3",
  },
  {
    ts: "14:02:39",
    event: "VERIFICATION_PASSED",
    actor: "sv-agent-01",
    detail: "Challenge 2-of-3 recognized · no PIN/password requested · language lock: AR-Gulf",
    hash: "0xd1e7…5a22",
  },
  {
    ts: "14:02:33",
    event: "LANGUAGE_LOCKED",
    actor: "sv-agent-01",
    detail: "Customer language detected: Arabic (Gulf) — locked for entire call",
    hash: "0x6b40…11c9",
  },
  {
    ts: "14:02:11",
    event: "CALL_CONNECTED",
    actor: "telephony",
    detail: "Outbound to +971 •• ••• 4567 · connected in 1.2s · recording enabled",
    hash: "0xf08a…b47e",
  },
  {
    ts: "14:02:09",
    event: "CALL_INITIATED",
    actor: "orchestrator",
    detail: "P1 alert dequeued · SLA timer 60s · voice profile: Fatima (AR-Gulf)",
    hash: "0x3c7d…02fa",
  },
  {
    ts: "14:02:08",
    event: "ALERT_RECEIVED",
    actor: "webhook",
    detail: "POST /fraud/alerts · risk 0.94 · velocity anomaly + device mismatch",
    hash: "0xe5b1…6d88",
  },
  {
    ts: "13:59:35",
    event: "AUDIT_SEALED",
    actor: "system",
    detail: "SV-8641 audit sealed · outcome: prevented · est. avoided loss AED 8,120",
    hash: "0x97f4…3e10",
  },
  {
    ts: "13:59:12",
    event: "CARD_FROZEN",
    actor: "sv-agent-01",
    detail: "POST /cards/••7702/freeze → 200 OK (198ms) · temporary · fraud_suspicion",
    hash: "0x18aa…90cc",
  },
  {
    ts: "13:53:05",
    event: "HANDOFF_COMPLETED",
    actor: "telephony",
    detail: "SV-8640 warm transfer · customer distress flag detected via sentiment analysis",
    hash: "0x5d3e…c771",
  },
  {
    ts: "13:45:08",
    event: "FALSE_ALARM_CLOSED",
    actor: "sv-agent-01",
    detail: "SV-8639 customer confirmed all transactions · no action taken · CSAT 4.8",
    hash: "0xb29c…48f5",
  },
];

export const KPIS = [
  {
    key: "prevention",
    en: "Fraud Prevention Rate",
    ar: "معدل منع الاحتيال",
    unit: "%",
    baseline: 43,
    target: 85,
    current: 71,
    good: "up",
  },
  {
    key: "delay",
    en: "Contact Delay",
    ar: "زمن الوصول للعميل",
    unit: "s",
    baseline: 2280,
    target: 90,
    current: 96,
    good: "down",
  },
  {
    key: "verify",
    en: "Verification Completion",
    ar: "اكتمال التحقق",
    unit: "%",
    baseline: 62,
    target: 90,
    current: 87,
    good: "up",
  },
  {
    key: "csat",
    en: "Customer Satisfaction",
    ar: "رضا العملاء",
    unit: "/5",
    baseline: 2.8,
    target: 4.2,
    current: 4.1,
    good: "up",
  },
] as const;

export const LANG_DIST = [
  { lang: "Arabic (Gulf)", langAr: "العربية", pct: 34 },
  { lang: "English", langAr: "الإنجليزية", pct: 24 },
  { lang: "Hindi", langAr: "الهندية", pct: 14 },
  { lang: "Urdu", langAr: "الأردية", pct: 11 },
  { lang: "Filipino", langAr: "الفلبينية", pct: 9 },
  { lang: "Malayalam", langAr: "المالايالامية", pct: 8 },
];

export const OUTCOME_DIST = [
  { label: "Fraud prevented", labelAr: "احتيال مُنع", pct: 58, color: "#0b7a55" },
  { label: "False alarm closed", labelAr: "إنذار كاذب", pct: 22, color: "#8aa396" },
  { label: "Human handoff", labelAr: "تسليم لأخصائي", pct: 14, color: "#b97a11" },
  { label: "No answer", labelAr: "لم يرد", pct: 6, color: "#d64550" },
];

/** 12-week prevented-loss trend (AED K) */
export const TREND = [182, 214, 198, 261, 288, 276, 342, 388, 371, 428, 452, 496];

export const VOICES = [
  {
    id: "marcus",
    name: "Marcus",
    lang: "English",
    desc: "Mature, professional male. Calm authority under stress.",
    params: "stability 0.70 · similarity 0.75 · style 0.30",
  },
  {
    id: "fatima",
    name: "Fatima",
    lang: "العربية الفصحى",
    desc: "Clear, reassuring female. Modern Standard Arabic, Gulf-tuned.",
    params: "stability 0.70 · similarity 0.75 · style 0.30",
  },
];
