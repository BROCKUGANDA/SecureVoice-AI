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

// Type-only, so it is erased at compile time and cannot introduce a runtime cycle
// back into the store. `Lang` is the UI language union; this module predates it
// and is pure data, which is why the import is type-only rather than a value.
import type { Lang } from "@/lib/store";

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
  /**
   * The Arabic rendering of `note`.
   *
   * The call site was `t(SETTLEMENT.note, SETTLEMENT.note, lang)` — the same
   * English string in both slots, so the entire tax/Merchant-of-Record
   * disclosure silently rendered in English on the pricing page. For a store
   * selling to UAE banks and insurers, leaving the VAT disclosure untranslated
   * is the one string that most needed translating: it is the paragraph that
   * says who the merchant of record is and why the price is in USD.
   *
   * MSA, matching the rest of this file's Arabic (`nameAr`, `taglineAr`).
   *
   * Passives are worth stating because they are the easy mistake here: the
   * passive of حَسَبَ is تُحسَب, not تُحاسَب, and the first draft of this string
   * carried that error along with a Latin "الدرهم Emirati" and missing spaces
   * before the currency codes. This paragraph is the VAT disclosure, so it is
   * read by a finance team rather than skimmed, which raises the cost of getting
   * it subtly wrong.
   */
  noteAr:
    "تُحسَب الخطط بالدولار الأمريكي عبر Paddle، وهو سجل التاجر المعتمد لدينا، إذ يحصّل ضريبة المبيعات أو ضريبة القيمة المضافة المستحقة. ويُعرض المبلغ المكافئ بالدرهم الإماراتي بسعر الربط القياسي 3.6725؛ أمّا المشترون في المملكة المتحدة وأيرلندا وأستراليا فتُحسَب بأسعار محلية بالجين الإسترليني أو اليورو أو الأسترالي، بدلاً من تحويل المبلغ إلى دولارات.",
} as const;

