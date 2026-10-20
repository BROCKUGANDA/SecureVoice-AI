"use client";

import { motion } from "framer-motion";
import { Check, Sparkles } from "lucide-react";
import { useApp, t } from "@/lib/store";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { REFUND_POLICIES } from "@/lib/legal-policies";
import { SubscribeButtons } from "@/components/billing/SubscribeButtons";
import { paddlePriceIds } from "@/lib/paddle-browser";
import { PLANS, formatIncluded, formatMonthly, formatOveragePhrase } from "@/lib/commercial";
import type { Lang } from "@/lib/store";

/**
 * Paddle price ids per tier, from the environment.
 *
 * Both intervals exist for every tier — `tests/billing/catalog-parity.test.ts`
 * asserts the ids, the 10x annual ratio, and that `src/lib/commercial.ts`
 * carries the same figures.
 *
 * These were previously a hardcoded `Record` of SANDBOX `pri_…` literals. A
 * price id is environment-specific by definition — a sandbox id does not exist
 * in the live catalog — so a hardcoded value could only ever be right in one
 * environment and wrong in the other. `paddlePriceIds()` reads them from
 * `NEXT_PUBLIC_PADDLE_PRICES` and THROWS when unset: the pricing page is where a
 * customer is about to see a Buy button, and a Buy button wired to nothing is a
 * worse failure than a page that refuses to render one.
 *
 * The throw is CAUGHT here rather than let to escape module scope: a raw throw
 * at module init takes the ENTIRE pricing page down — including the policies
 * and the tier copy, which never touch checkout. A misconfigured build should
 * render the page with checkout honestly marked unavailable (SubscribeButtons
 * already handles null ids), not hand every visitor a blank route. The console
 * error still names the exact env var — the operator is its audience, not the
 * visitor.
 */
const PADDLE_PRICE_ID: ReturnType<typeof paddlePriceIds> | null = (() => {
  try {
    return paddlePriceIds();
  } catch (err) {
    console.error("[pricing] checkout is not configured for this build", err);
    return null;
  }
})();

/**
 * Public pricing, and the two refund policies the business actually needs.
 *
 * WHY TWO POLICIES: they govern different worlds and merging them would be a lie
 * in one direction or the other.
 *
 *   The DEMO environment takes no money. There is no card, no charge and no
 *   chargeback, so a "refund policy" describing refunds would describe a
 *   transaction that cannot happen. It says so plainly instead.
 *
 *   The CREDIT WALLET is the real commercial surface. Credits are prepaid, an
 *   intervention consumes one, and the questions a bank actually asks are
 *   "what if the call failed" and "what if you missed your SLA". Those get real
 *   answers.
 *
 * CURRENCY: prices are stated in USD with the AED equivalent alongside. The AED
 * figure is not decoration — the buyer this product is written for budgets in
 * dirhams (see docs/canvas-build/content.json: "AED 15,000 a month on voice
 * intervention against AED 200,000 a month of write-offs"), and a page that
 * quotes only dollars makes them do the conversion at a moment when they are
 * deciding whether to trust the number.
 *
 * FIXED RATE, not a live FX feed: 1 USD = 3.6725 AED, the standard peg.
 */

/** One intervention signal fired = one credit. Mirrors src/lib/credits.ts. */
const USD_TO_AED = 3.6725;
/**
 * The AED reference figure, formatted for the reader's language.
 *
 * The locale is the reader's, not a hardcoded one: `ar-AE` is what the
 * catalog's own formatters use, and a figure that disagrees with the price
 * above it is a figure nobody trusts.
 */
const aed = (usd: number, lang: Lang): string =>
  `AED ${Math.round(usd * USD_TO_AED).toLocaleString(lang === "ar" ? "ar-AE" : "en-US")}`;

