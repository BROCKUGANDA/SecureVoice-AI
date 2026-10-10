/**
 * Commercial facts, in one file, so they cannot disagree with themselves.
 *
 * Everything here is load-bearing in four places at once: the `/pricing` route,
 * the pricing strip on the home page and in Settings, the schema.org JSON-LD
 * that AI answer engines read, and the Paddle catalog the checkout charges
 * against. When pricing was written inline in `src/views/Home.tsx` it had
 * exactly one renderer, which is the good case; a pricing page, a
 * `Product`/`Offer` graph and a real gateway make three more, and a fourth
 * renderer nobody remembers to update is how a site ends up quoting one price
 * to a customer and another to the card it charges.
 *
 * `tests/billing/catalog-parity.test.ts` asserts the agreement between this
 * module and the Paddle catalog ids. Read it before changing a number here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️  THREE DIFFERENT PRICE SETS HAVE EXISTED ACROSS THESE BRANCHES. READ THIS.
 *
 *   1. The pre-existing inline home-page block: $490 / $1,490 / Enterprise
 *      quote-per-deployment.
 *   2. `commercial.ts` and the seeded Paddle sandbox catalog: $10 / $40 /
 *      Advanced $120.
 *   3. `src/views/Pricing.tsx` (from origin/dev), now the authority on the page
 *      a buyer actually reads: Starter $99 / Growth $499 / Enterprise $2,000,
 *      with included intervention volume and per-intervention overage, plus an
 *      AED conversion for the UAE buyer.
 *
 * Set (3) was adopted here. It is the only one that models the product the
 * code implements — `src/lib/credits.ts` is one intervention = one credit, and
 * `src/lib/payments/overage.ts` computes the per-intervention charge beyond the
 * included volume. Flat prices with no overage term cannot express either.
 *
 * ⚠️  THE PADDLE SANDBOX CATALOG IS THEREFORE STALE. It was seeded from set (2).
 * After changing a number below, re-run `bun run paddle:seed` (which recreates
 * the catalog) and `bun run paddle:repair-overrides`. Until then the gateway
 * charges amounts the page does not show, which is the exact failure the parity
 * test exists to catch.
 *
 * IF SET (2) WERE THE REAL ONES, revert this file, `scripts/seed-paddle-catalog.ts`
 * and `src/views/Pricing.tsx` TOGETHER. Changing one alone is the drift again.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## Currency
 *
 * List prices are USD. `src/views/Pricing.tsx` also shows the AED equivalent at
 * the standard 3.6725 peg, because the buyer this product is written for budgets
 * in dirhams. Separately, the Paddle catalog carries REGIONAL prices — GBP, EUR
 * and AUD — which is what a buyer in those countries is actually charged. The AED
 * figure on the page is a display conversion, not a charge, and the two must not
 * be conflated.
 */

/** ISO-4217, as schema.org `priceCurrency` and as the `Intl` tag both want it. */
export const PRICE_CURRENCY = "USD";

/**
 * How the money is actually collected, as distinct from the price it is quoted
 * at. Read by the `/pricing` copy and by the FAQ below.
 */
export const SETTLEMENT = {
  rail: "Paddle",
  /** Paddle is a Merchant of Record: it collects and remits sales tax. */
  merchantOfRecord: true,
  /** Currencies the PADDLE CATALOG carries a regional price for. */
  catalogRegionalCurrencies: ["GBP", "EUR", "AUD"],
  /** The peg `src/views/Pricing.tsx` uses for its AED display conversion. */
  aedPeg: 3.6725,
  note: "Plans are billed in US dollars through Paddle, our Merchant of Record, which collects any sales tax or VAT due. The AED equivalent shown alongside is at the standard 3.6725 peg; buyers in the UK, Ireland and Australia are charged a local price in GBP, EUR or AUD rather than a converted USD amount.",
} as const;

