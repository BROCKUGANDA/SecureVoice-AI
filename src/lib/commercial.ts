/**
 * Commercial facts, in one file, so they cannot disagree with themselves.
 *
 * Everything here is load-bearing in three places at once: the `/pricing` route,
 * the pricing block on the home page, and the schema.org JSON-LD that AI answer
 * engines read. When pricing was written inline in `src/views/Home.tsx` it had
 * exactly one renderer, which is the good case; adding a pricing page and a
 * `Product`/`Offer` graph makes two more, and a fourth renderer nobody remembers
 * to update is how a site ends up quoting $490 to a customer and $1,490 to a
 * crawler.
 *
 * NUMBERS MUST MATCH THE SIGNED AGREEMENT. If a price changes here, change it
 * in the rate card the billing system reads, in the same commit.
 *
 * Currency is USD. Settlement happens in KES through Paystack at checkout, which
 * is why the pricing page has to say so out loud: the number on the page and the
 * number on the customer's statement are deliberately different, and a customer
 * who discovers that at the till is a support ticket.
 */

/** ISO-4217, as schema.org `priceCurrency` and as the `Intl` tag both want it. */
export const PRICE_CURRENCY = "USD";

/**
 * The settlement currency and rail. Not an offer price — it is how a USD price
 * is actually collected.
 */
export const SETTLEMENT = {
  currency: "KES",
  rail: "Paystack",
  /** Fills the `checkout` FAQ pair; keep in step with the pricing page copy. */
  note: "Prices are quoted in USD; at checkout you are charged the KES equivalent via Paystack and your receipt lists the Ksh amount.",
} as const;

export type Plan = {
  id: string;
  name: string;
  nameAr: string;
  /** Whole USD per month. `null` means "quoted per deployment" — see `Enterprise`. */
  monthlyUsd: number | null;
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
  /** schema.org Offer. `null` price = "Contact sales", which is valid and is what
   *  an answer engine needs in order to say "custom" rather than invent a number. */
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
 * `availability` is schema.org's `https://schema.org/InStock` — the value an
 * answer engine reads to decide the product is purchasable at all.
 */
export const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    nameAr: "البداية",
    monthlyUsd: 490,
    tagline: "One bank entity, live in a week.",
    taglineAr: "جهة مصرفية واحدة، تشغيل خلال أسبوع.",
    summary: "1,000 interventions · 1 bank entity · 6 languages · email support",
    summaryAr: "١٬٠٠٠ تدخّل · جهة مصرفية واحدة · ٦ لغات · دعم بالبريد الإلكتروني",
    includes: [
      "1,000 outbound interventions per month",
      "1 bank entity / 1 tenancy",
      "6 languages (English, Arabic and 4 more)",
      "Email support, next business day",
      "Tamper-evident audit chain",
      "Hosted deployment (EU region)",
    ],
    includesAr: [
      "١٬٠٠٠ تدخّل صادر شهرياً",
      "جهة مصرفية واحدة / مستأجر واحد",
      "٦ لغات (الإنجليزية والعربية و٤ أخرى)",
      "دعم بالبريد الإلكتروني في يوم العمل التالي",
      "سجل تدقيق مقاوم للعبث",
      "نشر مستضاف (منطقة أوروبا)",
    ],
    featured: false,
    offer: {
      description:
        "1,000 outbound interventions per month for 1 bank entity, 6 languages, email support.",
      price: "490",
      priceCurrency: PRICE_CURRENCY,
      availability: "https://schema.org/InStock",
    },
  },
  {
    id: "pro",
    name: "Pro",
    nameAr: "الاحترافي",
    monthlyUsd: 1490,
    tagline: "The production tier most banks run on.",
    taglineAr: "الطبقة الإنتاجية التي تعمل بها معظم البنوك.",
    summary: "5,000 interventions · 5 entities · streaming voice · priority routing · 99.9% SLA",
    summaryAr: "٥٬٠٠٠ تدخّل · ٥ جهات · صوت مبثوث · توجيه بأولوية · اتفاقية مستوى خدمة ٩٩٫٩٪",
    includes: [
      "5,000 outbound interventions per month",
      "5 bank entities / 5 tenancies",
      "All 6 supported languages incl. streaming voice",
      "Priority carrier routing",
      "99.9% uptime SLA with credits",
      "Dedicated support channel",
    ],
    includesAr: [
      "٥٬٠٠٠ تدخّل صادر شهرياً",
      "٥ جهات مصرفية / ٥ مستأجرين",
      "كل اللغات الست المدعومة بما فيها الصوت المبثوث",
      "توجيه أولوية عبر مشغّلي الاتصالات",
      "اتفاقية مستوى خدمة ٩٩٫٩٪ مع تعويضات",
      "قناة دعم مخصصة",
    ],
    featured: true,
    offer: {
      description:
        "5,000 outbound interventions per month, 5 bank entities, all 10 languages with streaming voice, priority routing and a 99.9% uptime SLA.",
      price: "1490",
      priceCurrency: PRICE_CURRENCY,
      availability: "https://schema.org/InStock",
    },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    nameAr: "المؤسسات",
    monthlyUsd: null,
    tagline: "Quoted per deployment.",
    taglineAr: "تسعير مخصص لكل نشر.",
    summary: "Unlimited volume · VPC deployment · BYOK · voice clones · CBUAE audit pack",
    summaryAr:
      "حجم غير محدود · نشر داخل شبكتك الخاصة VPC · مفاتيح خاصة BYOK · استنساخ أصوات · حزمة تدقيق لأنظمة المصرف المركزي",
    includes: [
      "Negotiated volume, no hard intervention cap",
      "Deployment inside your own VPC (data never leaves your perimeter)",
      "Bring your own keys (BYOK) for speech and storage",
      "Voice cloning from your own recordings",
      "CBUAE / UAE Central Bank audit pack",
      "Named solutions architect and 24/7 escalation",
    ],
    includesAr: [
      "حجم متفاوض عليه، دون سقف صارم للتدخّلات",
      "النشر داخل شبكتك الافتراضية الخاصة (البيانات لا تغادر نطاقك)",
      "استخدام مفاتيحكم الخاصة (BYOK) للصوت والتخزين",
      "استنساخ الصوت من تسجيلاتكم الخاصة",
      "حزمة تدقيق للمصرف المركزي الإماراتي",
      "مهندس حلول مُسمّى وتصعيد على مدار الساعة",
    ],
    featured: false,
    offer: {
      // No `price` at all. schema.org allows an offer with no price, and an
      // answer engine reads that as "ask the vendor" rather than guessing a
      // number — which is the whole point: a guessed enterprise price is worse
      // than no enterprise price.
      description:
        "Negotiated volume, in-VPC deployment, bring-your-own-keys, voice cloning, CBUAE audit pack, named architect. Priced per deployment.",
      priceCurrency: PRICE_CURRENCY,
      availability: "https://schema.org/InStock",
    },
  },
];