type Tier = {
  id: "pilot" | "starter" | "growth" | "enterprise";
  name: { en: string; ar: string };
  blurb: { en: string; ar: string };
  usd: number;
  /**
   * Whether the figure is PRINTED. Mirrors `Plan.publiclyPriced` in
   * src/lib/commercial.ts — see that field for why a tier can carry a real,
   * billed price that this page chooses not to show. Absent means shown.
   *
   * This file keeps its own `TIERS` rather than rendering `PLANS`, which is a
   * second source of truth for the same numbers; tests/unit/tier-parity.test.ts
   * exists to keep the two from drifting.
   */
  publiclyPriced?: boolean;
  /**
   * A ONE-OFF engagement rather than a subscription.
   *
   * The Pilot is ninety days, bought once, invoiced — not a monthly plan that
   * renews. Rendering it with "/mo" would tell a bank it is a subscription, and
   * a bank that discovers that in month two does not renew.
   */
  oneOff?: boolean;
  included: number;
  overage: { en: string; ar: string } | null;
  features: { en: string; ar: string }[];
  featured?: boolean;
};

const TIERS: Tier[] = [
  {
    id: "pilot",
    name: { en: "Pilot", ar: "التجربة" },
    blurb: {
      en: "Ninety days, one alert type, written success criteria.",
      ar: "تسعون يوماً، ونوع تنبيه واحد، ومعايير نجاح مكتوبة.",
    },
    usd: 12000,
    oneOff: true,
    included: 2000,
    overage: {
      en: "$5.00 per additional intervention",
      ar: "٥٫٠٠ دولار لكل تدخل إضافي",
    },
    features: [
      {
        en: "2,000 intervention signals over 90 days",
        ar: "٢٬٠٠٠ إشارة تدخّل خلال ٩٠ يوماً",
      },
      {
        en: "Shadow run first: cases recorded, no customer contacted",
        ar: "يبدأ بوضع الظل: تُسجَّل الحالات دون الاتصال بأي عميل",
      },
      {
        en: "One named pilot owner and a written success criteria sheet",
        ar: "مالك تجربة واحد مسمّى وورقة معايير نجاح مكتوبة",
      },
      {
        en: "Daily review of contact rate, containment and complaints",
        ar: "مراجعة يومية لمعدل الاتصال ونسبة الاحتواء والشكاوى",
      },
      {
        en: "50% of the pilot fee credited toward your first annual contract",
        ar: "يُضاف نصف رسوم التجربة إلى عقدك السنوي الأول",
      },
    ],
  },
  {
    id: "starter",
    name: { en: "Starter", ar: "الانطلاق" },
    blurb: {
      en: "For evaluation teams proving the voice loop end to end.",
      ar: "للفرق التقييمية التي تُثبت الحلقة الصوتية من طرف إلى طرف.",
    },
    usd: 2500,
    included: 500,
    overage: {
      en: "$4.50 per additional intervention",
      ar: "٤٫٥٠ دولار لكل تدخل إضافي",
    },
    features: [
      { en: "500 interventions included per month", ar: "500 تدخل مشمول شهرياً" },
      {
        en: "One organisation, browser-based Command Center",
        ar: "منظمة واحدة، مركز تشغيل عبر المتصفح",
      },
      {
        en: "Sealed audit chain with hash-linked evidence",
        ar: "سلسلة تدقيق مختومة بدليل مترابط بالتجزئة",
      },
      { en: "Arabic and English voice agents", ar: "وكلاء صوتيون بالعربية والإنجليزية" },
      { en: "Email support", ar: "دعم عبر البريد الإلكتروني" },
    ],
  },
  {
    id: "growth",
    name: { en: "Growth", ar: "النمو" },
    blurb: {
      en: "For mid-market banks and insurers running live fraud desks.",
      ar: "للبنوك وشركات التأمين متوسطة الحجم التي تدير مكاتب احتيال حية.",
    },
    usd: 9000,
    included: 2500,
    overage: {
      en: "$3.50 per additional intervention",
      ar: "٣٫٥٠ دولار لكل تدخل إضافي",
    },
    featured: true,
    features: [
      { en: "2,500 interventions included per month", ar: "2,500 تدخل مشمول شهرياً" },
      { en: "Multi-tenant organisation support", ar: "دعم تعدد المنظمات" },
      {
        en: "Signed webhooks with replay protection",
        ar: "ويب هوoks موقّعة مع حماية من إعادة الإرسال",
      },
      { en: "Bring your own ElevenLabs key (BYOK)", ar: "استخدام مفتاح ElevenLabs الخاص بك" },
      {
        en: "Guardrail policy configurable per institution",
        ar: "سياسة الضوابط قابلة للتهيئة لكل مؤسسة",
      },
      { en: "Priority support", ar: "دعم ذو أولوية" },
    ],
  },
  {
    id: "enterprise",
    name: { en: "Enterprise", ar: "المؤسسات" },
    blurb: {
      en: "For Tier-1 UAE banks deploying inside their own perimeter.",
      ar: "للبنوك من الفئة الأولى في الإمارات التي تنشر داخل محيطها الخاص.",
    },
    usd: 25000,
    // The price is real — Paddle still charges it and the catalog parity test
    // still holds. It is simply not printed. See `publiclyPriced`.
    publiclyPriced: false,
    included: 10000,
    overage: {
      en: "$2.25 per additional intervention, plus telephony at cost + 10%",
      ar: "٢٫٢٥ دولار لكل تدخل إضافي، إضافة إلى قيمة الاتصال بتكلفة زائد ١٠٪",
    },
    features: [
      {
        en: "10,000 interventions included, custom volume pricing beyond",
        ar: "10,000 تدخل مشمول، وتسعير حجم مخصص لما يزيد",
      },
      {
        en: "Deploys inside your own VPC or data centre",
        ar: "النشر داخل شبكتك الخاصة أو مركز بياناتك",
      },
      {
        en: "Dedicated deployment for the WebSocket voice plane",
        ar: "نشر مخصص لمستوى الصوت عبر WebSocket",
      },
      { en: "Shariah-compliant terminology engine", ar: "محرك مصطلحات متوافق مع الشريعة" },
      {
        // Was "Takaful and insurer-specific voice policies" — a bullet with no
        // entitlement behind it. Every tenant gets insurer-appropriate terminology
        // regardless of plan, because src/lib/billing/entitlements.ts refuses to
        // gate institutionType on purpose: speaking to an insurer with banking
        // language is a compliance defect, not a downgrade. Listing it as paid was
        // false in the direction that matters — a plan's bullet list is a
        // statement about what the cheaper plans do NOT include.
        en: "Bespoke terminology per product line, configured with you",
        ar: "مصطلحات مخصّصة لكل خط منتجات، تُعدّ معك",
      },
      { en: "Named technical contact", ar: "جهة اتصال فنية مخصصة" },
    ],
  },
];

