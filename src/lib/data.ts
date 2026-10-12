/**
 * Two static tables, and deliberately nothing else.
 *
 * `KPIS` is the pitch page's baseline-vs-target statement (Product.tsx) — a goal
 * written down, not a measurement. `VOICES` is the voice catalogue the operator
 * console offers for registration.
 *
 * Everything else that used to live here — recent calls, an audit log, the
 * language and outcome distributions, a twelve-week loss-avoided curve — was
 * hand-written operational data, and the OPERATIONS console rendered it as if it
 * were measured. It does not: the figures are now queries in
 * `GET /api/console/analytics` (src/app/api/console/analytics/route.ts), and a
 * metric the platform does not collect is absent from that response rather than
 * defaulted here. Keeping a flattering fiction in a `src/lib/` module with no
 * consumer is how it gets re-imported by the next screen that needs a number.
 */

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