export type Plan = {
  id: string;
  name: string;
  nameAr: string;
  /** Whole USD per month. */
  monthlyUsd: number | null;
  /** Whole USD per year. Exactly ten monthly on every tier. */
  yearlyUsd: number | null;
  /** Intervention signals included per month. One signal fires one credit. */
  includedPerMonth: number | null;
  /** Cents per intervention beyond the included volume. `null` = negotiated. */
  overageCents: number | null;
  /**
   * People this plan may hold an invitation for. `null` = unlimited.
   *
   * ENFORCED, not advertised: `src/lib/billing/seats.ts` refuses the
   * invitation once the organisation's member count reaches this number. It is
   * a seat COUNT, and the Owner counts against it — a Starter plan is one
   * person, which is what its own bullet says. A plan with no cap is `null`,
   * never a big number: `999` would be a cap that behaves like a wall at
   * exactly the moment a large bank adds its thousandth analyst.
   */
  seats: number | null;
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
  /**
   * Whether the PRICE is published on the public pricing page.
   *
   * Deliberately NOT the same thing as `monthlyUsd`. `monthlyUsd` is the
   * commercial truth — it is the amount the Paddle catalog charges, and it is
   * what `tests/billing/catalog-parity.test.ts` holds the site to. Setting
   * `publiclyPriced: false` hides the number and renders "Contact sales" in its
   * place, because a Tier-1 bank buys through procurement rather than a card and
   * a published figure becomes an anchor we did not intend to set.
   *
   * Kept separate from `monthlyUsd: null` on purpose. Nulling the price would
   * erase the number the catalog charges and break the parity guarantee that
   * stops the site quoting a buyer one figure and the gateway charging another.
   */
  publiclyPriced: boolean;
  /**
   * Sold by negotiation and invoiced, NOT through Paddle.
   *
   * A plan that carries this flag has no Paddle product: it is priced in an
   * order form and invoiced directly. The flag exists so the Paddle-facing
   * surfaces — the browser price map (`src/lib/paddle-browser.ts`) and the
   * catalog seeder (`scripts/seed-paddle-catalog.ts`) — can EXCLUDE it
   * without each of them re-deciding which plans are sold on Paddle.
   *
   * `pilot` carries it. `enterprise` deliberately does NOT: its commercial
   * route is invoicing, but its Paddle product has to stay in the catalog so
   * existing subscribers' price ids keep resolving to a plan. A plan id that
   * no longer resolves silently replaces the tenant's included allowance with
   * a deployment default — see `src/lib/payments/plans.ts`.
   */
  salesAssisted?: boolean;
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
 * ANNUAL is 10x monthly on every tier — "two months free" — and Paddle's catalog
 * carries a matching yearly price per product. `tests/billing/catalog-parity.test.ts`
 * asserts both the ratio and that the ids exist, because a page offering an
 * annual toggle with no annual price behind it charges the monthly amount twice
 * as often as the buyer chose.
 *
 * —————————————————————————————————————————————————————————————————————————————
 * ⚠️  PRICE SETS, for the record. Four have existed across these branches.
 *
 *   1. Pre-existing inline home block: $490 / $1,490 / Enterprise quote.
 *   2. `commercial.ts` + a first seeded catalog: $10 / $40 / Advanced $120.
 *   3. `src/views/Pricing.tsx` (from origin/dev), adopted: $99 / $499 /
 *      Enterprise $2,000, with included volume and per-intervention overage.
 *   4. `docs/canvas-build/content.json`: "AED 15,000 a month" (~$4,085) as a
 *      described BUYER deal value against AED 200,000 of write-offs — not a list
 *      price, so not comparable, but worth a rate-card owner deciding between.
 *   5. THE CURRENT SET. $2,500 / $9,000 / Enterprise from $25,000, plus a
 *      $12,000 ninety-day Pilot, with overage at $4.50 / $3.50 / $2.25 / $5.00.
 *
 * WHY SET (5) REPLACED SET (3) — and it is not a rounding change.
 *
 * Set (3)'s overage of $0.15 and $0.12 per intervention was BELOW the fully
 * loaded cost of one intervention on every route the platform sells on:
 * ≈$0.96 (UAE via Twilio), ≈$1.17 (Kenya via Twilio), ≈$0.39 (local SIP) —
 * `docs/UNIT-ECONOMICS.md`. A published price below cost is not a competitive
 * position, it is a loss on every extra intervention, and a bank's procurement
 * team finds it by asking the right question. Set (5) prices the INTERVENTION
 * — never the minute — and clears the floor of fully loaded cost ÷ (1 − 0.70
 * target margin) on the costliest route (Kenya mobile via Twilio).
 *
 * The model's rules, in full, live in `docs/UNIT-ECONOMICS.md`: the onboarding
 * fee, the pilot credit, the Enterprise telephony pass-through, the annual
 * escalator, the carrier-rate adjustment clause, the minimum terms and the
 * discount-approval matrix. They are COMMERCIAL terms, not code, and the code
 * here carries the prices they are applied to.
 *
 * If the $490 figures were ever the real ones, revert `commercial.ts`,
 * `scripts/seed-paddle-catalog.ts` and `src/views/Pricing.tsx` TOGETHER —
 * changing one alone is the drift again.
 * —————————————————————————————————————————————————————————————————————————————
 *
 * `availability` is schema.org's `https://schema.org/InStock` — the value an
 * answer engine reads to decide the product is purchasable at all.
 */
export const PLANS: Plan[] = [
  {
    id: "pilot",
    name: "Pilot",
    nameAr: "التجربة",
    monthlyUsd: 12000,
    // A ninety-day engagement has no annual price. `null` here is what keeps
    // the browser price map and the catalog seeder from creating a yearly
    // Paddle product for a plan that is not sold on Paddle at all.
    yearlyUsd: null,
    includedPerMonth: 2000,
    overageCents: 500,
    // Five seats, the same as Growth. A pilot is STAFFED — a named pilot owner,
    // a fraud-ops lead and somebody who reads the evidence — and a one-seat cap
    // on a $12,000 engagement would be the cap being discovered by being
    // refused. It is not a rung on the recurring seat ladder: the Pilot has no
    // annual price, so it is not a subscription tier at all.
    seats: 5,
    // Ninety days, invoiced, with 50% of the fee credited toward the first
    // annual contract. It is a way to buy the evidence, not a subscription.
    salesAssisted: true,
    tagline: "Ninety days, one alert type, written success criteria.",
    taglineAr: "تسعون يوماً، ونوع تنبيه واحد، ومعايير نجاح مكتوبة.",
    summary: "2,000 interventions · 90 days · shadow first, then live",
    summaryAr: "٢٬٠٠٠ تدخّل · ٩٠ يوماً · يبدأ بوضع الظل ثم ينتقل إلى المباشر",
    includes: [
      "2,000 intervention signals over 90 days",
      "Shadow run first: cases recorded, no customer contacted",
      "One named pilot owner and a written success criteria sheet",
      "Daily review of contact rate, containment and complaints",
      "Five named seats",
      "50% of the pilot fee credited toward the first annual contract",
      "Onboarding and language tuning included",
    ],
    includesAr: [
      "٢٬٠٠٠ إشارة تدخّل خلال ٩٠ يوماً",
      "يبدأ بوضع الظل: تُسجَّل الحالات دون الاتصال بأي عميل",
      "مالك تجربة واحد مسمّى وورقة معايير نجاح مكتوبة",
      "مراجعة يومية لمعدل الاتصال ونسبة الاحتواء والشكاوى",
      "خمسة مقاعد مسماة",
      "يُضاف نصف رسوم التجربة إلى العقد السنوي الأول",
      "يشمل الإعداد وضبط اللغة",
    ],
    featured: false,
    publiclyPriced: true,
    offer: {
      description:
        "Ninety-day pilot for 2,000 outbound interventions, shadow run first, written success criteria, and 50% of the fee credited toward the first annual contract.",
      price: "12000",
      priceCurrency: PRICE_CURRENCY,
      availability: "https://schema.org/InStock",
    },
  },
  {
    id: "starter",
    name: "Starter",
    nameAr: "البداية",
    monthlyUsd: 2500,
    yearlyUsd: 25000,
    includedPerMonth: 500,
    overageCents: 450,
    seats: 1,
    tagline: "For evaluation teams proving the voice loop end to end.",
    taglineAr: "لفرق التقييم التي تثبت الحلقة الصوتية من طرف إلى طرف.",
    summary: "500 interventions · 1 organization · AR/EN voices · email support",
    summaryAr: "٥٠٠ تدخّل · منظمة واحدة · أصوات عربية وإنجليزية · دعم بالبريد الإلكتروني",
    includes: [
      "500 intervention signals per month",
      "One organization, browser-based Command Center",
      "One named seat",
      "Sealed audit chain with hash-linked evidence",
      "Arabic and English voice agents",
      "Email support",
    ],
    includesAr: [
      "٥٠٠ إشارة تدخّل شهرياً",
      "منظمة واحدة، ومركز تشغيل عبر المتصفح",
      "مقعد واحد مسمّى",
      "سجل تدقيق مختوم بأدلة مترابطة بالتجزئة",
      "وكلاء صوتيون بالعربية والإنجليزية",
      "دعم عبر البريد الإلكتروني",
    ],
    featured: false,
    publiclyPriced: true,
    offer: {
      description:
        "500 outbound interventions per month for one organization, Arabic and English voice agents, sealed audit chain and email support.",
      price: "2500",
      priceCurrency: PRICE_CURRENCY,
      availability: "https://schema.org/InStock",
    },
  },
  {
    id: "growth",
    name: "Growth",
    nameAr: "النمو",
    monthlyUsd: 9000,
    yearlyUsd: 90000,
    includedPerMonth: 2500,
    overageCents: 350,
    seats: 5,
    tagline: "For mid-market banks and insurers running live fraud desks.",
    taglineAr: "للبنوك وشركات التأمين متوسطة الحجم التي تدير مكاتب احتيال حيّة.",
    summary: "2,500 interventions · multi-tenant · BYOK · priority support",
    summaryAr: "٢٬٥٠٠ تدخّل · تعدد المستأجرين · مفاتيح خاصة · دعم ذو أولوية",
    includes: [
      "2,500 intervention signals per month",
      "Multi-tenant organization support",
      "Five named seats",
      "Signed webhooks with replay protection",
      "Bring your own ElevenLabs key (BYOK)",
      "Guardrail policy configurable per institution",
      "Priority support",
    ],
    includesAr: [
      "٢٬٥٠٠ إشارة تدخّل شهرياً",
      "دعم تعدد المستأجرين",
      "خمسة مقاعد مسماة",
      "ويب هوكس موقّعة مع حماية من إعادة الإرسال",
      "استخدام مفتاح ElevenLabs الخاص بك (BYOK)",
      "سياسة ضوابط قابلة للتهيئة لكل مؤسسة",
      "دعم ذو أولوية",
    ],
    featured: true,
    publiclyPriced: true,
    offer: {
      description:
        "2,500 outbound interventions per month, multi-tenant organizations, signed webhooks, BYOK, per-institution guardrail policy and priority support.",
      price: "9000",
      priceCurrency: PRICE_CURRENCY,
      availability: "https://schema.org/InStock",
    },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    nameAr: "المؤسسات",
    monthlyUsd: 25000,
    yearlyUsd: 250000,
    includedPerMonth: 10000,
    // A POSTED rate now, not a negotiated one: $2.25 per intervention beyond
    // the included volume, with the telephony leg passed through at cost + 10%
    // on Twilio routes (or the bank brings its own trunk). The previous `null`
    // meant "negotiated", which meant the rater REFUSED to invoice Enterprise
    // overage at all — a missing invoice is recoverable, but a rate that
    // cannot be rated is a ceiling nobody can price against.
    overageCents: 225,
    seats: null,
    // NOT `salesAssisted`: Enterprise KEEPS its Paddle product, because an
    // invoiced tenant's commercial plan has to resolve from somewhere, and
    // `Organization.planTier` is the ABUSE tier vocabulary — it cannot carry
    // a plan id. Dropping the Paddle product would leave every Enterprise
    // tenant with no published allowance and no seat cap.
    //
    // The COMMERCIAL route is still invoicing: Paddle's ~5% + $0.50 on a
    // $25,000 monthly line is real money, and the commercial model says
    // Enterprise is invoiced directly. That is a decision taken in the order
    // form; the catalog entry is what keeps the tenant's plan resolvable.
    //
    // The price-key scheme is what made that possible, and it is
    // INTERVAL-AWARE for exactly this reason. A key encodes the amount
    // (`usd_<minor units>`), and Starter's annual price is $2,500 x 10 =
    // $25,000 — the same amount as Enterprise's monthly price. Resolving a
    // plan from the amount ALONE made one key name two plans, and a Starter
    // ANNUAL subscriber would have been rated as Enterprise. The key's
    // interval (`_month` / `_year`) disambiguates them; see
    // `src/lib/payments/plans.ts`.
    tagline: "For Tier-1 UAE banks deploying inside their own perimeter.",
    taglineAr: "للبنوك من الفئة الأولى في الإمارات التي تنشر داخل محيطها الخاص.",
    summary: "10,000 interventions · in-VPC or data centre · custom beyond",
    summaryAr: "١٠٬٠٠٠ تدخّل · نشر داخلي · تسعير مخصص لما يزيد",
    includes: [
      "10,000 intervention signals per month, custom volume pricing beyond",
      "Unlimited named seats",
      "Deploys inside your own VPC or data centre",
      "Dedicated deployment for the WebSocket voice plane",
      "Shariah-compliant terminology engine",
      /**
       * Was "Takaful and insurer-specific voice policies".
       *
       * That bullet claimed a paid feature the code does not gate: the entire
       * `Entitlement` catalogue is `byok | signedWebhooks`
       * (src/lib/billing/entitlements.ts), and
       * `src/lib/billing/entitlements.ts` deliberately does NOT gate
       * `institutionType` — with the stated reason that gating it "would make a
       * Starter insurer be spoken to with banking language, which is a compliance
       * posture the platform needs to get right for every tenant that pays
       * anything at all."
       *
       * So a Starter insurer gets insurer voice anyway, and the card was false in
       * the direction that matters commercially: a plan that lists something under
       * Enterprise is a statement about what the cheaper plans do not include, and
       * here the statement was untrue. The entitlements module's own docstring
       * names this exact defect as the reason it exists.
       *
       * Replaced with the thing Enterprise genuinely is: bespoke terminology per
       * tenant, which is true, and is a real reason to upgrade.
       */
      "Bespoke terminology per product line, configured with you",
      "Named technical contact",
    ],
    includesAr: [
      "١٠٬٠٠٠ إشارة تدخّل شهرياً، وتسعير حجم مخصص لما يزيد",
      "مقاعد مسماة بلا حد",
      "النشر داخل شبكتك الافتراضية الخاصة أو مركز بياناتك",
      "نشر مخصص لمستوى الصوت عبر WebSocket",
      "محرك مصطلحات متوافق مع الشريعة",
      "سياسات صوتية خاصة بالتكافل وشركات التأمين",
      "جهة اتصال فنية مسمّاة",
    ],
    featured: false,
    // The price is real and billed — the catalog still carries it and parity
    // still holds. It is simply not printed. See `publiclyPriced`.
    publiclyPriced: false,
    offer: {
      description:
        "10,000 outbound interventions per month with custom volume pricing beyond, deployed inside your own VPC or data centre, with a Shariah-compliant terminology engine and takaful voice policies.",
      priceCurrency: PRICE_CURRENCY,
      availability: "https://schema.org/InStock",
    },
  },
];

/** Currency-formatting helper so no renderer re-implements `Intl` by hand. */
export function formatMonthly(plan: Plan, lang: Lang = "en"): string {
  // Two different reasons to withhold the figure, and they render identically on
  // purpose: the tier is negotiated, or the tier is priced but not published.
  if (plan.monthlyUsd === null || !plan.publiclyPriced) {
    return lang === "ar" ? "حسب الطلب" : "Custom";
  }
  return new Intl.NumberFormat(lang === "ar" ? "ar-AE" : "en-US", {
    style: "currency",
    currency: PRICE_CURRENCY,
    maximumFractionDigits: 0,
  }).format(plan.monthlyUsd);
}

/** Included interventions, or "" where the plan is negotiable rather than tiered. */
/** Annual price, or "" where none is published. */
export function formatYearly(plan: Plan, lang: Lang = "en"): string {
  // Must move with `formatMonthly`: printing "Custom" for the month and the
  // real annual number beneath it would publish the very figure the month hid.
  if (plan.yearlyUsd === null || !plan.publiclyPriced) return "";
  return new Intl.NumberFormat(lang === "ar" ? "ar-AE" : "en-US", {
    style: "currency",
    currency: PRICE_CURRENCY,
    maximumFractionDigits: 0,
  }).format(plan.yearlyUsd);
}

export function formatIncluded(plan: Plan, lang: Lang = "en"): string {
  if (plan.includedPerMonth === null) return "";
  return plan.includedPerMonth.toLocaleString(lang === "ar" ? "ar-AE" : "en-US");
}

/** Per-intervention overage, or "" where it is negotiated. */
export function formatOverage(plan: Plan, lang: Lang = "en"): string {
  if (plan.overageCents === null) return "";
  return new Intl.NumberFormat(lang === "ar" ? "ar-AE" : "en-US", {
    style: "currency",
    currency: PRICE_CURRENCY,
    maximumFractionDigits: 2,
  }).format(plan.overageCents / 100);
}

/** A plan by id, or `null` for an id this catalog does not publish. */
export function planById(id: string | null | undefined): Plan | null {
  if (!id) return null;
  return PLANS.find((p) => p.id === id) ?? null;
}

/**
 * The seat line for the pricing card.
 *
 * One place formats it so a card can never promise "Unlimited" while
 * `billing/seats.ts` refuses the sixth invitation.
 */
export function formatSeats(plan: Plan, lang: Lang = "en"): string {
  if (plan.seats === null) return lang === "ar" ? "مقاعد بلا حد" : "Unlimited seats";
  if (plan.seats === 1) return lang === "ar" ? "مقعد واحد" : "1 seat";
  return lang === "ar" ? `${plan.seats} مقاعد` : `${plan.seats} seats`;
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
    a: "SecureVoice AI puts every flagged case on a 60-second deadline the platform sets for itself (configurable as `SLA_SECONDS`) — a deadline for starting the call, not a measured time-to-contact, which the platform does not publish because it has never sampled one. On that call the agent verifies the customer's identity, explains what triggered the alert, stages a card freeze or a transfer hold for the bank's own fraud team to commit — it never commits one itself — and hands off to a human specialist. It currently runs against UAE banks, in Arabic and English.",
    aAr: "تضع SecureVoice AI كلَّ تنبيه ضمن مهلةٍ داخليةٍ مدتها ٦٠ ثانية تضبطها المنصة لنفسها، وهي مهلةٌ لبدء المكالمة لا قياسٌ لزمن الوصول إليها — فالمنصة لا تعلن أي رقمٍ لزمن الوصول لأنها لم تَقِسْه بعد. خلال المهلة يتصل الوكيل الصوتي بالعميل، ويتحقق من هويته، ويشرح سبب التنبيه، ويمهّد لتجميد البطاقة أو إيقاف التحويل ليُقرّره فريق البنك نفسه — لا تُنفّذ المنصة أيَّ إجراءٍ وحدها — ثم تحيل الأمر إلى أخصائي بشري عند الحاجة. وتعمل المنصة حاليًا مع البنوك في دولة الإمارات، بالعربية والإنجليزية.",
  },
  {
    q: "How much does SecureVoice AI cost?",
    qAr: "كم تكلفة منصة SecureVoice AI؟",
    a: "We price the intervention, not the minute. A Pilot is $12,000 for 90 days and includes 2,000 intervention signals, with $5.00 per intervention beyond that; 50% of the pilot fee is credited toward your first annual contract. Starter is $2,500 per month and includes 500 interventions, at $4.50 each beyond. Growth is $9,000 per month and includes 2,500, at $3.50 each beyond. Enterprise is priced to your deployment and includes 10,000, with volume beyond that quoted to you. Each tier is one organization's deployed footprint; the Enterprise tier deploys inside your own VPC or data centre, and for Tier-1 banks we negotiate an annual rate that reduces the per-intervention overage.",
    aAr: "نُسعِّر التدخّل لا الدقيقة. تبدأ تجربة مدتها تسعون يوماً بسعر ١٢٬٠٠٠ دولار وتشمل ٢٬٠٠٠ إشارة تدخّل، مقابل ٥٫٠٠ دولار لكل تدخّل إضافي، ويُضاف نصف رسوم التجربة إلى عقدك السنوي الأول. و«البداية» ٢٬٥٠٠ دولار شهرياً وتشمل ٥٠٠ تدخّل، مقابل ٤٫٥٠ دولار لكل إضافي. و«النمو» ٩٬٠٠٠ دولار شهرياً وتشمل ٢٬٥٠٠، مقابل ٣٫٥٠ دولار لكل إضافي. و«المؤسسات» تُسعَّر حسب نشركم وتشمل ١٠٬٠٠٠، ويُسعَّر ما يزيد حسب حجمكم. وكل طبقة تمثّل نطاق مؤسسة واحدة منشورة؛ وتُنشر طبقة «المؤسسات» داخل شبكتكم الخاصة أو مركز بياناتكم، ولبنوك الفئة الأولى نتفاوض على سعر سنوي يخفض رسوم التدخّل الإضافي.",
  },
  {
    q: "Is there a free trial, a monthly-only option, or a discount for paying yearly?",
    qAr: "هل هناك فترة تجريبية، أو اشتراك شهري فقط، أو خصم عند الدفع سنوياً؟",
    a: "There is no free tier: every plan starts with a paid engagement, and the Pilot is the smallest one — 90 days, one alert type, written success criteria, and a shadow run before a single customer is contacted. Starter and Growth are available monthly or annually, and paying annually takes two months off the monthly rate. Enterprise is sold on an annual term, 12 months minimum, and 24 months for a deployment inside your own perimeter. For a pilot evaluation we run the Pilot tier, so a bank can prove the end-to-end loop on a live risk signal before committing to volume.",
    aAr: "لا توجد طبقة مجانية: تبدأ كل الخطط بعقد مدفوع، وأصغرها «التجربة» — تسعون يوماً، ونوع تنبيه واحد، ومعايير نجاح مكتوبة، وتشغيل في وضع الظل قبل الاتصال بأي عميل. وتتوفر «البداية» و«النمو» شهرياً أو سنوياً، والدفع سنوياً يعادل شهرين مجاناً. وتُباع «المؤسسات» بعقد سنوي بحد أدنى اثني عشر شهراً، وأربعة وعشرين شهراً للنشر داخل محيطكم. وللتجربة الميدانية نبدأ بطبقة «التجربة» ليُثبت البنك الحلقة الصوتية على إشارة خطر حقيقية قبل الالتزام بحجم.",
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
