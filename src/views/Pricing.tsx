"use client";

import { motion } from "framer-motion";
import { Check, ShieldCheck, Sparkles, Building2 } from "lucide-react";
import { useApp, t } from "@/lib/store";
import { SUPPORT_EMAIL } from "@/lib/public-config";

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
const aed = (usd: number): string =>
  `AED ${Math.round(usd * USD_TO_AED).toLocaleString("en-US")}`;

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
      { en: "One organisation, browser-based Command Center", ar: "منظمة واحدة، مركز تشغيل عبر المتصفح" },
      { en: "Sealed audit chain with hash-linked evidence", ar: "سلسلة تدقيق مختومة بدليل مترابط بالتجزئة" },
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
      { en: "Signed webhooks with replay protection", ar: "ويب هوoks موقّعة مع حماية من إعادة الإرسال" },
      { en: "Bring your own ElevenLabs key (BYOK)", ar: "استخدام مفتاح ElevenLabs الخاص بك" },
      { en: "Guardrail policy configurable per institution", ar: "سياسة الضوابط قابلة للتهيئة لكل مؤسسة" },
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
      { en: "10,000 interventions included, custom volume pricing beyond", ar: "10,000 تدخل مشمول، وتسعير volumes مخصص لما يزيد" },
      {
        en: "Deploys inside your own VPC or data centre",
        ar: "النشر داخل شبكتك الخاصة أو مركز بياناتك",
      },
      { en: "Dedicated deployment for the WebSocket voice plane", ar: "نشر مخصص لمستوى الصوت عبر WebSocket" },
      { en: "Shariah-compliant terminology engine", ar: "محرك مصطلحات متوافق مع الشريعة" },
      { en: "Takaful and insurer-specific voice policies", ar: "سياسات صوتية خاصة بالتأمين والتكافل" },
      { en: "Named technical contact", ar: "جهة اتصال فنية مخصصة" },
    ],
  },
];

/**
 * Refund policy for the DEMO environment.
 *
 * Deliberately says there are no refunds, and explains why: no payment is ever
 * processed, so there is nothing to refund. A demo page that hedges ("refunds
 * subject to policy") implies a charge that does not exist.
 */
function DemoPolicy({ lang }: { lang: "en" | "ar" }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <h3 className="font-display text-lg font-semibold text-white">
        {t("Demo evaluation policy", "سياسة التقييم التجريبي", lang)}
      </h3>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
        {t(
          "The SecureVoice demo environment is provided free of charge strictly for evaluation, testing and product demonstration. No financial transaction, card charge or billing cycle occurs within it. All intervention data, transcripts and audio in the demo are synthetic. Because no payment is processed, there is nothing to refund and no chargeback can arise. Use of the demo is governed by the Terms of Service and the Acceptable Use rules on this site.",
          "تُقدَّم بيئة العرض التجريبية مجاناً و solely لأغراض التقييم والاختبار وعرض المنتج. لا تتم أي معاملة مالية أو خصم بطاقة أو دورة فوترة داخلها. جميع بيانات التدخلات والنصوص المحوَّلة والتسجيلات الصوتية في العرض تركيبية. ولأن أي عملية دفع لا تحدث، فلا يوجد ما يُسترد ولا يمكن أن ينشأ أي استرداد. يخضع استخدام العرض للشروط والأحكام وقواعد الاستخدام المقبول في هذا الموقع.",
          lang,
        )}
      </p>
    </section>
  );
}

/**
 * Refund / credit policy for paying customers on the credit wallet.
 *
 * This one is a real commercial commitment, which is why each clause is
 * specific enough to be enforceable: a generic "refunds at our discretion" would
 * not survive a procurement conversation, and vagueness here reads as a red flag
 * rather than as flexibility.
 */