export type Plan = {
  id: string;
  name: string;
  nameAr: string;
  /** Whole USD per month. */
  monthlyUsd: number | null;
  /** Whole USD per year, where an annual price is published. */
  yearlyUsd: number | null;
  /** Intervention signals included per month. One signal fires one credit. */
  includedPerMonth: number | null;
  /** Cents per intervention beyond the included volume. `null` = negotiated. */
  overageCents: number | null;
  /** Blurb under the price. */
  tagline: string;
  taglineAr: string;
  /** One-line quota, exactly as it appears on the card. */
  summary: string;
  summaryAr: string;
  /** Bullet list of what the buyer actually gets. */
  includes: string[];
  includesAr: string[];
  featured: boolean;
  /** schema.org Offer. A missing `price` means "contact sales", which is valid
   *  and is what an answer engine needs in order to say "custom" rather than
   *  invent a number. */
  offer: {
    description: string;
    price?: string;
    priceCurrency: string;
    availability: string;
    url?: string;
  };
};

/**
 * The three published tiers.
 *
 * `included` + `overage` is the model, not three flat prices, and it is the
 * model the code actually implements: `src/lib/credits.ts` is one intervention =
 * one credit, and `src/lib/payments/overage.ts` computes the per-intervention
 * charge beyond the included volume. A flat monthly price with no overage term
 * cannot express either.
 *
 * `availability` is schema.org's `https://schema.org/InStock` — the value an
 * answer engine reads to decide the product is purchasable at all.
 */
export const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    nameAr: "البداية",
    monthlyUsd: 99,
    yearlyUsd: null,
    includedPerMonth: 500,
    overageCents: 15,
    tagline: "For evaluation teams proving the voice loop end to end.",
    taglineAr: "لفرق التقييم التي تثبت الحلقة الصوتية من طرف إلى طرف.",
    summary: "500 interventions · 1 organization · AR/EN voices · email support",
    summaryAr: "٥٠٠ تدخّل · منظمة واحدة · أصوات عربية وإنجليزية · دعم بالبريد الإلكتروني",
    includes: [
      "500 intervention signals per month",
      "One organization, browser-based Command Center",
      "Sealed audit chain with hash-linked evidence",
      "Arabic and English voice agents",
      "Email support",
    ],
    includesAr: [
      "٥٠٠ إشارة تدخّل شهرياً",
      "منظمة واحدة، ومركز تشغيل عبر المتصفح",
      "سجل تدقيق مختوم بأدلة مترابطة بالتجزئة",
      "وكلاء صوتيون بالعربية والإنجليزية",
      "دعم عبر البريد الإلكتروني",
    ],
    featured: false,
    offer: {
      description:
        "500 outbound interventions per month for one organization, Arabic and English voice agents, sealed audit chain and email support.",
      price: "99",
      priceCurrency: PRICE_CURRENCY,
      availability: "https://schema.org/InStock",
    },
  },
  {
    id: "growth",
    name: "Growth",
    nameAr: "النمو",
    monthlyUsd: 499,
    yearlyUsd: null,
    includedPerMonth: 2500,
    overageCents: 12,
    tagline: "For mid-market banks and insurers running live fraud desks.",
    taglineAr: "للبنوك وشركات التأمين متوسطة الحجم التي تدير مكاتب احتيال حيّة.",
    summary: "2,500 interventions · multi-tenant · BYOK · priority support",
    summaryAr: "٢٬٥٠٠ تدخّل · تعدد المستأجرين · مفاتيح خاصة · دعم ذو أولوية",
    includes: [
      "2,500 intervention signals per month",
      "Multi-tenant organization support",
      "Signed webhooks with replay protection",
      "Bring your own ElevenLabs key (BYOK)",
      "Guardrail policy configurable per institution",
      "Priority support",
    ],
    includesAr: [
      "٢٬٥٠٠ إشارة تدخّل شهرياً",
      "دعم تعدد المستأجرين",
      "ويب هوكس موقّعة مع حماية من إعادة الإرسال",
      "استخدام مفتاح ElevenLabs الخاص بك (BYOK)",
      "سياسة ضوابط قابلة للتهيئة لكل مؤسسة",
      "دعم ذو أولوية",
    ],
    featured: true,
    offer: {
      description:
        "2,500 outbound interventions per month, multi-tenant organizations, signed webhooks, BYOK, per-institution guardrail policy and priority support.",
      price: "499",
      priceCurrency: PRICE_CURRENCY,
      availability: "https://schema.org/InStock",
    },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    nameAr: "المؤسسات",
    monthlyUsd: 2000,
    yearlyUsd: null,
    includedPerMonth: 10000,
    overageCents: null,
    tagline: "For Tier-1 UAE banks deploying inside their own perimeter.",
    taglineAr: "للبنوك من الفئة الأولى في الإمارات التي تنشر داخل محيطها الخاص.",
    summary: "10,000 interventions · in-VPC or data centre · custom beyond",
    summaryAr: "١٠٬٠٠٠ تدخّل · نشر داخلي · تسعير مخصص لما يزيد",
    includes: [
      "10,000 intervention signals per month, custom volume pricing beyond",
      "Deploys inside your own VPC or data centre",
      "Dedicated deployment for the WebSocket voice plane",
      "Shariah-compliant terminology engine",
      "Takaful and insurer-specific voice policies",
      "Named technical contact",
    ],
    includesAr: [
      "١٠٬٠٠٠ إشارة تدخّل شهرياً، وتسعير حجم مخصص لما يزيد",
      "النشر داخل شبكتك الافتراضية الخاصة أو مركز بياناتك",
      "نشر مخصص لمستوى الصوت عبر WebSocket",
      "محرك مصطلحات متوافق مع الشريعة",
      "سياسات صوتية خاصة بالتكافل وشركات التأمين",
      "جهة اتصال فنية مسمّاة",
    ],
    featured: false,
    offer: {
      description:
        "10,000 outbound interventions per month with custom volume pricing beyond, deployed inside your own VPC or data centre, with a Shariah-compliant terminology engine and takaful voice policies.",
      price: "2000",
      priceCurrency: PRICE_CURRENCY,
      availability: "https://schema.org/InStock",
    },
  },
];