/** Currency-formatting helper so no renderer re-implements `Intl` by hand. */
export function formatMonthly(plan: Plan, lang: "en" | "ar" = "en"): string {
  if (plan.monthlyUsd === null) return lang === "ar" ? "حسب الطلب" : "Custom";
  const amount = new Intl.NumberFormat(lang === "ar" ? "ar-AE" : "en-US", {
    style: "currency",
    currency: PRICE_CURRENCY,
    maximumFractionDigits: 0,
  }).format(plan.monthlyUsd);
  return amount;
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
    a: "Starter is $490 per month for 1,000 interventions and one bank entity. Pro is $1,490 per month for 5,000 interventions, five entities, all six languages and a 99.9% uptime SLA. Enterprise is quoted per deployment and includes in-VPC deployment, bring-your-own-keys and a CBUAE audit pack. Prices are quoted in USD and settled in KES via Paystack at checkout.",
    aAr: "الطبقة «البداية» بـ ٤٩٠ دولاراً شهرياً مقابل ١٬٠٠٠ تدخّل وجهة مصرفية واحدة. والطبقة «الاحترافي» بـ ١٬٤٩٠ دولاراً شهرياً مقابل ٥٬٠٠٠ تدخّل وخمس جهات وكل اللغات العشر واتفاقية مستوى خدمة ٩٩٫٩٪. أما «المؤسسات» فتُسعَّر حسب النشر وتشمل النشر داخل الشبكة الخاصة والمفاتيح الخاصة وحزمة تدقيق للمصرف المركزي. والأسعار بالدولار الأمريكي وتُسدَّد بالشلن الكيني عبر Paystack عند الدفع.",
  },
  {
    q: "Which languages does the voice agent speak?",
    qAr: "ما اللغات التي يتحدث بها الوكيل الصوتي؟",
    a: "Six: Arabic, English, Hindi, Urdu, French and Swahili. Arabic and English are first-class — both are used for customer contact and Arabic runs right-to-left throughout the platform. Language is selected per intervention, so a bank can run an English-speaking and an Arabic-speaking portfolio side by side from one deployment.",
    aAr: "ست لغات: العربية والإنجليزية والهندية والأردية والفرنسية والسواحيلية. وتُعامل العربية والإنجليزية كلتاهما كلغة أساسية في التواصل مع العملاء، تعمل العربية من اليمين إلى اليسار في كل أجزاء المنصة. وتُحدَّد اللغة لكل حالة تدخّل على حدة، فيمكن للبنك تشغيل محفظة تعمل بالإنجليزية وأخرى بالعربية من النشر نفسه.",
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
    aAr: "نعم. بُنيت المنصة وفق متطلبات مصرف الإمارات المركزي لتدخل الاحتيال: تبدأ كل تدخل بإفصاح منطوق بأنها نظام آلي يتصل نيابة عن البنك، والإجراءات الوقائية مُعدّة وقابلة للتراجع حتى يعتمدها طرف ثانٍ، وكل إجراء يُكتب في سجل تدقيق مقاوم للعبث. ويشمل نشر طبقة «المؤسسات» حزمة تدقيق للمصرف المركزي. أما المنصة نفسها فليست مؤسسة مالية مرخّصة، وإجراءاتها إجراءات تشغيلية تحت سياسة البنك المتعاقد وليست نصيحة مالية.",
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
    a: "Yes. Monthly subscriptions can be cancelled and refunded pro rata at any time before the next renewal; the refund is issued to the original payment method. Annual and Enterprise contracts are quoted per deployment and are covered by the signed agreement instead. Consumed prepaid intervention credits are non-refundable once they have been used for a completed intervention call, and we will show you the consumption breakdown before you decide.",
    aAr: "نعم. يمكن إلغاء الاشتراكات الشهرية واسترداد المبلغ بالتناسب في أي وقت قبل التجديد التالي، ويُصدر الاسترداد إلى وسيلة الدفع الأصلية. أما العقود السنوية وعقود «المؤسسات» فتُسعَّر حسب النشر ويخضعها الاتفاقية الموقّعة بدلاً من ذلك. أما أرصدة التدخّل المسبقة المدفوعة فهي غير قابلة للاسترداد بعد استخدامها في مكالمة تدخّل مكتملة، وسنعرض عليكم تفصيل الاستهلاك قبل أن تقرروا.",
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
