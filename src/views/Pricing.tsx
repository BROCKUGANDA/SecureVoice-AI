"use client";

import { motion } from "framer-motion";
import { Check, ShieldCheck, Sparkles, Building2 } from "lucide-react";
import { useApp, t } from "@/lib/store";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { REFUND_POLICIES } from "@/lib/legal-policies";

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
const aed = (usd: number): string => `AED ${Math.round(usd * USD_TO_AED).toLocaleString("en-US")}`;

type Tier = {
  id: "starter" | "growth" | "enterprise";
  name: { en: string; ar: string };
  blurb: { en: string; ar: string };
  usd: number;
  included: number;
  overage: { en: string; ar: string } | null;
  features: { en: string; ar: string }[];
  featured?: boolean;
};

const TIERS: Tier[] = [
  {
    id: "starter",
    name: { en: "Starter", ar: "الانطلاق" },
    blurb: {
      en: "For evaluation teams proving the voice loop end to end.",
      ar: "للفرق التقييمية التي تُثبت الحلقة الصوتية من طرف إلى طرف.",
    },
    usd: 99,
    included: 500,
    overage: { en: "$0.15 per additional intervention", ar: "0.15 دولار لكل تدخل إضافي" },
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
    usd: 499,
    included: 2500,
    overage: { en: "$0.12 per additional intervention", ar: "0.12 دولار لكل تدخل إضافي" },
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
    usd: 2000,
    included: 10000,
    overage: null,
    features: [
      {
        en: "10,000 interventions included, custom volume pricing beyond",
        ar: "10,000 تدخل مشمول، وتسعير volumes مخصص لما يزيد",
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
        en: "Takaful and insurer-specific voice policies",
        ar: "سياسات صوتية خاصة بالتأمين والتكافل",
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
  lang: "en" | "ar";
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <h3 className="font-display text-lg font-semibold text-white">
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

export function Pricing() {
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
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-green-bright">
            {t("Pricing", "التسعير", lang)}
          </p>
          <h1 className="mt-3 font-display text-4xl font-semibold text-white md:text-5xl">
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
        <div className="mt-12 grid gap-5 md:grid-cols-3">
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
                <span className="absolute -top-3 left-6 inline-flex items-center gap-1.5 rounded-full border border-green-bright/40 bg-[#0c110e] px-3 py-1 text-[10.5px] font-semibold text-green-bright">
                  <Sparkles className="h-3 w-3" />
                  {t("Most deployed", "الأكثر استخداماً", lang)}
                </span>
              )}

              <h2 className="font-display text-xl font-semibold text-white">{tier.name[lang]}</h2>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">{tier.blurb[lang]}</p>

              <div className="mt-6 flex items-baseline gap-2">
                <span className="font-display text-4xl font-semibold text-white">
                  ${tier.usd.toLocaleString("en-US")}
                </span>
                <span className="text-[13px] text-ink-3">{t("per month", "شهرياً", lang)}</span>
              </div>
              <p className="mt-1 text-[12px] text-ink-3/70">{aed(tier.usd)}</p>

              <div className="mt-5 border-t border-white/10 pt-4">
                <p className="text-[13px] font-semibold text-green-bright">
                  {tier.included.toLocaleString("en-US")}{" "}
                  {t("interventions included", "تدخل مشمول", lang)}
                </p>
                <p className="mt-1 text-[12px] text-ink-3">
                  {tier.overage
                    ? tier.overage[lang]
                    : t("Volume pricing beyond that", "تسعير كميات لما يزيد", lang)}
                </p>
              </div>

              <ul className="mt-5 flex-1 space-y-2.5">
                {tier.features.map((f, j) => (
                  <li key={j} className="flex gap-2.5 text-[12.5px] leading-relaxed text-ink-3">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-bright" />
                    <span>{f[lang]}</span>
                  </li>
                ))}
              </ul>

              <button
                type="button"
                className={[
                  "mt-6 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5",
                  "text-[13px] font-semibold transition",
                  tier.featured
                    ? "bg-green-bright text-ink hover:brightness-110"
                    : "border border-white/15 text-white hover:border-green-bright/50",
                ].join(" ")}
              >
                {tier.id === "enterprise" ? (
                  <Building2 className="h-4 w-4" />
                ) : (
                  <ShieldCheck className="h-4 w-4" />
                )}
                {tier.id === "enterprise"
                  ? t("Talk to us", "تحدّث إلينا", lang)
                  : t("Start with this plan", "ابدأ بهذه الخطة", lang)}
              </button>
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
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-green-bright underline">
            {SUPPORT_EMAIL}
          </a>
        </p>
      </div>
    </div>
  );
}

export default Pricing;