/** Currency-formatting helper so no renderer re-implements `Intl` by hand. */
export function formatMonthly(plan: Plan, lang: "en" | "ar" = "en"): string {
  if (plan.monthlyUsd === null) return lang === "ar" ? "حسب الطلب" : "Custom";
  return new Intl.NumberFormat(lang === "ar" ? "ar-AE" : "en-US", {
    style: "currency",
    currency: PRICE_CURRENCY,
    maximumFractionDigits: 0,
  }).format(plan.monthlyUsd);
}

/** Included interventions, or "" where the plan is negotiable rather than tiered. */
export function formatIncluded(plan: Plan, lang: "en" | "ar" = "en"): string {
  if (plan.includedPerMonth === null) return "";
  return plan.includedPerMonth.toLocaleString(lang === "ar" ? "ar-AE" : "en-US");
}

/** Per-intervention overage, or "" where it is negotiated. */
export function formatOverage(plan: Plan, lang: "en" | "ar" = "en"): string {
  if (plan.overageCents === null) return "";
  return new Intl.NumberFormat(lang === "ar" ? "ar-AE" : "en-US", {
    style: "currency",
    currency: PRICE_CURRENCY,
    maximumFractionDigits: 2,
  }).format(plan.overageCents / 100);
}

/**
 * The published FAQ.
 *
 * This is not decoration. `FAQPage` is one of the few schema.org types an answer
 * engine will quote verbatim, and every question here is one the sales team is
 * actually asked — the answer text is written to be readable out of context by
 * something that has never seen this website.
 */