/**
 * Renders one of the two refund policies from `src/lib/legal-policies.ts`.
 *
 * These used to be written out IN FULL inside this file — `DemoPolicy` and
 * `CreditWalletPolicy` each carried their own copy of the wording, and
 * `src/views/Legal.tsx` carried a third. The copies disagreed on whether
 * unspent credits are refundable, which is the single fact a customer cares
 * about. `tests/unit/refund-policy-consistency.test.ts` asserts the distinctive
 * phrases do NOT appear in this file as literals, which is what forced the
 * extraction.
 *
 * The page is PUBLIC and carries no session, so it renders BOTH policies side by
 * side rather than choosing one. The conditional form — `planTier` deciding
 * demo vs wallet — belongs where a session exists, not on a public page.
 */
function PolicySection({
  policy,
  lang,
}: {
  policy: { titleEn: string; titleAr: string; clauses: { en: string; ar: string }[] };
  lang: Lang;
}) {
  return (
    <section className="rounded-2xl border border-line bg-secondary p-6">
      <h3 className="font-display text-lg font-semibold text-foreground">
        {t(policy.titleEn, policy.titleAr, lang)}
      </h3>
      <div className="mt-3 space-y-3 text-[13px] leading-relaxed text-ink-3">
        {policy.clauses.map((c) => (
          <p key={c.en}>{c[lang]}</p>
        ))}
      </div>
    </section>
  );
}

