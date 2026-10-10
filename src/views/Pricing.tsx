"use client";

import { useState } from "react";
import { Check, Minus, Sparkles, Building2, Mail } from "lucide-react";
import { useApp, t } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/fx/core";
import { PLANS, FAQ, SETTLEMENT, formatMonthly, type Plan } from "@/lib/commercial";
import { SUPPORT_EMAIL } from "@/lib/public-config";

/**
 * The pricing page.
 *
 * Rendered in two places: as a panel inside the SPA at `/`, and as the real route
 * `/pricing`. Both render THIS component, so the two can never disagree about
 * what a plan costs — the alternative (a marketing page and a pricing page) is
 * the normal way a site ends up quoting two different numbers.
 *
 * The numbers come from `src/lib/commercial.ts`, which is also what the JSON-LD
 * in src/components/seo/JsonLd.tsx reads. One source, three renderers.
 */
export function Pricing() {
  const { lang, setView } = useApp();
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-16">
      <div className="mx-auto max-w-3xl text-center">
        <p className="micro text-primary">{t("PRICING", "الأسعار", lang)}</p>
        <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          {t("Plans that scale with your card volume", "خطط تنمو مع حجم بطاقاتك", lang)}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          {t(
            "Pay monthly, or a negotiated volume for an enterprise deployment. Every plan — including the cheapest one — ships the tamper-evident audit chain and stores no PIN, OTP or full card number.",
            "ادفع شهرياً، أو اتفق على حجم خاص لنشر مؤسسي. وكل خطة — حتى الأرخص — تشمل سجل التدقيق المقاوم للعبث ولا تخزّن أي رمز سري أو رمز تحقق أو رقم بطاقة كامل.",
            lang,
          )}
        </p>
      </div>

      {/* ——— tiers ——— */}
      <div className="mx-auto mt-12 grid max-w-5xl gap-4 lg:grid-cols-3">
        {PLANS.map((plan, i) => (
          <Reveal key={plan.id} delay={Math.min(i * 0.05, 0.15)}>
            <PlanCard plan={plan} />
          </Reveal>
        ))}
      </div>

      {/* ——— what's included on every plan ——— */}
      <Reveal delay={0.05}>
        <section className="mx-auto mt-16 max-w-5xl">
          <div className="rounded-3xl border border-line bg-white p-7 sm:p-9">
            <div className="flex items-start gap-3">
              <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" strokeWidth={1.7} />
              <div>
                <h2 className="font-display text-[19px] font-semibold tracking-tight">
                  {t("Included with every plan", "مشمول في كل خطة", lang)}
                </h2>
                <p className="mt-1 text-[13px] text-ink-3">
                  {t(
                    "These are not upsells. They are structural: the platform cannot be configured to leave them out.",
                    "هذه ليست إضافات اختيارية. هي بنية أساسية: لا يمكن تهيئة المنصة لتجاهلها.",
                    lang,
                  )}
                </p>
              </div>
            </div>
            <ul className="mt-6 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
              {[
                {
                  en: "Tamper-evident audit chain on every action, with a verifiable hash per event",
                  ar: "سجل تدقيق مقاوم للعبث لكل إجراء، مع بصمة قابلة للتحقق لكل حدث",
                },
                {
                  en: "Speech gate that structurally cannot ask for a PIN, password, OTP or full card number",
                  ar: "بوابة نطق لا تستطيع بنيوياً أن تطلب رمزاً سرياً أو كلمة مرور أو رمز تحقق أو رقم بطاقة كاملاً",
                },
                {
                  en: "Signed webhooks and a two-person commit on every protective action",
                  ar: "خطوات أحداث موقّعة واعتماد من طرفين لكل إجراء وقائي",
                },
                {
                  en: "TLS 1.3 in transit, AES-256 at rest, least-privilege access controls",
                  ar: "تشفير TLS 1.3 أثناء النقل وAES-256 أثناء التخزين وصلاحيات بأقل قدر ممكن",
                },
                {
                  en: "Consent gating and no advertising or profiling use of personal data",
                  ar: "بوابة موافقة وعدم استخدام البيانات الشخصية في الإعلانات أو بناء الملامح",
                },
                {
                  en: "Every intervention call opens with a spoken AI disclosure",
                  ar: "كل مكالمة تدخل تبدأ بإفصاح منطوق بأنها نظام ذكاء اصطناعي",
                },
              ].map((f) => (
                <li
                  key={f.en}
                  className="flex items-start gap-2.5 text-[13px] leading-relaxed text-ink-2"
                >
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" strokeWidth={2.2} />
                  <span>{t(f.en, f.ar, lang)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </Reveal>

      {/* ——— settlement note ——— */}
      <p className="mx-auto mt-6 max-w-3xl text-center text-[12px] leading-relaxed text-ink-3">
        {t(SETTLEMENT.note, SETTLEMENT.note, lang)}
      </p>

      {/* ——— enterprise pricing sheet ——— */}
      <Reveal delay={0.05}>
        <section className="mx-auto mt-16 max-w-5xl" aria-labelledby="enterprise-heading">
          <div className="rounded-3xl border border-line bg-paper p-7 sm:p-9">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="flex items-start gap-3">
                <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" strokeWidth={1.7} />
                <div>
                  <h2
                    id="enterprise-heading"
                    className="font-display text-[19px] font-semibold tracking-tight"
                  >
                    {t("Custom / enterprise pricing", "تسعير المؤسسات والمخصص", lang)}
                  </h2>
                  <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-ink-2">
                    {t(
                      "We do not publish an enterprise rate card, and that is deliberate rather than evasive. The number depends on intervention volume, languages, whether the platform runs in your VPC or ours, and how many bank entities are in scope. You will get a written quote with the assumptions stated, not a multiplier.",
                      "لا ننشر قائمة أسعار مؤسسية، وذلك قرار مقصود لا مراوغة. فالسعر يعتمد على حجم التدخّلات واللغات، وعلى ما إذا كانت المنصة تعمل داخل شبكتكم الخاصة أم داخل شبكتنا، وعلى عدد الجهات المشمولة. وستحصلون على عرض سعر مكتوب مع ذكر الافتراضات، لا على مُضاعِف.",
                      lang,
                    )}
                  </p>
                </div>
              </div>
              <a
                href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Enterprise pricing request")}`}
                className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_6px_18px_-6px_rgba(11,122,85,0.55)] transition hover:bg-green-deep"
              >
                <Mail className="h-4 w-4" />
                {t("Request a quote", "اطلب عرض سعر", lang)}
              </a>
            </div>

            <dl className="mt-7 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2">
              {[
                {
                  k: "What sets the price",
                  kAr: "ما الذي يحدد السعر",
                  v: "Interventions per month · languages in scope · hosting model (our cloud or your VPC) · number of bank entities · SLA tier · BYOK and voice cloning",
                  vAr: "التدخّلات شهرياً · اللغات المشمولة · نموذج الاستضافة (سحابةنا أو شبكتكم الخاصة) · عدد الجهات المصرفية · مستوى اتفاقية الخدمة · المفاتيح الخاصة واستنساخ الصوت",
                },
                {
                  k: "Typical engagement",
                  kAr: "طبيعة العلاقة",
                  v: "A signed Master Services Agreement plus a Data Processing Agreement. The quote references an enterprise rate that is not published on this page, and it takes precedence over the public plans.",
                  vAr: "اتفاقية مستوى خدمة موقّعة مع اتفاقية معالجة بيانات. ويشير عرض السعر إلى سعر مؤسسي غير منشور في هذه الصفحة، ويتقدّم على الخطط العامة.",
                },
                {
                  k: "Included in every enterprise quote",
                  kAr: "مشمول في كل عرض مؤسسي",
                  v: "In-VPC deployment, CBUAE audit pack, named solutions architect, 24/7 escalation, quarterly review of guardrail policy",
                  vAr: "النشر داخل شبكتكم الخاصة، وحزمة تدقيق للمصرف المركزي، ومهندس حلول مُسمّى، وتصعيد على مدار الساعة، ومراجعة فصلية لسياسة الضمانات",
                },
                {
                  k: "How we quote",
                  kAr: "كيف نُقدّم عرض السعر",
                  v: "Written, itemised, with the assumptions stated on the page. If we cannot meet a requirement, we say so in the quote rather than discovering it during delivery.",
                  vAr: "مكتوب ومفصّل، مع ذكر الافتراضات في العرض نفسه. وإذا لم نتمكن من تلبية متطلب، نقول ذلك في العرض لا أن نكتشفه أثناء التنفيذ.",
                },
              ].map((row) => (
                <div key={row.k} className="bg-white p-5">
                  <dt className="text-[12.5px] font-semibold tracking-tight">
                    {t(row.k, row.kAr, lang)}
                  </dt>
                  <dd className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">
                    {t(row.v, row.vAr, lang)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </Reveal>

      {/* ——— comparison table ——— */}
      <Reveal delay={0.05}>
        <section className="mx-auto mt-16 max-w-5xl">
          <h2 className="font-display text-[19px] font-semibold tracking-tight">
            {t("Compare plans", "قارن الخطط", lang)}
          </h2>
          <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-white">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <caption className="sr-only">
                {t(
                  "Feature comparison across the Starter, Pro and Enterprise plans",
                  "مقارنة المزايا بين الخطط البداية والاحترافي والمؤسسات",
                  lang,
                )}
              </caption>
              <thead>
                <tr className="border-b border-line bg-paper">
                  <th
                    scope="col"
                    className="px-4 py-3 text-[11.5px] font-semibold uppercase tracking-wide text-ink-3"
                  >
                    {t("Feature", "الميزة", lang)}
                  </th>
                  {PLANS.map((p) => (
                    <th
                      key={p.id}
                      scope="col"
                      className="px-4 py-3 text-[11.5px] font-semibold uppercase tracking-wide text-ink-3"
                    >
                      {t(p.name, p.nameAr, lang)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    {
                      k: "Interventions per month",
                      kAr: "التدخّلات شهرياً",
                      v: [
                        t("1,000", "١٬٠٠٠", lang),
                        t("5,000", "٥٬٠٠٠", lang),
                        t("Negotiated", "متفاوض عليه", lang),
                      ],
                    },
                    {
                      k: "Bank entities",
                      kAr: "الجهات المصرفية",
                      v: ["1", "5", t("Negotiated", "متفاوض عليه", lang)],
                    },
                    {
                      k: "Languages",
                      kAr: "اللغات",
                      v: ["6", "6", t("6 + custom voices", "٦ + أصوات مخصصة", lang)],
                    },
                    {
                      k: "Streaming voice",
                      kAr: "الصوت المبثوث",
                      v: [false, true, true],
                    },
                    {
                      k: "Priority carrier routing",
                      kAr: "توجيه أولوية عبر المشغّلين",
                      v: [false, true, true],
                    },
                    {
                      k: "Uptime SLA",
                      kAr: "اتفاقية التوافر",
                      v: [t("None", "لا يوجد", lang), "99.9%", "99.9% + credits"],
                    },
                    {
                      k: "Deployment in your own VPC",
                      kAr: "النشر داخل شبكتك الخاصة",
                      v: [false, false, true],
                    },
                    {
                      k: "Bring your own keys (BYOK)",
                      kAr: "مفاتيح خاصة (BYOK)",
                      v: [false, false, true],
                    },
                    {
                      k: "Voice cloning",
                      kAr: "استنساخ الصوت",
                      v: [false, false, true],
                    },
                    {
                      k: "CBUAE audit pack",
                      kAr: "حزمة تدقيق للمصرف المركزي",
                      v: [false, false, true],
                    },
                    {
                      k: "Support",
                      kAr: "الدعم",
                      v: [
                        t("Email, next business day", "بريد إلكتروني، يوم العمل التالي", lang),
                        t("Dedicated channel", "قناة مخصصة", lang),
                        t("24/7 with named architect", "على مدار الساعة مع مهندس مُسمّى", lang),
                      ],
                    },
                  ] as const
                ).map((row) => (
                  <tr key={row.k} className="border-b border-line last:border-0">
                    <th scope="row" className="px-4 py-3 text-left font-medium text-ink-2">
                      {t(row.k, row.kAr, lang)}
                    </th>
                    {row.v.map((cell, ci) => (
                      <td key={ci} className="px-4 py-3 text-ink-2">
                        {typeof cell === "boolean" ? (
                          cell ? (
                            <Check
                              className="h-4 w-4 text-primary"
                              strokeWidth={2.2}
                              aria-label={t("Included", "مشمول", lang)}
                            />
                          ) : (
                            <Minus
                              className="h-4 w-4 text-ink-3"
                              aria-label={t("Not included", "غير مشمول", lang)}
                            />
                          )
                        ) : (
                          cell
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </Reveal>

      {/* ——— FAQ ——— */}
      <Reveal delay={0.05}>
        <section className="mx-auto mt-16 max-w-3xl" aria-labelledby="faq-heading">
          <h2 id="faq-heading" className="font-display text-[19px] font-semibold tracking-tight">
            {t("Questions we get asked first", "الأسئلة الأكثر تكراراً", lang)}
          </h2>
          <div className="mt-5 overflow-hidden rounded-2xl border border-line bg-white">
            {FAQ.map((f, i) => {
              const open = openFaq === i;
              return (
                <div key={f.q} className="border-b border-line last:border-0">
                  <h3>
                    <button
                      onClick={() => setOpenFaq(open ? null : i)}
                      aria-expanded={open}
                      className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-green-tint"
                    >
                      <span className="text-[13.5px] font-semibold tracking-tight">
                        {t(f.q, f.qAr, lang)}
                      </span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "shrink-0 text-[16px] leading-none text-ink-3 transition-transform",
                          open && "rotate-45",
                        )}
                      >
                        +
                      </span>
                    </button>
                  </h3>
                  {open && (
                    <p className="px-5 pb-5 text-[13px] leading-relaxed text-ink-2">
                      {t(f.a, f.aAr, lang)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </Reveal>

      {/* ——— closing CTA ——— */}
      <div className="mx-auto mt-14 max-w-3xl rounded-3xl bg-[#0c110e] px-7 py-9 text-center">
        <h2 className="font-display text-[21px] font-semibold tracking-tight text-white">
          {t("Not sure which tier fits?", "لست متأكداً من الخطة المناسبة؟", lang)}
        </h2>
        <p className="mx-auto mt-2 max-w-lg text-[13.5px] leading-relaxed text-white/60">
          {t(
            "Tell us your monthly card volume and how many bank entities are in scope, and we will tell you which tier you actually need — including when the honest answer is the cheaper one.",
            "أخبرونا بحجم البطاقات الشهري وعدد الجهات المصرفية المشمولة، وسنقول لكم أي خطة تناسب فعلاً — بما في ذلك حين تكون الإجابة الصادقة هي الخطة الأرخص.",
            lang,
          )}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={() => setView("demo")}
            className="rounded-full bg-primary px-6 py-3 text-[13.5px] font-semibold text-white transition hover:bg-green-deep"
          >
            {t("Run the live demo", "شغّل العرض الحي", lang)}
          </button>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="rounded-full border border-white/20 px-6 py-3 text-[13.5px] font-semibold text-white/80 transition hover:border-white/50 hover:text-white"
          >
            {t("Email us", "راسلنا", lang)}
          </a>
        </div>
      </div>
    </div>
  );
}

/* ————————————————— one tier ————————————————— */

function PlanCard({ plan }: { plan: Plan }) {
  const { lang } = useApp();
  const price = formatMonthly(plan, lang);

  return (
    <div
      className={cn(
        "flex h-full flex-col rounded-3xl border p-6",
        plan.featured
          ? "border-emerald-300/80 bg-emerald-50/60 shadow-[0_20px_60px_-30px_rgba(23,166,115,0.25)]"
          : "border-line bg-white",
      )}
    >
      {plan.featured && (
        <span className="micro mb-3 inline-block self-start rounded-full bg-emerald-100 px-2 py-0.5 text-[8.5px] text-emerald-700">
          {t("MOST POPULAR", "الأكثر اختياراً", lang)}
        </span>
      )}
      <h3 className="font-display text-[17px] font-semibold tracking-tight">
        {t(plan.name, plan.nameAr, lang)}
      </h3>
      <p className="mt-1 text-[12px] text-ink-3">{t(plan.tagline, plan.taglineAr, lang)}</p>

      <p className="mt-4">
        <span className="font-display text-[32px] font-semibold leading-none tracking-tight">
          {price}
        </span>
        {plan.monthlyUsd !== null && (
          <span className="ml-1 text-[12.5px] text-ink-3">/{lang === "ar" ? "شهر" : "mo"}</span>
        )}
      </p>
      {plan.monthlyUsd !== null && (
        <p className="mt-1 text-[11px] text-ink-3">
          {t("billed monthly, cancel any time", "فوترة شهرية، يمكن الإلغاء في أي وقت", lang)}
        </p>
      )}

      <ul className="mt-5 space-y-2 border-t border-line pt-5">
        {plan.includes.map((inc, i) => (
          <li
            key={inc}
            className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-ink-2"
          >
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" strokeWidth={2.4} />
            <span>{t(inc, plan.includesAr[i], lang)}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6 pt-1">
        {plan.id === "enterprise" ? (
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Enterprise pricing request")}`}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-full px-5 py-3 text-[13px] font-semibold transition",
              "border border-line bg-paper text-ink-2 hover:border-primary/40 hover:text-primary",
            )}
          >
            <Mail className="h-4 w-4" />
            {t("Contact sales", "تواصل مع المبيعات", lang)}
          </a>
        ) : (
          <button
            onClick={() => useApp.getState().setView("auth")}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-full px-5 py-3 text-[13px] font-semibold transition",
              plan.featured
                ? "bg-primary text-white hover:bg-green-deep"
                : "border border-line bg-paper text-ink-2 hover:border-primary/40 hover:text-primary",
            )}
          >
            {t("Start with this plan", "ابدأ بهذه الخطة", lang)}
          </button>
        )}
      </div>
    </div>
  );
}