export const FAQ: { q: string; qAr: string; a: string; aAr: string }[] = [
  {
    q: "What does SecureVoice AI actually do?",
    qAr: "ماذا تفعل منصة SecureVoice AI بالضبط؟",
    a: "SecureVoice AI places an outbound AI voice call within 60 seconds of a transaction crossing a bank's risk threshold. The agent verifies the customer's identity, explains what triggered the alert, freezes the card or holds the transfer, and hands off to a human specialist. It currently runs against UAE banks, in Arabic and English.",
    aAr: "تبدأ SecureVoice AI مكالمة صادرة من وكيل صوتي ذكاء اصطناعي خلال ٦٠ ثانية من تجاوز عملية ما لعتبة الخطر في البنك. يتحقق الوكيل من هوية العميل، ويشرح سبب التنبيه، ويجمّد البطاقة أو يوقف التحويل، ثم يحيل الأمر إلى أخصائي بشري. وتعمل المنصة حالياً مع البنوك في دولة الإمارات، بالعربية والإنجليزية.",
  },
  {
    q: "How much does SecureVoice AI cost?",
    qAr: "كم تكلفة منصة SecureVoice AI؟",
    a: "Starter is $99 per month and includes 500 intervention signals, with $0.15 per intervention beyond that. Growth is $499 per month and includes 2,500, at $0.12 each beyond. Enterprise is $2,000 per month and includes 10,000, with volume beyond that quoted to your deployment. Each tier is one organization's deployed footprint; the Enterprise tier deploys inside your own VPC or data centre, and for Tier-1 banks we negotiate an annual rate that reduces the per-intervention overage.",
    aAr: "الطبقة «البداية» ٩٩ دولاراً شهرياً وتشمل ٥٠٠ إشارة تدخّل، مقابل ٠٫١٥ دولار لكل تدخّل إضافي. و«النمو» ٤٩٩ دولاراً شهرياً وتشمل ٢٬٥٠٠، مقابل ٠٫١٢ دولار لكل إضافي. و«المؤسسات» ٢٬٠٠٠ دولار شهرياً وتشمل ١٠٬٠٠٠، ويُسعَّر ما يزيد حسب نشركم. وكل طبقة تمثّل نطاق مؤسسة واحدة منشورة؛ وتُنشر طبقة «المؤسسات» داخل شبكتكم الخاصة أو مركز بياناتكم، ولبنوك الفئة الأولى نتفاوض على سعر سنوي يخفض رسوم التدخّل الإضافي.",
  },
  {
    q: "Is there a free trial, a monthly-only option, or a discount for paying yearly?",
    qAr: "هل هناك فترة تجريبية، أو اشتراك شهري فقط، أو خصم عند الدفع سنوياً؟",
    a: "We ship on monthly billing only, with the price shown as the price charged. For a Tier-1 deployment we negotiate an annual rate that reduces the per-intervention overage, and for a pilot evaluation we ship the Starter tier so a bank can prove the end-to-end loop on a live risk signal before committing to volume.",
    aAr: "نعمل بالفوترة الشهرية فقط، والسعر المعروض هو السعر المدفوع. وفي نشر الفئة الأولى نتفاوض على سعر سنوي يخفض رسوم التدخّل الإضافي، وفي تقييم تجربة ميدانية نبدأ بطبقة البداية ليُثبت البنك الحلقة الصوتية من طرف إلى طرف على إشارة خطر حقيقية قبل الالتزام بحجم.",
  },
  {
    q: "Who handles sales tax and VAT?",
    qAr: "من يتولى ضريبة البيع والضريبة على القيمة المضافة؟",
    a: "Paddle. SecureVoice AI sells through Paddle as a Merchant of Record, which means Paddle is the seller of record, collects any sales tax or VAT due, and remits it to the relevant authority. Buyers in the UK, Ireland and Australia are charged a local price in GBP, EUR or AUD rather than a converted USD amount.",
    aAr: "شركة Paddle. تُباع المنصة عبر Paddle بصفتها التاجر الرسمي، ما يعني أنها تُحصّل أي ضريبة بيع أو قيمة مضافة مستحقة وتحوّلها إلى الجهة المختصة. ويُحاسَب المشترون في المملكة المتحدة وأيرلندا وأستراليا بسعر محلي بالإسترليني أو اليورو أو دولار أسترالي بدلاً من تحويل المبلغ بالدولار الأمريكي.",
  },
  {
    q: "Does the agent ever ask for a PIN, password or card number?",
    qAr: "هل يطلب الوكيل رمزاً سرياً أو كلمة مرور أو رقم بطاقة؟",
    a: "No, and the platform cannot ask for one. Requests for PINs, passwords, one-time passcodes and full card numbers are blocked at the speech layer before the text reaches a synthesiser, in every supported language. Account identifiers are held as tokens rather than full card numbers, so a full number is not available to ask for in the first place.",
    aAr: "لا، ولا تستطيع المنصة أن تطلب ذلك. تُحجب طلبات الرموز السرية وكلمات المرور ورموز التحقق وأرقام البطاقات الكاملة في طبقة النطق قبل أن يصل النص إلى مُركِّب الصوت، وذلك في جميع اللغات المدعومة. وتُحفظ معرّفات الحساب كرموز مميّزة لا كأرقام بطاقات كاملة، بحيث لا يوجد رقم كامل متاح للطلب أصلاً.",
  },
  {
    q: "Is it compliant with UAE Central Bank requirements?",
    qAr: "هل المنصة متوافقة مع متطلبات مصرف الإمارات المركزي؟",
    a: "Yes. The platform is built to UAE Central Bank expectations for fraud intervention: every intervention opens with a spoken disclosure that it is an automated system calling on the bank's behalf, protective actions are staged and reversible until a second actor commits them, and every action is written to a tamper-evident audit chain. An Enterprise deployment ships a CBUAE audit pack. The platform itself is not a licensed financial institution and the interventions it performs are operational actions under the contracting bank's own policy, not financial advice.",
    aAr: "نعم. بُنيت المنصة وفق متطلبات مصرف الإمارات المركزي لتدخّل الاحتيال: تبدأ كل تدخّل بإفصاح منطوق بأنها نظام آلي يتصل نيابة عن البنك، والإجراءات الوقائية مُعدّة وقابلة للتراجع حتى يعتمدها طرف ثانٍ، وكل إجراء يُكتب في سجل تدقيق مقاوم للعبث. ويشمل نشر طبقة «المؤسسات» حزمة تدقيق للمصرف المركزي. أما المنصة نفسها فليست مؤسسة مالية مرخّصة، وإجراءاتها إجراءات تشغيلية تحت سياسة البنك المتعاقد وليست نصيحة مالية.",
  },
  {
    q: "Where is our data stored and processed?",
    qAr: "أين تُخزَّن بياناتنا وتُعالَج؟",
    a: "The reference deployment runs on European infrastructure (Frankfurt) with TLS 1.3 in transit and AES-256 at rest. Speech synthesis and transcription are performed by sub-processors in the United States and the United Kingdom. An Enterprise deployment runs inside your own VPC, so call audio, transcripts and case data never leave your perimeter. We do not sell personal data and do not use it for advertising.",
    aAr: "يعمل النشر المرجعي على بنية تحتية أوروبية (فرانكفورت) بتشفير TLS 1.3 أثناء النقل وAES-256 أثناء التخزين. ويُجرى توليد الكلام وتحويله إلى نص عبر معالجين فرعيين في الولايات المتحدة والمملكة المتحدة. أما نشر طبقة «المؤسسات» فيعمل داخل شبكتك الافتراضية الخاصة، بحيث لا يغادر صوت المكالمات ولا النصوص ولا بيانات الحالة نطاقك أبداً. ولا نبيع البيانات الشخصية ولا نستخدمها في الإعلانات.",
  },
  {
    q: "Can we get a refund?",
    qAr: "هل يمكننا استرداد المبلغ؟",
    a: "Yes. Monthly subscriptions can be cancelled and refunded pro rata at any time before the next renewal; the refund is issued to the original payment method. Because interventions are metered, a credit already consumed by a completed intervention call is not refundable, and we will show you the consumption breakdown before you decide. Starters and Growth are covered by this policy; Enterprise deployments are governed by the signed agreement.",
    aAr: "نعم. يمكن إلغاء الاشتراكات الشهرية واسترداد المبلغ بالتناسب في أي وقت قبل التجديد التالي؛ ويُصدر الاسترداد إلى وسيلة الدفع الأصلية. ولأن التدخّلات تُحتسب بالاستخدام، فإن التدخّل الذي استُهلك في مكالمة مكتملة لا يُسترد، وسنعرض عليكم تفصيل الاستهلاك قبل أن تقرروا. وتغطي هذه السياسة طبقتَي البداية والنمو؛ أما «المؤسسات» فيخضع للاتفاقية الموقّعة.",
  },
];

/** The company, for the Organization graph and the footer/legal pages. */
export const COMPANY = {
  name: "SecureVoice AI",
  legalName: "SecureVoice Technologies FZ-LLC",
  legalNameAr: "شركة SecureVoice Technologies FZ-LLC",
  /** Founding year is the only one this codebase can substantiate. */
  foundingYear: "2025",
  url: "https://securevoiceai.me",
  city: "Dubai",
  country: "UAE",
  countryCode: "AE",
  region: "Dubai, United Arab Emirates",
  industry: "Financial technology · Fraud prevention",
  /** Directory the company claims profiles in. Empty on purpose: inventing
   *  `sameAs` URLs is the classic structured-data lie, and a wrong one is worse
   *  than a missing one. Populate from accounts that actually exist. */
  sameAs: [] as string[],
} as const;