/**
 * The public pricing page.
 *
 * `country` and `customerEmail` are passed IN rather than read here. Both come
 * from a session or a request header, and this component renders inside both the
 * public `/pricing` route and the SPA at `/`, where there is no single server
 * boundary to read a header. See `src/app/pricing/page.tsx` for where they come
 * from, and `src/lib/geo.ts` for why an unresolvable country is passed as null
 * rather than a default.
 */
export function Pricing({
  country = null,
  customerEmail,
}: {
  /** ISO-3166-1 alpha-2, or null to let Paddle resolve from the visitor's IP. */
  country?: string | null;
  /** Prefilled when the buyer is signed in. */
  customerEmail?: string;
}) {
  const { lang } = useApp();

  return (
    <div className="relative overflow-y-auto">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="max-w-2xl"
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
            {t("Pricing", "الأسعار", lang)}
          </p>
          <h1 className="mt-3 font-display text-4xl font-semibold text-foreground md:text-5xl">
            {t(
              "Platform fee, then pay for what you use.",
              "رسوم منصة، ثم تدفع مقابل ما تستخدمه.",
              lang,
            )}
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-ink-3">
            {t(
              "Every plan includes the full intervention pipeline — the voice agent, the guardrail gates, and the sealed audit chain. What changes is volume, tenancy, and where it runs.",
              "كل خطة تشمل خط التدخل الكامل — الوكيل الصوتي، وبوابات الضوابط، وسلسلة التدقيق المختومة. ما يتغيّر هو الحجم، وتعدد المنظمات، ومكان التشغيل.",
              lang,
            )}
          </p>
          <p className="mt-2 text-[12.5px] text-ink-3/80">
            {t(
              "One credit = one intervention signal fired — the metered telephony and voice cost that actually scales with your alert volume.",
              "رصيد واحد = إشارة تدخل واحدة — تكلفة الهاتف والصوت المقيسة التي تتناسب فعلياً مع حجم تنبيهاتك.",
              lang,
            )}
          </p>
        </motion.div>

        {/* tiers */}
        <div className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {TIERS.map((tier, i) => (
            <motion.div
              key={tier.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.06 * i }}
              className={[
                "relative flex flex-col rounded-2xl border p-6",
                tier.featured
                  ? "border-green-bright/40 bg-green-bright/[0.06]"
                  : "border-white/10 bg-white/[0.03]",
              ].join(" ")}
            >
              {tier.featured && (
                <span className="absolute -top-3 left-6 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-green-tint px-3 py-1 text-[10.5px] font-semibold text-primary">
                  <Sparkles className="h-3 w-3" aria-hidden="true" />
                  {t("Most deployed", "الأكثر استخداماً", lang)}
                </span>
              )}

              <h2 className="font-display text-xl font-semibold text-foreground">
                {lang === "ar" ? tier.nameAr : tier.name}
              </h2>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">
                {lang === "ar" ? tier.taglineAr : tier.tagline}
              </p>

              <div className="mt-6 flex items-baseline gap-2">
                <span className="font-display text-4xl font-semibold text-foreground">
                  {/* The catalog's OWN formatter, so the card, the home page and
                      the meta description all render the same figure the same
                      way. It also answers "Custom" for a tier that withholds its
                      price, which is what the card used to spell out by hand. */}
                  {formatMonthly(tier, lang)}
                </span>
                {tier.publiclyPriced !== false && (
                  <span className="text-[13px] text-ink-3">
                    {/* A one-off engagement is not a subscription, and "per month"
                        on the Pilot would be a false statement: it is bought once,
                        for ninety days, and invoiced. */}
                    {tier.oneOff
                      ? t("one-off, 90 days", "لمرة واحدة، ٩٠ يوماً", lang)
                      : t("per month", "شهرياً", lang)}
                  </span>
                )}
              </div>
              {tier.publiclyPriced !== false ? (
                <p className="mt-1 text-[12px] text-ink-3/70">{aed(tier.monthlyUsd ?? 0, lang)}</p>
              ) : (
                // Saying WHY there is no number is the difference between "Custom"
                // reading as a negotiating position and reading as a missing value.
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
                  {t(
                    "Priced to your deployment — intervention volume, named seats, and where it runs.",
                    "تسعير حسب نشرك — حجم التدخلات، والمقاعد المسماة، ومكان التشغيل.",
                    lang,
                  )}
                </p>
              )}

              <div className="mt-5 border-t border-line pt-4">
                <p className="text-[13px] font-semibold text-primary">
                  {formatIncluded(tier, lang)} {t("interventions included", "تدخل مشمول", lang)}
                </p>
                <p className="mt-1 text-[12px] text-ink-3">
                  {tier.overageCents === null
                    ? t("Volume pricing beyond that", "تسعير كميات لما يزيد", lang)
                    : formatOveragePhrase(tier, lang)}
                </p>
              </div>

              <ul className="mt-5 flex-1 space-y-2.5">
                {(lang === "ar" ? tier.includesAr : tier.includes).map((f, j) => (
                  <li key={j} className="flex gap-2.5 text-[12.5px] leading-relaxed text-ink-3">
                    <Check
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              {/* The real checkout. `SubscribeButtons` owns the interval
                    toggle, the localised price preview and the overlay open —
                    all three have to come from Paddle, so none of them live in
                    this view. The ids come from the seeded catalog, matching
                    `src/lib/commercial.ts` and asserted by
                    tests/billing/catalog-parity.test.ts.

                    A contact-sales tier does NOT get this. Its Paddle product
                    still exists and the catalog parity test still holds — but a
                    Buy button next to "Custom" is a contradiction, and a buyer
                    who checks out at a list price is a worse outcome for both
                    sides than a conversation. The product is kept for the sales
                    team to quote from; the page does not offer it.

                    THE PILOT IS ALSO A CONTACT TIER, and for a different reason:
                    it has NO Paddle product at all. A ninety-day engagement,
                    invoiced, with the charter and the success criteria agreed
                    before the first dial — that is a conversation, not a cart.
                    Rendering a Buy button for a plan with no price id behind it
                    would open a checkout that cannot complete. */}
              {tier.publiclyPriced === false || tier.oneOff ? (
                <a
                  href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
                    `SecureVoice ${tier.name.en} — ${tier.included.toLocaleString("en-US")} interventions${
                      tier.oneOff ? " over 90 days" : "/mo"
                    }`,
                  )}`}
                  className="mt-6 inline-flex w-full items-center justify-center rounded-xl border border-primary/40 bg-primary/10 px-5 py-3 text-[13.5px] font-semibold text-primary transition-colors hover:bg-primary/15"
                >
                  {t(tier.oneOff ? "Start a pilot" : "Contact sales", "ابدأ تجربة", lang)}
                </a>
              ) : (
                <SubscribeButtons
                  tier={{
                    id: tier.id,
                    name: lang === "ar" ? tier.nameAr : tier.name,
                    description: lang === "ar" ? tier.taglineAr : tier.tagline,
                    features: lang === "ar" ? tier.includesAr : tier.includes,
                    priceId: {
                      month: PADDLE_PRICE_ID?.[tier.id]?.month ?? null,
                      year: PADDLE_PRICE_ID?.[tier.id]?.year ?? null,
                    },
                  }}
                  country={country}
                  customerEmail={customerEmail}
                />
              )}
            </motion.div>
          ))}
        </div>

        {/* policies */}
        <div className="mt-16 grid gap-5 lg:grid-cols-2">
          <PolicySection policy={REFUND_POLICIES.demo} lang={lang} />
          <PolicySection policy={REFUND_POLICIES.creditWallet} lang={lang} />
        </div>

        <p className="mt-8 text-[12px] text-ink-3/70">
          {t("Questions on billing: ", "استفسارات الفوترة: ", lang)}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline">
            {SUPPORT_EMAIL}
          </a>
        </p>
      </div>
    </div>
  );
}

export default Pricing;