function CreditWalletPolicy({ lang }: { lang: "en" | "ar" }) {
  const clauses = [
    {
      en: "Credit purchases. The platform runs on a prepaid Credit Wallet. One credit funds one intervention signal. Purchased credits are non-refundable and unused credits expire 12 months from the date of purchase.",
      ar: "شراء الرصيد. تعمل المنصة على محفظة ائتمان مدفوعة مسبقاً. رصيد واحد يغطي إشارة تدخل واحدة. الأرصدة المشتراة غير قابلة للاسترداد، وتنتهي صلاحية الرصيد غير المستخدم بعد 12 شهراً من تاريخ الشراء.",
    },
    {
      en: "Failed interventions. If an intervention fails to connect, or terminates because of a SecureVoice infrastructure fault — not a carrier block, a network failure at the customer's end, or the customer being unreachable — the credit consumed by that intervention is returned to the wallet automatically within 48 hours.",
      ar: "التدخلات الفاشلة. إذا فشل تدخل في الاتصال أو انقطع بسبب خلل في بنية SecureVoice — لا بسبب حجب من مشغّل الاتصالات، ولا انقطاع في شبكة العميل، ولا تعذّر الوصول إلى العميل — يُعاد الرصيد المستهلك في هذا التدخل إلى المحفظة تلقائياً خلال 48 ساعة.",
    },
    {
      en: "Service level credits. Where an Enterprise agreement carries an availability commitment and that commitment is missed in a calendar month, service credits are issued as a wallet top-up rather than a cash refund, sized as (downtime minutes ÷ total minutes in the month) × the monthly platform fee. The measured figure is taken from the platform's own health endpoint, not from a customer report.",
      ar: "أرصدة مستوى الخدمة. في Agreements المؤسساتية التي تتضمن التزام توافر ولم يُحقق في شهر ميلادي، تُصدر أرصدة خدمة ك recharge للمحفظة بدلاً من استرداد نقدي، وحجمها يساوي (دقائق التوقف ÷ إجمالي دقائق الشهر) × الرسوم الشهرية للمنصة. ويُؤخذ القياس من نقطة صحة المنصة نفسها، لا من تقرير العميل.",
    },
    {
      en: "Chargebacks. Opening a card chargeback against a valid credit purchase suspends API access and webhook routing until the chargeback is resolved, because the underlying intervention may still be consuming metered capacity.",
      ar: "الاستردادات البنكية. فتح استرداد بنكي على عملية شراء رصيد سارية يوقف الوصول إلى API وتوجيه الويب هوoks حتى تسوية الاسترداد، لأن التدخل المرتبط قد يستهلك سعة مقيسة 계속.",
    },
  ];

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <h3 className="font-display text-lg font-semibold text-white">
        {t("Credit wallet & service credit policy", "سياسة محفظة الرصيد وأرصدة الخدمة", lang)}
      </h3>
      <ol className="mt-4 space-y-3">
        {clauses.map((c, i) => (
          <li key={i} className="flex gap-3 text-[13px] leading-relaxed text-ink-3">
            <span className="mt-0.5 font-mono text-[11px] text-green-bright">{i + 1}.</span>
            <span>{c[lang]}</span>
          </li>
        ))}
      </ol>
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
                <span className="text-[13px] text-ink-3">
                  {t("per month", "شهرياً", lang)}
                </span>
              </div>
              <p className="mt-1 text-[12px] text-ink-3/70">{aed(tier.usd)}</p>

              <div className="mt-5 border-t border-white/10 pt-4">
                <p className="text-[13px] font-semibold text-green-bright">
                  {tier.included.toLocaleString("en-US")}{" "}
                  {t("interventions included", "تدخل مشمول", lang)}
                </p>
                <p className="mt-1 text-[12px] text-ink-3">
                  {tier.overage ? (
                    tier.overage[lang]
                  ) : (
                    t(
                      "Volume pricing beyond that",
                      "تسعير كميات لما يزيد",
                      lang,
                    )
                  )}
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
          <DemoPolicy lang={lang} />
          <CreditWalletPolicy lang={lang} />
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
