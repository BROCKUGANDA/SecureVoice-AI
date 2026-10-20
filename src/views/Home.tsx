"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  PhoneOutgoing,
  Languages,
  ShieldCheck,
  FileCheck2,
  Play,
  Zap,
  ShieldAlert,
  LayoutDashboard,
  BookOpenText,
  Webhook,
  Lock,
  Fingerprint,
  Snowflake,
  Headset,
  CalendarCheck,
  CheckCircle2,
  HandCoins,
  HeartHandshake,
  Globe2,
  Mic,
} from "lucide-react";
import { useApp, t } from "@/lib/store";
import { PLANS, SETTLEMENT, formatMonthly, formatIncluded, formatOverage } from "@/lib/commercial";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { PanelHeader } from "@/components/ui/PanelHeader";
import { cn } from "@/lib/utils";
import { CALL_LANG_LABEL, type CallLang } from "@/lib/scenario";
import { LiveVoicePanel } from "@/components/demo/LiveVoicePanel";
import { Reveal, Counter, LiveDot, Chip } from "@/components/fx/core";
import { Waveform, Equalizer } from "@/components/fx/Waveform";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

const ELEVEN = [
  { en: "Agent Workflows", ar: "مسارات الوكيل" },
  { en: "Eleven v4 Turbo TTS", ar: "تحويل النص إلى كلام Eleven v4 Turbo" },
  { en: "Scribe v2 Realtime", ar: "التفريغ الفوري Scribe v2" },
  { en: "Knowledge Base + RAG", ar: "قاعدة المعرفة + RAG" },
  { en: "Webhook Tools", ar: "أدوات Webhook" },
  { en: "Twilio Telephony", ar: "الهاتفة Twilio" },
  { en: "Agent Testing", ar: "اختبار الوكيل" },
];

const FEATURES = [
  {
    icon: PhoneOutgoing,
    en: "Immediate multilingual outreach",
    ar: "اتصال فوري متعدد اللغات",
    body: "Every signal becomes a durable dial job the moment it clears the gates; under load a call degrades to SMS or app push rather than being dropped. The 60-second figure is the case deadline the console counts down, not a measured time-to-contact. Streaming neural voice starts mid-render, and customers can interrupt it like a human (barge-in). Six languages in the voice layer: Arabic, English, Hindi, Urdu, French, Kiswahili — the live agent is configured with English, Arabic and Hindi presets.",
  },
  {
    icon: Fingerprint,
    en: "Verified identity, zero secrets",
    ar: "تحقق دون أسرار",
    body: "Bank-approved challenge flows — merchants, amounts, dates. The agent never requests PINs or passwords, so it can never be turned into a phishing tool.",
  },
  {
    icon: Snowflake,
    en: "Pre-approved actions only",
    ar: "إجراءات معتمدة فقط",
    body: "One write action exists in the agent's tool scope: staging the temporary card freeze, which a human specialist then commits. Anything irreversible — replacement, transfer, refund — goes to a human with full context.",
  },
  {
    icon: FileCheck2,
    en: "An audit trail that satisfies CBUAE",
    ar: "سجل تدقيق يلبي أنظمة المصرف المركزي",
    body: "Every call audited and sealed with verification method, actions, and handoff reason into immutable AES-256 storage.",
  },
];

const STEPS = [
  { n: "01", en: "Alert received", ar: "إشارة", d: "HMAC-signed webhook from your engine" },
  { n: "02", en: "Outbound call", ar: "اتصال", d: "Dial job queued; speaks the caller's language" },
  { n: "03", en: "Verification", ar: "التحقق", d: "Challenge flow — no PINs, ever" },
  { n: "04", en: "Card freeze", ar: "تجميد", d: "Staged, pre-approved, committed by a human" },
  { n: "05", en: "Human handoff", ar: "تسليم", d: "Queues with full context if no line bridges" },
];

const TRY_STEPS: {
  n: string;
  icon: typeof Zap;
  en: string;
  ar: string;
  body: string;
  cta: string;
  view: "demo" | "dashboard" | "product";
}[] = [
  {
    n: "01",
    icon: Zap,
    en: "Trigger a live intervention",
    ar: "أطلق تدخلاً حياً",
    body: "Pick one of three fraud cases — card fraud, ATM cash-out, or a wire scam — and fire the alert yourself. The agent calls, verifies, and stages the protective action; a specialist on your side commits it.",
    cta: "Open the live demo",
    view: "demo",
  },
  {
    n: "02",
    icon: LayoutDashboard,
    en: "Operate the console",
    ar: "شغّل لوحة التحكم",
    body: "Monitor active calls, flip the guardrail switches where production policy allows, and search the hash-chained audit log — the same console a bank fraud desk would run. There is no risk-score dial: the score comes from your engine, and the gates that actually refuse a signal are consent, hours, geo, velocity and credit.",
    cta: "Open the dashboard",
    view: "dashboard",
  },
  {
    n: "03",
    icon: BookOpenText,
    en: "Inspect the architecture",
    ar: "افحص البنية",
    body: "The full call flow with guardrail checkpoints, the five-layer stack (ingestion, orchestration, integration, telephony, audit), and the baseline-to-target metrics — stated as targets, because the committed evidence measures the intake path only.",
    cta: "Open the deep dive",
    view: "product",
  },
];

/**
 * The hand-drawn rule under "Freeze staged."
 *
 * Two requirements shaped this, and they pull against each other: it needs to be
 * SUBTLE — this is a wordmark, not a hero flourish, and the previous 0.9s swoosh
 * arrived late enough to read as a separate announcement — while still having
 * VOLUME, because a 2.5px hairline under a 4.2rem headline disappears on a
 * laptop screen and on every non-Retina panel.
 *
 * The way both are satisfied is to stop trading one for the other. Volume comes
 * from the STROKE, not from the motion: a soft wide underlay carries the weight
 * and the crisp line on top carries the edge, so the rule reads as ink rather
 * than as a highlighter. Subtraction comes from the geometry and the timing — a
 * flatter curve, a shorter settle, and a start that overlaps the headline's own
 * reveal instead of trailing it.
 *
 * `MotionConfig reducedMotion="user"` (src/app/page.tsx) neutralises transforms
 * and opacity, but a `pathLength` draw is neither, so the previous version ran
 * its full sweep regardless of the preference. `useReducedMotion` here is what
 * actually honours it: the rule is already drawn, only the drawing is skipped.
 * The affordance survives; the motion does not — the same rule the CSS reduced-
 * motion block in globals.css states for the other effects.
 */
function FreezeStagedUnderline() {
  const reduce = useReducedMotion();
  // Flattened from the previous `M2 6 C 30 1, 80 1, 118 5`: a shallower arc
  // (5.6 → 4.2 control points) so the rule sits under the word instead of
  // bowing through it.
  const d = "M3 5.6 C 34 3.6, 84 3.4, 117 5.2";

  if (reduce) {
    return (
      <svg
        className="absolute -bottom-1 left-0 h-[6px] w-full"
        viewBox="0 0 120 8"
        fill="none"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d={d}
          stroke="#14a374"
          strokeOpacity="0.16"
          strokeWidth="9"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={d}
          stroke="#14a374"
          strokeWidth="3.5"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }

  const settle = { duration: 0.5, delay: 0.42, ease: "easeOut" as const };

  return (
    <svg
      className="absolute -bottom-1 left-0 h-[6px] w-full"
      viewBox="0 0 120 8"
      fill="none"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {/* The underlay: wide and faint. This is the "volume" — it gives the rule
          a soft edge and stops the crisp line above from reading as a wire. */}
      <motion.path
        d={d}
        stroke="#14a374"
        strokeOpacity="0.16"
        strokeWidth="9"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={settle}
      />
      <motion.path
        d={d}
        stroke="#14a374"
        strokeWidth="3.5"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={settle}
      />
    </svg>
  );
}

export function Home() {
  const { setView, lang, launchDemo } = useApp();
  const [pilotOpen, setPilotOpen] = useState(false);
  const [liveLang, setLiveLang] = useState<CallLang>("en");

  return (
    <div>
      {/* ———————————————— HERO ———————————————— */}
      <section className="relative overflow-hidden">
        <div className="sv-grid-bg absolute inset-0" />
        <div
          className="absolute -top-40 right-[-10%] h-[480px] w-[480px] rounded-full opacity-60"
          style={{ background: "radial-gradient(circle, rgba(11,122,85,0.14), transparent 65%)" }}
        />
        <div
          className="absolute bottom-[-30%] left-[-8%] h-[420px] w-[420px] rounded-full opacity-50"
          style={{ background: "radial-gradient(circle, rgba(185,122,17,0.10), transparent 60%)" }}
        />

        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 pb-20 pt-14 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:pb-28 lg:pt-20">
          {/* Left column */}
          <div>
            <Reveal>
              {/*
                The pill used to read "v1.0", and a version number sitting next
                to a pulsing live dot reads as a STATUS — "v1.0 is live". It is
                also the least newsworthy thing on the page: the footer already
                carries "v1.0" twice, and a version number does not move a bank.

                What is news is the pilot programme, so the strip now says what
                the strip is FOR — we are taking the first cohort.

                "Enrolling", and not "live". The pilot has not started with a
                bank: the MSA, the DPA and the LOI are unsigned, the named
                pilot owner is not named, and support hours and the escalation
                path are still TO AGREE (`docs/PILOT-READINESS.md` §2, §3). A
                strip that said "PILOT · LIVE WITH UAE BANKS" would claim a
                deployment that does not exist, on the one surface nobody
                fact-checks. "Now enrolling" is the strongest claim that is
                true, and it matches the Pilot plan the pricing page sells —
                a ninety-day engagement, which is what the old line spent its
                space describing instead.
              */}
              <div className="inline-flex items-center gap-2.5 rounded-full border border-line bg-white py-1.5 pl-2 pr-3.5 shadow-sm">
                <span className="flex h-5 items-center rounded-full bg-green-tint px-2 text-[10px] font-bold uppercase tracking-wider text-green-deep">
                  {t("Pilot", "التجربة", lang)}
                </span>
                <LiveDot />
                <span className="text-[12px] font-medium text-ink-2">
                  {t(
                    "Now enrolling UAE banks & insurers · 90-day engagement",
                    "نستقبل الآن المصارف وشركات التأمين في الإمارات · ٩٠ يوماً",
                    lang,
                  )}
                </span>
              </div>
            </Reveal>

            <Reveal delay={0.1}>
              <h1 className="font-display mt-7 text-[2.6rem] font-semibold leading-[1.04] tracking-tight sm:text-6xl lg:text-[4.2rem]">
                {t("Fraud detected.", "تم كشف احتيال.", lang)}
                <br />
                {t("Call placed.", "تم إجراء المكالمة.", lang)}{" "}
                <span className="relative inline-block text-primary">
                  {t("Freeze staged.", "وتجميد مُمهَّد.", lang)}
                  <FreezeStagedUnderline />
                </span>
                <br />
                {t("Case deadline:", "مهلة الحالة:", lang)} <span className="num">60</span>{" "}
                {t("seconds.", "ثانية.", lang)}
              </h1>
            </Reveal>

            <Reveal delay={0.2}>
              <p dir="rtl" className="font-arabic mt-5 text-[15px] leading-relaxed text-ink-2">
                وكيل صوتي ذكي يتصل بالعميل بلغته ضمن مهلة ستّين ثانية للحالة بعد إشارة الاحتيال —
                يتحقق من هويته، ويؤكد العملية، ويمهّد تجميد البطاقة ليُقرّه أخصائي بشري، ثم يسلمه
                إليه.
              </p>
            </Reveal>
            <Reveal delay={0.26}>
              <p className="mt-4 max-w-xl text-[15.5px] leading-relaxed text-ink-2">
                {t(
                  // The 60-second deadline is the line directly above this one.
                  // Restating it here was the third of five mentions on the page,
                  // and the sentence reads better for the loss being concrete:
                  // "while the loss is still a phone call away" is the argument,
                  // not the clock.
                  "SecureVoice AI closes the gap between fraud detection and fraud intervention for UAE banks and insurers — turning a 38-minute wait into a call placed before the case deadline expires, while the loss is still a phone call away. Call a cardholder about a disputed transaction, or a policyholder about a redirected claim payout: same engine, same guardrails, one human handoff.",
                  "تُغلق SecureVoice AI الفجوة بين كشف الاحتيال والتدخّل فيه لدى المصارف وشركات التأمين في الإمارات — محوّلة انتظار ثمانٍ وثلاثين دقيقة إلى مكالمة تُجرى قبل انتهاء مهلة الحالة، والخسارة ما تزال على بُعد مكالمة هاتف. اتصل بحامل بطاقة حول معاملة متنازع عليها، أو بحامل وثيقة حول دفعة مطالبة أُعيد توجيهها: المحرك والضوابط نفسها، وتسليم واحد إلى موظف بشري.",
                  lang,
                )}
              </p>
            </Reveal>

            <Reveal delay={0.34}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <button
                  onClick={launchDemo}
                  className="group flex items-center gap-2.5 rounded-full bg-primary px-6 py-3 text-[14.5px] font-semibold text-white shadow-[0_10px_26px_-8px_rgba(11,122,85,0.6)] transition hover:bg-green-deep"
                >
                  <Play className="h-4 w-4 fill-current" />
                  {t("Run the live simulation", "شغّل المحاكاة الحية", lang)}
                </button>
                <button
                  onClick={() => setView("dashboard")}
                  className="group flex items-center gap-2 rounded-full border border-line bg-white px-5 py-3 text-[14px] font-semibold text-foreground transition hover:border-primary/50 hover:text-primary"
                >
                  <LayoutDashboard className="h-4 w-4" />
                  {t("Explore the dashboard", "استكشف اللوحة", lang)}
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </button>
              </div>
            </Reveal>

            <Reveal delay={0.38}>
              <p className="mt-4 text-[12.5px] text-ink-3">
                {t("Bank team?", "فريق مصرفي؟", lang)}{" "}
                <button
                  onClick={() => setView("auth")}
                  className="font-semibold text-primary underline decoration-primary/30 underline-offset-2 transition hover:decoration-primary"
                >
                  {t("Sign in to run the platform", "سجّل الدخول لتشغيل المنصة", lang)}
                </button>
                {" — "}
                {t(
                  "real interventions, your own phone, sealed audit trail.",
                  "تدخلات حقيقية على هاتفك، وسجل تدقيق مختوم.",
                  lang,
                )}
              </p>
            </Reveal>

            <Reveal delay={0.42}>
              {/*
                The 60-second deadline is the H1's claim and the lower section's
                subject. It was ALSO here as a stat, a second time in the hero
                paragraph, and a third time as a chip on the voice card — five
                mentions of one number, which is how a page's most important
                number starts to read as a slogan rather than a specification.
                These three carry something the deadline does not.
              */}
              <div className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-3">
                {[
                  {
                    big: "0",
                    label: "PINs, OTPs or passwords requested",
                    ar: "رموز سرية أو كلمات مرور مطلوبة",
                  },
                  { big: "6 langs", label: "in the voice layer", ar: "في طبقة الصوت" },
                  {
                    big: "100%",
                    label: "irreversible actions need a human",
                    ar: "الإجراءات غير القابلة للتراجع تحتاج إنساناً",
                  },
                ].map((s) => (
                  <div key={s.label} className="flex items-baseline gap-2">
                    <span className="num text-[15px] font-semibold text-foreground">{s.big}</span>
                    <span className="text-[12px] text-ink-3">{t(s.label, s.ar, lang)}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>

          {/* Right column — the call card */}
          <Reveal delay={0.25} className="relative">
            <motion.div
              initial={{ rotate: 1.5 }}
              animate={{ rotate: 0 }}
              transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
              className="relative"
            >
              <div className="relative overflow-hidden rounded-3xl border border-line bg-white shadow-[0_30px_70px_-30px_rgba(16,24,18,0.28)]">
                {/* header — black band shared via PanelHeader */}
                <PanelHeader
                  icon={
                    <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white/10">
                      <PhoneOutgoing className="h-4 w-4 text-white" />
                      <span className="sv-pulse-ring absolute inset-0 rounded-full text-white/70" />
                    </span>
                  }
                  title={
                    <>
                      <p className="num text-[11px] text-white/70">
                        {t("OUTBOUND · SECUREVOICE AGENT", "صادر · وكيل SecureVoice", lang)}
                      </p>
                      <p className="text-[13.5px] font-semibold text-white">
                        {t("Ahmed Al-Rashid", "أحمد الراشد", lang)} ·{" "}
                        <span className="num">+971 •• ••• 4567</span>
                      </p>
                    </>
                  }
                  right={
                    <div className="flex items-center gap-1.5 rounded-full bg-red-tint px-2.5 py-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-red-soft sv-blink" />
                      <span className="num text-[10.5px] font-semibold text-red-soft">
                        {t("REC", "تسجيل", lang)}
                      </span>
                    </div>
                  }
                />

                {/* waveform */}
                <div className="border-b border-line px-5 pb-1 pt-4">
                  <div className="flex items-center gap-3">
                    <Equalizer active className="h-4 text-primary" />
                    <Waveform active className="h-14 w-full" bars={44} />
                  </div>
                </div>

                {/* transcript */}
                <div className="space-y-3 px-5 py-4">
                  <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-secondary px-3.5 py-2.5">
                    <p className="micro mb-1 text-ink-3">
                      {t("Agent · Arabic voice", "الوكيل · بصوت عربي", lang)}
                    </p>
                    <p
                      dir="rtl"
                      className="font-arabic text-[13px] leading-relaxed text-foreground"
                    >
                      أنت لم تُصرح بعملية ٢,٥٠٠ درهم — أهذا صحيح؟
                    </p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">
                      {t(
                        "“You did not authorize the AED 2,500 transaction — is that correct?”",
                        "«ألم تُصرّح بعملية ٢,٥٠٠ درهم — أهذا صحيح؟»",
                        lang,
                      )}
                    </p>
                  </div>
                  <div className="ml-auto max-w-[70%] rounded-2xl rounded-tr-md bg-green-tint px-3.5 py-2.5">
                    <p className="micro mb-1 text-green-deep">{t("Customer", "العميل", lang)}</p>
                    <p
                      dir="rtl"
                      className="font-arabic text-[13px] leading-relaxed text-foreground"
                    >
                      صحيح. هذه العملية ليست مني.
                    </p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">
                      {t("“Correct. That was not me.”", "«صحيح. هذه العملية ليست.»", lang)}
                    </p>
                  </div>
                </div>

                {/* action bar */}
                <div className="flex items-center justify-between gap-3 border-t border-line bg-paper px-5 py-3.5">
                  <Chip className="!bg-white">
                    <Lock className="h-3 w-3 text-primary" />
                    POST /tools/card-freeze →{" "}
                    <span className="font-semibold text-green-deep">200 · staged</span>
                  </Chip>
                  {/*
                    The right-hand chip used to read "Case deadline 60s" — the
                    fourth mention of a number the H1 already claims and the lower
                    section already explains, sitting in a decorative card where it
                    competed with the freeze confirmation instead of supporting it.
                    Replaced with the thing this card is actually demonstrating:
                    the protective action is STAGED, and a human confirms it.
                  */}
                  <Chip className="!bg-white">
                    <Webhook className="h-3 w-3 text-amber-soft" />
                    <span className="font-semibold">
                      {t("Human confirms the freeze", "يؤكد الإنسان التجميد", lang)}
                    </span>
                  </Chip>
                </div>
              </div>

              {/* Annotations. These used to float over the card, which put
                  "Guardrail 01" across the waveform and "Handoff queued" across
                  the customer's Arabic reply — the two things the card exists to
                  show. They sit below it now in the same treatment, so no
                  viewport can put them on top of content, and RTL no longer
                  mirrors a `-left-5` into the wrong gutter. Only opacity
                  animates: `.sv-float` owns `transform`, and a CSS animation
                  outranks an inline style, so the old x-slide never played. */}
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <motion.div
                  className="sv-float flex items-start gap-2 rounded-2xl border border-line bg-white px-3.5 py-2.5 shadow-sm"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1.1 }}
                >
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="leading-tight">
                    <p className="text-[11px] font-semibold">
                      {t("Guardrail 01", "الضمانة 01", lang)}
                    </p>
                    <p className="text-[10px] text-ink-3">
                      {t("No PINs requested", "لا يُطلب أي رمز سري", lang)}
                    </p>
                  </div>
                </motion.div>
                <motion.div
                  className="sv-float flex items-start gap-2 rounded-2xl border border-line bg-white px-3.5 py-2.5 shadow-sm"
                  style={{ animationDelay: "1.2s" }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1.3 }}
                >
                  <Headset className="mt-0.5 h-4 w-4 shrink-0 text-amber-soft" />
                  <div className="leading-tight">
                    <p className="text-[11px] font-semibold">
                      {t("Handoff queued", "التسليم في الطابور", lang)}
                    </p>
                    <p className="text-[10px] text-ink-3">
                      {t(
                        "fraud_specialist · no line configured",
                        "fraud_specialist · لا خط مُهيّأ",
                        lang,
                      )}
                    </p>
                  </div>
                </motion.div>
              </div>
            </motion.div>
          </Reveal>
        </div>
      </section>

      {/* ———————————————— LIVE BROWSER-MIC DEMO ————————————————
          The `id` is the scroll target for `/#live-demo`, which is what the
          standalone /usecases page links to. This widget is the demo that needs
          NO sign-in — mic in, neural voice out, no session — so it is the
          correct destination for a visitor arriving from a public page. */}
      <section id="live-demo" className="scroll-mt-24 border-b border-line bg-white py-14 lg:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="flex items-center gap-3">
                  <span className="micro text-primary">Live demo · جرّب الوكيل مباشرة</span>
                  <span className="h-px w-10 bg-line" />
                </div>
                <h2 className="font-display mt-3 max-w-2xl text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
                  {t(
                    "Put on headphones and talk to the agent — no phone number, no sign-up",
                    "ضع سماعات الأذن وتحدّث إلى الوكيل — بلا رقم هاتف وبلا تسجيل",
                    lang,
                  )}
                </h2>
                <p className="mt-2.5 max-w-xl text-[13.5px] leading-relaxed text-ink-2">
                  {t(
                    "This is the same pipeline a production call uses: speech recognition, deterministic guardrail routing, and a neural voice reply. Deny a transaction and watch the agent stage exactly one pre-approved action for a human to commit — and never once ask for a PIN.",
                    "هذا هو نفس خط الأنابيب الذي تستخدمه المكالمة الفعلية: التعرّف على الكلام، وتوجيه حتمي عبر الضمانات، وردّ بصوت عصبي. أنكر صلاحية العملية وشاهد الوكيل يُمهّد إجراءً واحداً معتمداً مسبقاً ليُقرّه موظف بشري — دون أن يطلب رمزاً سرياً ولو مرة.",
                    lang,
                  )}
                </p>
              </div>
              <p dir="rtl" className="font-arabic max-w-xs text-[13px] leading-relaxed text-ink-2">
                محادثة حقيقية عبر ميكروفون متصفحك — نفس خط أنابيب المكالمات الفعلية.
              </p>
            </div>
          </Reveal>

          {/* language pills */}
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <span className="mr-1 flex items-center gap-1.5 text-[11.5px] font-medium text-ink-3">
              <Globe2 className="h-3.5 w-3.5" />
              {t("Call language", "لغة المكالمة", lang)}
            </span>
            {(Object.keys(CALL_LANG_LABEL) as CallLang[]).map((l) => (
              <button
                key={l}
                onClick={() => setLiveLang(l)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-[11.5px] font-semibold transition",
                  liveLang === l
                    ? "border-primary bg-green-tint text-green-deep"
                    : "border-line bg-white text-ink-2 hover:border-primary/40 hover:text-primary",
                )}
              >
                {CALL_LANG_LABEL[l]}
              </button>
            ))}
            <span className="ml-1 flex items-center gap-1 text-[11px] text-ink-3">
              <Mic className="h-3 w-3" />
              {t(
                "your mic audio is sent to the platform's speech-to-text endpoint, which returns a transcript and stores no recording",
                "يُرسل صوت الميكروفون إلى نقطة التفريغ النصي في المنصة، فتعيد نصاً ولا تحفظ أي تسجيل",
                lang,
              )}
            </span>
          </div>

          <div className="mt-5">
            <LiveVoicePanel callLang={liveLang} />
          </div>

          {/* transition — the judge flow into the console */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-paper px-5 py-4">
            <p className="max-w-xl text-[13px] leading-relaxed text-ink-2">
              {t(
                "Ready to see the other side? Step into the operator's Command Center — a dashboard that fills as you run interventions, with live risk scores, real case rows, and the audit trail a regulator would ask for.",
                "هل أنت مستعد لترى الجانب الآخر؟ ادخل إلى مركز عمليات المشغّل — لوحة تتعبّأ أثناء تشغيلك للتدخلات: درجات مخاطرة حيّة، وصفوف حالات حقيقية، وسجل التدقيق الذي تطلبه أي جهة رقابية.",
                lang,
              )}
            </p>
            <button
              onClick={() => setView("auth")}
              className="flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep"
            >
              {t("See how a bank uses this", "شاهد كيف يستخدمه المصرف", lang)}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </section>

      {/* ———————————————— TRY THE PLATFORM ———————————————— */}
      <section className="border-b border-line bg-white py-14 lg:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="flex items-center gap-3">
                  <span className="micro text-primary">Try it now · جرّبها الآن</span>
                  <span className="h-px w-10 bg-line" />
                </div>
                <h2 className="font-display mt-3 max-w-xl text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
                  {t(
                    "Test-drive the platform — don't take our word for it",
                    "جرّب المنصة بنفسك — لا تكتفِ بكلامنا",
                    lang,
                  )}
                </h2>
              </div>
              <p dir="rtl" className="font-arabic max-w-xs text-[13px] leading-relaxed text-ink-2">
                كل ما تعرضه هذه الصفحة قابل للتجربة بنفسك عبر ثلاث محطات:
              </p>
            </div>
          </Reveal>
          <div className="mt-8 grid gap-3 lg:grid-cols-3">
            {TRY_STEPS.map((s, i) => (
              <Reveal key={s.n} delay={i * 0.07}>
                <div className="group flex h-full flex-col rounded-2xl border border-line bg-paper p-6 transition-all hover:border-primary/40 hover:bg-white hover:shadow-[0_18px_40px_-26px_rgba(11,122,85,0.35)]">
                  <div className="flex items-center justify-between">
                    <span className="num text-[12px] font-bold text-primary">{s.n}</span>
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-green-tint text-green-deep transition-colors group-hover:bg-primary group-hover:text-white">
                      <s.icon className="h-4 w-4" strokeWidth={1.7} />
                    </span>
                  </div>
                  <p className="font-display mt-4 text-[16.5px] font-semibold tracking-tight">
                    {s.en}
                  </p>
                  <p dir="rtl" className="font-arabic mt-0.5 text-[12px] text-ink-3">
                    {s.ar}
                  </p>
                  <p className="mt-2.5 flex-1 text-[13px] leading-relaxed text-ink-2">
                    {t(
                      s.body,
                      s.n === "01"
                        ? "اختر أحد ثلاثة سيناريوهات احتيال — احتيال بالبطاقات، أو سحب نقدي من الصراف الآلي، أو احتيال بالتحويلات البنكية — وأطلق التنبيه بنفسك. يتصل الوكيل، ويتحقق، ويُمهّد إجراء الحماية؛ وأخصائي لديكم يُقرّه."
                        : s.n === "02"
                          ? "راقب المكالمات الجارية، وبدّل الضمانات حيث تسمح سياسة الإنتاج، وابحث في سجل التدقيق المرتبط ببصمات التجزئة — نفس لوحة التحكم التي يشغّلها مكتب مكافحة الاحتيال في المصرف. ولا وجود لمؤشّر ضبط درجة المخاطرة: الدرجة تأتي من محرككم، والبوابات التي ترفض الإشارة فعلاً هي الموافقة وأوقات الاتصال والدولة والسرعة والائتمان."
                          : "مسار المكالمة كاملاً مع نقاط تحقق الضمانات، والطبقات الخمس: استيعاب الأحداث، وتنسيق الوكيل، والتكامل، والهاتفة، والتحليلات والتدقيق، والمؤشرات من خط الأساس إلى الهدف — وتُعرض كأهداف لأن حزمة الأدلة المحفوظة لا تقيس سوى مسار استقبال الإشارة.",
                      lang,
                    )}
                  </p>
                  <button
                    onClick={() => (s.view === "demo" ? launchDemo() : setView(s.view))}
                    className="mt-5 flex w-fit items-center gap-1.5 rounded-full border border-line bg-white px-4 py-2 text-[12.5px] font-semibold text-foreground transition hover:border-primary/50 hover:text-primary"
                  >
                    {t(
                      s.cta,
                      s.n === "01"
                        ? "افتح العرض الحي"
                        : s.n === "02"
                          ? "افتح لوحة التحكم"
                          : "افتح التفاصيل الكاملة",
                      lang,
                    )}
                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                  </button>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ———————————————— ELEVENLABS TICKER ———————————————— */}
      <section className="border-y border-line bg-white py-4">
        <div className="sv-mask-fade-x overflow-hidden">
          {/*
            The separator spacing lives INSIDE each item, not on the flex track.

            `gap-10` on the track puts a gap after the LAST item too, so the track
            is 2C + (2n-1)g wide while `translateX(-50%)` shifts by C + (n-0.5)g —
            half a gap short of where copy 2 actually begins. Every 32 seconds the
            loop therefore lands on the seam and jumps sideways. That is the
            visible hitch on this band, and it is arithmetic, not a rendering
            artifact.

            With the spacing as padding on each item the track is exactly 2C, so -50%
            is exact and the loop is seamless.
          */}
          <div className="sv-marquee flex w-max items-center">
            {[...ELEVEN, ...ELEVEN].map((x, i) => (
              <span key={i} className="flex items-center gap-3 pr-10 whitespace-nowrap">
                <span className="micro text-ink-3">{t(x.en, x.ar, lang)}</span>
                <span className="h-1 w-1 rounded-full bg-primary/60" />
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ———————————————— HERO STAT: 38:00 → 0:60 ———————————————— */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <Reveal>
          <div className="grid overflow-hidden rounded-3xl border border-line bg-white shadow-[0_24px_60px_-40px_rgba(16,24,18,0.35)] lg:grid-cols-2">
            {/* old way */}
            <div className="relative p-8 sm:p-12 lg:border-r lg:border-line">
              <p className="micro text-ink-3">
                {t("Today · manual outreach", "اليوم · اتصال يدوي", lang)}
              </p>
              <div className="mt-6 flex items-baseline gap-2">
                <Counter
                  to={38}
                  className="text-7xl font-semibold tracking-tight text-ink-3 sm:text-8xl"
                />
                <span className="num text-2xl text-ink-3">{t("min", "دقيقة", lang)}</span>
              </div>
              <p className="mt-4 max-w-sm text-[14.5px] leading-relaxed text-ink-2">
                {t(
                  "Average delay between fraud detection and customer contact at top UAE banks. Only",
                  "متوسط التأخير بين كشف الاحتيال والتواصل مع العميل في كبرى المصارف الإماراتية. ولا تحظى",
                  lang,
                )}{" "}
                <span className="num font-semibold">{t("22%", "٢٢٪", lang)}</span>{" "}
                {t(
                  "of alerts get an immediate response. The fraudster finishes first.",
                  "من التنبيهات باستجابة فورية. والمحتال يسبق الجميع.",
                  lang,
                )}
              </p>
              <div className="mt-8 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-red-soft" />
                <span className="text-[12px] font-medium text-red-soft">
                  {t(
                    "AED 2,847 average per-case loss · 38 min manual contact (literature baseline)",
                    "٢٬٨٤٧ درهماً متوسط الخسارة لكل حالة · ٣٨ دقيقة للتواصل اليدوي (مرجع أدبي)",
                    lang,
                  )}
                </span>
              </div>
            </div>

            {/* securevoice */}
            <div className="relative bg-card p-8 text-foreground sm:p-12">
              <div
                className="absolute inset-0 opacity-70"
                style={{
                  background:
                    "radial-gradient(600px 240px at 85% 10%, rgba(20,163,116,0.22), transparent 60%)",
                }}
              />
              <div className="relative">
                <p className="micro text-primary">
                  {t(
                    "With SecureVoice AI · case deadline",
                    "مع SecureVoice AI · مهلة الحالة",
                    lang,
                  )}
                </p>
                <div className="mt-6 flex items-baseline gap-2">
                  <Counter to={60} className="text-7xl font-semibold tracking-tight sm:text-8xl" />
                  <span className="num text-2xl text-primary">{t("sec", "ثانية", lang)}</span>
                </div>
                <p className="mt-4 max-w-sm text-[14.5px] leading-relaxed text-ink-2">
                  {t(
                    "Sixty seconds is the deadline this platform sets on the case from the moment the signal arrives — a clock it counts down, not a measured time-to-contact, which no committed artifact measures. The agent works in the customer's own language, inside a CBUAE-aligned guardrail, and raises a handoff when the call needs a person.",
                    "ستّون ثانية هي المهلة التي تضعها هذه المنصة على الحالة من لحظة وصول الإشارة — عدّاد تنازلي تُشغّله المنصة، لا زمن وصول مُقاس، فليس في الأدلة المحفوظة قياس له. ويعمل الوكيل بلغة العميل نفسها، ضمن ضمانة متوافقة مع أنظمة المصرف المركزي، ويرفع طلب تسليم حين تحتاج المكالمة إلى شخص.",
                    lang,
                  )}
                </p>
                <div className="mt-8 flex flex-wrap gap-2">
                  <Chip className="!border-line !bg-secondary !text-ink-2">
                    {t("verify · 2/3 challenge", "تحقق · تحدي ٢ من ٣", lang)}
                  </Chip>
                  <Chip className="!border-line !bg-secondary !text-ink-2">
                    {t("freeze · staged", "تجميد · مُمهَّد", lang)}
                  </Chip>
                  <Chip className="!border-line !bg-secondary !text-ink-2">
                    {t("handoff · queued by default", "تسليم · في الطابور افتراضياً", lang)}
                  </Chip>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ———————————————— FEATURES ———————————————— */}
      <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8 lg:pb-28">
        <Reveal>
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <div className="flex items-center gap-3">
                <span className="micro text-primary">
                  {t("01 · Why it works", "01 · لماذا ينجح", lang)}
                </span>
                <span className="h-px w-10 bg-line" />
                <span dir="rtl" className="font-arabic text-[13px] text-ink-3">
                  لماذا ينجح
                </span>
              </div>
              <h2 className="font-display mt-4 max-w-xl text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
                {t("A voice agent banks can actually trust", "وكيل صوتي يثق به المصرف فعلاً", lang)}
              </h2>
            </div>
            <p className="max-w-sm text-[14px] leading-relaxed text-ink-2">
              {t(
                "Every design decision answers one question: would a risk officer at a CBUAE-regulated bank sign off on this?",
                "كل قرار تصميمي يجيب على سؤال واحد: هل يوقّع مسؤول المخاطر في مصرف خاضع لأنظمة المصرف المركزي على هذا؟",
                lang,
              )}
            </p>
          </div>
        </Reveal>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f, i) => (
            <Reveal key={f.en} delay={i * 0.07}>
              <div className="group h-full rounded-2xl border border-line bg-white p-6 transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-[0_18px_40px_-24px_rgba(11,122,85,0.35)] sm:p-7">
                <div className="flex items-start justify-between">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-green-tint text-green-deep transition-colors group-hover:bg-primary group-hover:text-white">
                    <f.icon className="h-5 w-5" strokeWidth={1.7} />
                  </span>
                  <span dir="rtl" className="font-arabic text-[12px] text-ink-3">
                    {f.ar}
                  </span>
                </div>
                <h3 className="font-display mt-5 text-[17px] font-semibold tracking-tight">
                  {f.en}
                </h3>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">
                  {t(
                    f.body,
                    f.en === "Immediate multilingual outreach"
                      ? "تُصبح كل إشارة مهمة اتصال دائمة فور اجتيازها البوابات؛ وفي أوقات الضغط تتحوّل المكالمة إلى رسالة نصية أو إشعار في التطبيق بدلاً من إسقاطها. رقم الستّين ثانية هو مهلة الحالة التي تُعدّها اللوحة، لا زمن وصول مُقاس. يبدأ الصوت العصبي المبثوث أثناء التوليد، ويستطيع العميل مقاطعة الوكيل كما يقاطع محدِّثاً بشرياً. وستّ لغات في طبقة الصوت: العربية والإنجليزية والهندية والأردية والفرنسية والسواحيلية — والوكيل الحيّ مُهيّأ على الإنجليزية والعربية والهندية."
                      : f.en === "Verified identity, zero secrets"
                        ? "مسارات تحقق معتمدة من المصرف — التجار والمبالغ والتواريخ. لا يطلب الوكيل أبداً رموزاً سرية أو كلمات مرور، لذا يستحيل تحويله إلى أداة تصيّد واحتيال."
                        : f.en === "Pre-approved actions only"
                          ? "لا يوجد في نطاق أدوات الوكيل سوى إجراء كتابة واحد: تمهيد تجميد مؤقت للبطاقة ليُقرّه أخصائي بشري. وأي إجراء غير قابل للتراجع — استبدال أو تحويل أو استرداد — يُحال إلى موظف بشري مع كامل السياق."
                          : "كل مكالمة تدخل سجل تدقيق وتُختم بطريقة التحقق والإجراءات وسبب التسليم في تخزين غير قابل للتغيير بمعيار AES-256.",
                    lang,
                  )}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ———————————————— 5-STEP TEASER ———————————————— */}
      <section className="border-y border-line bg-white py-16 lg:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
                {t("The call, in five steps", "المكالمة في خمس خطوات", lang)}
              </h2>
              <button
                onClick={() => setView("product")}
                className="group flex items-center gap-1.5 text-[13.5px] font-semibold text-primary"
              >
                {t("Open the deep dive", "افتح التفاصيل الكاملة", lang)}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </button>
            </div>
          </Reveal>
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((s, i) => (
              <Reveal key={s.n} delay={i * 0.06}>
                <div className="group relative h-full rounded-2xl border border-line bg-paper p-5 transition-all hover:border-primary/40 hover:bg-white">
                  <div className="flex items-center justify-between">
                    <span className="num text-[12px] font-bold text-primary">{s.n}</span>
                    <span dir="rtl" className="font-arabic text-[11.5px] text-ink-3">
                      {s.ar}
                    </span>
                  </div>
                  <p className="font-display mt-4 text-[15px] font-semibold tracking-tight">
                    {s.en}
                  </p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                    {t(
                      s.d,
                      s.n === "01"
                        ? "webhook موقّع بـ HMAC من محرك الاحتيال لديكم"
                        : s.n === "02"
                          ? "مهمة اتصال في الطابور؛ والوكيل يتحدّث بلغة المتصل ويبدّلها إن بدّلها"
                          : s.n === "03"
                            ? "مسار تحقق — دون رموز سرية إطلاقاً"
                            : s.n === "04"
                              ? "تجميد مُمهَّد ومعتمد مسبقاً، يقرّه موظف بشري"
                              : "يُنقل إلى الطابور مع كامل السياق إن لم يُوصَل إلى خط",
                      lang,
                    )}
                  </p>
                  {i < 4 && (
                    <ArrowRight className="absolute -right-[13px] top-1/2 z-10 hidden h-4 w-4 -translate-y-1/2 text-[#b9c4bb] lg:block" />
                  )}
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ———————————————— USE-CASES STRIP ———————————————— */}
      <section className="border-t border-line bg-paper py-14 lg:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="micro text-primary">USE CASES · حالات الاستخدام</div>
                <h2 className="font-display mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                  {t(
                    "Beyond fraud: six regulated voice deployments",
                    "أبعد من الاحتيال: ست حالات صوتية منظّمة",
                    lang,
                  )}
                </h2>
                <p className="mt-2 max-w-xl text-[13.5px] leading-relaxed text-ink-2">
                  {t(
                    "Governed collections, provider pre-authorisation, difficult moments, multilingual servicing, claims fraud and policy servicing — one guardrailed engine, six configurations.",
                    "تحصيل منظّم، واعتماد مسبق لمقدمي الخدمة، ودعم في اللحظات الصعبة، وخدمة متعددة اللغات، واحتيال المطالبات، وخدمة الوثائق — محرك واحد بضمانات، وست تشكيلات.",
                    lang,
                  )}
                </p>
              </div>
              <button
                onClick={() => setView("usecases")}
                className="group flex shrink-0 items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition hover:opacity-90"
              >
                {t("Explore the use cases", "استكشف حالات الاستخدام", lang)}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </button>
            </div>
          </Reveal>
          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: HandCoins,
                t: "Governed collections",
                ar: "تحصيل منظّم",
                d: "Approved wording, permitted hours, every opt-out honoured — EN · AR · HI · UR.",
                dAr: "صيغ معتمدة، وأوقات اتصال مسموحة، واحترام كل طلب إلغاء — EN · AR · HI · UR.",
              },
              {
                icon: FileCheck2,
                t: "Provider pre-auth intake",
                ar: "استقبال الاعتماد المسبق لمقدمي الخدمة",
                d: "Rule-based B2B triage; a qualified employee approves every decision.",
                dAr: "فرز قائم على قواعد بين الشركات؛ وموظف مخوّل يعتمد كل قرار.",
              },
              {
                icon: HeartHandshake,
                t: "Difficult moments",
                ar: "لحظات صعبة",
                d: "Bereavement & hardship cases handled once, end to end, with memory.",
                dAr: "حالات الوفاة والشدة تُدار مرة واحدة من البداية للنهاية، مع حفظ السياق.",
              },
              {
                icon: Globe2,
                t: "Multilingual servicing",
                ar: "خدمة متعددة اللغات",
                d: "Posted rates, transfer status, salary-card entitlements — in the caller's language.",
                dAr: "الأسعار المعلنة، وحالة التحويلات، واستحقاقات بطاقة الراتب — بلغة المتصل.",
              },
              {
                icon: ShieldAlert,
                t: "Claims fraud & payout diversion",
                ar: "احتيال المطالبات وتحويل التعويضات",
                d: "Confirm a redirected claim payout with the policyholder before release.",
                dAr: "تأكيد تعويض مطالبة أُعيد توجيهه مع حامل الوثيقة قبل الصرف.",
              },
              {
                icon: FileCheck2,
                t: "Policy servicing changes",
                ar: "تغييرات خدمة الوثيقة",
                d: "Beneficiary and payee changes confirmed; a reversal is staged for a human.",
                dAr: "تأكيد تغييرات المستفيد والمستلم؛ ويُجهَّز العكس ليقرّه إنسان.",
              },
            ].map((x, i) => (
              <Reveal key={x.t} delay={i * 0.05}>
                <button
                  onClick={() => setView("usecases")}
                  className="group h-full w-full rounded-2xl border border-line bg-white p-5 text-left transition-all hover:border-primary/40 hover:shadow-[0_10px_30px_-18px_rgba(11,122,85,0.35)]"
                >
                  <x.icon className="h-4.5 w-4.5 text-primary" strokeWidth={1.7} />
                  <p className="font-display mt-3 text-[14.5px] font-semibold tracking-tight">
                    {t(x.t, x.ar, lang)}
                  </p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                    {t(x.d, x.dAr, lang)}
                  </p>
                </button>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ———————————————— CTA ———————————————— */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-24">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border border-line bg-card px-8 py-14 text-center sm:px-12 lg:py-16">
            <div
              className="absolute inset-0"
              style={{
                background:
                  "radial-gradient(700px 300px at 50% -10%, rgba(20,163,116,0.25), transparent 65%)",
              }}
            />
            <div className="relative">
              <Languages className="mx-auto h-7 w-7 text-primary" strokeWidth={1.5} />
              <h2 className="font-display mx-auto mt-5 max-w-2xl text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-[2.6rem]">
                {t("Don't read about intervention.", "لا تقرأ عن التدخّل.", lang)}{" "}
                <span className="text-primary">{t("Watch it happen.", "شاهده يحدث.", lang)}</span>
              </h2>
              <p
                dir="rtl"
                className="font-arabic mx-auto mt-4 max-w-xl text-[14px] leading-relaxed text-ink-2"
              >
                شاهد المحاكاة الحية: تنبيه احتيال، اتصال بالعميل، تحقق من الهوية، تجميد مُمهَّد
                لليقرّه أخصائي، وتسليم إليه — على مهلة الحالة نفسها.
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <button
                  onClick={launchDemo}
                  className="flex items-center gap-2.5 rounded-full bg-green-bright px-7 py-3.5 text-[14.5px] font-semibold text-[#07130d] transition hover:bg-white"
                >
                  <Play className="h-4 w-4 fill-current" />
                  {t("Launch live simulation", "أطلق المحاكاة الحية", lang)}
                </button>
                <button
                  onClick={() => setView("dashboard")}
                  className="rounded-full border border-line px-6 py-3.5 text-[14px] font-semibold text-ink-2 transition hover:border-white/50 hover:text-foreground"
                >
                  {t("Explore the dashboard", "استكشف اللوحة", lang)}
                </button>
                <button
                  onClick={() => setPilotOpen(true)}
                  className="flex items-center gap-2 rounded-full border border-line px-6 py-3.5 text-[14px] font-semibold text-ink-2 transition hover:border-white/50 hover:text-foreground"
                >
                  <CalendarCheck className="h-4 w-4" />
                  {t("Book a pilot", "احجز تجربة ميدانية", lang)}
                </button>
              </div>
              <p className="mt-5 text-center text-[12.5px] text-ink-3">
                {t("Bank team?", "فريق مصرفي؟", lang)}{" "}
                <button
                  onClick={() => setView("auth")}
                  className="font-semibold text-primary underline decoration-green-bright/30 underline-offset-2 transition hover:decoration-green-bright"
                >
                  {t("Sign in to run the platform", "سجّل الدخول لتشغيل المنصة", lang)}
                </button>
              </p>
            </div>
          </div>
        </Reveal>

        {/* pricing tiers

            Rendered from `@/lib/commercial` — the SAME source the /pricing page
            and the schema.org JSON-LD read. This block used to carry its own
            inline copy of the prices, which is precisely the fourth renderer
            `commercial.ts` was created to eliminate: it drifted once already
            (it still said $490 / $1,490 / Enterprise after the catalog moved to
            $10 / $40 / $120) and nobody reading one file would have seen it.
            `tests/billing/catalog-parity.test.ts` is the backstop. */}
        <Reveal delay={0.1}>
          <div className="mt-16">
            <p className="micro text-center text-[9px] text-slate-400">
              {t("PRICING · MONTHLY OR ANNUAL", "الأسعار · شهري أو سنوي", lang)}
            </p>
            <div className="mx-auto mt-6 grid max-w-4xl gap-4 sm:grid-cols-3">
              {PLANS.map((plan) => (
                <div
                  key={plan.id}
                  className={cn(
                    "rounded-3xl border p-6",
                    plan.featured
                      ? "border-emerald-300/80 bg-emerald-50/60 shadow-[0_20px_60px_-30px_rgba(23,166,115,0.25)]"
                      : "border-slate-200 bg-white",
                  )}
                >
                  {plan.featured && (
                    <span className="micro mb-3 inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[8.5px] text-emerald-700">
                      {t("MOST POPULAR", "الأكثر اختياراً", lang)}
                    </span>
                  )}
                  <p className="font-display text-[15px] font-semibold text-slate-900">
                    {t(plan.name, plan.nameAr, lang)}
                  </p>
                  <p className="mt-2">
                    <span className="font-display text-2xl font-semibold text-slate-900">
                      {formatMonthly(plan, lang)}
                    </span>
                    <span className="text-[12px] text-slate-500"> {t("/mo", "/شهر", lang)}</span>
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {t(
                      `${formatIncluded(plan, lang)} interventions included · ${formatOverage(plan, lang) || "negotiated"} each beyond`,
                      `${formatIncluded(plan, lang)} تدخّل مشمول · ${formatOverage(plan, lang) || "متفاوض عليه"} لكل ما يزيد`,
                      lang,
                    )}
                  </p>
                  <p className="mt-3 text-[11.5px] leading-relaxed text-slate-600">
                    {t(plan.summary, plan.summaryAr, lang)}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-5 text-center text-[11.5px] text-slate-500">
              {t(SETTLEMENT.note, SETTLEMENT.noteAr, lang)}
            </p>
          </div>
        </Reveal>
      </section>

      {/* ———————————————— PILOT DIALOG ———————————————— */}
      <PilotDialog open={pilotOpen} onOpenChange={setPilotOpen} />
    </div>
  );
}

/* ————— pilot booking dialog ————— */

function PilotDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { lang } = useApp();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ref, setRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [bank, setBank] = useState("");
  const [role, setRole] = useState("");
  const [volume, setVolume] = useState("");
  const [message, setMessage] = useState("");
  // honeypot — hidden from humans; bots tend to fill every field
  const [companyUrl, setCompanyUrl] = useState("");

  const valid =
    name.trim().length >= 2 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    bank.trim().length >= 2;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          institution: bank.trim(),
          role: role.trim() || undefined,
          volume: volume || undefined,
          message: message.trim() || undefined,
          company_url: companyUrl,
          source: "website",
        }),
      });
      const data = (await res.json()) as { ok: boolean; ref?: string; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(
          data.error ||
            t(
              "Something went wrong. Please try again.",
              "حدث خطأ ما. يُرجى المحاولة مرة أخرى.",
              lang,
            ),
        );
      }
      setRef(data.ref ?? null);
      setSent(true);
      toast({
        title: t("Pilot request received", "تم استلام طلب التجربة الميدانية", lang),
        description: t(
          "Our fraud team will reach out within one business day.",
          "سيتواصل فريق مكافحة الاحتيال لدينا خلال يوم عمل واحد.",
          lang,
        ),
      });
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : t(
              "Network error — please try again.",
              "خطأ في الشبكة — يُرجى المحاولة مرة أخرى.",
              lang,
            );
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const close = (o: boolean) => {
    if (!o) {
      setSent(false);
      setRef(null);
      setError(null);
    }
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md rounded-3xl border-line bg-white p-7 sm:p-8">
        {sent ? (
          <div className="py-6 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-green-tint">
              <CheckCircle2 className="h-7 w-7 text-primary" strokeWidth={1.6} />
            </span>
            <DialogHeader className="mt-5">
              <DialogTitle className="font-display text-xl font-semibold tracking-tight">
                {t("Request received", "تم استلام الطلب", lang)}
              </DialogTitle>
              <DialogDescription className="mx-auto mt-2 max-w-xs text-[13.5px] leading-relaxed text-ink-2">
                {t(
                  `Thank you, ${name.split(" ")[0]}. Our fraud team will contact you within one business day to scope a 30-day pilot on your card portfolio.`,
                  `شكراً لك، ${name.split(" ")[0]}. سيتواصل فريق مكافحة الاحتيال لدينا خلال يوم عمل واحد لتحديد نطاق تجربة ميدانية مدتها ٣٠ يوماً على محفظة بطاقاتك.`,
                  lang,
                )}
              </DialogDescription>
            </DialogHeader>
            {ref && (
              <div className="mx-auto mt-5 w-fit rounded-xl border border-line bg-paper px-4 py-2.5">
                <div className="micro text-[9px] text-ink-3">
                  {t("YOUR REFERENCE", "رقمك المرجعي", lang)}
                </div>
                <div className="mt-0.5 font-mono text-[14px] font-semibold tracking-wider text-foreground">
                  {ref}
                </div>
              </div>
            )}
            <button
              onClick={() => close(false)}
              className="mt-6 rounded-full bg-primary px-6 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep"
            >
              {t("Done", "تم", lang)}
            </button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="font-display text-xl font-semibold tracking-tight">
                {t("Book a 30-day pilot", "احجز تجربة ميدانية مدتها ٣٠ يوماً", lang)}
              </DialogTitle>
              <DialogDescription className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
                {t(
                  "Run SecureVoice AI against a slice of your card portfolio. Deployment inside your VPC; no customer data leaves your tenancy.",
                  "شغّل SecureVoice AI على شريحة من محفظة بطاقاتك. النشر داخل بيئتك الخاصة VPC؛ ولا تخرج بيانات العملاء من نطاقك.",
                  lang,
                )}
              </DialogDescription>
            </DialogHeader>
            <form
              className="mt-5 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              {/* honeypot — visually hidden, ignored by humans */}
              <input
                type="text"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                value={companyUrl}
                onChange={(e) => setCompanyUrl(e.target.value)}
                className="pointer-events-none absolute -left-[9999px] h-0 w-0 opacity-0"
              />
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pilot-name" className="text-[12px] font-semibold">
                    {t("Full name", "الاسم الكامل", lang)}
                  </Label>
                  <Input
                    id="pilot-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("Fatima Al-Rashid", "فاطمة الراشد", lang)}
                    autoComplete="name"
                    aria-invalid={name.trim().length > 0 && name.trim().length < 2}
                    className="h-10 rounded-xl border-line bg-paper"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pilot-role" className="text-[12px] font-semibold">
                    {t("Role", "الدور", lang)}{" "}
                    <span className="font-normal text-ink-3">
                      {t("(optional)", "(اختياري)", lang)}
                    </span>
                  </Label>
                  <Input
                    id="pilot-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder={t("Head of Fraud", "مدير مكافحة الاحتيال", lang)}
                    autoComplete="organization-title"
                    className="h-10 rounded-xl border-line bg-paper"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pilot-email" className="text-[12px] font-semibold">
                  {t("Work email", "البريد المهني", lang)}
                </Label>
                <Input
                  id="pilot-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="fatima@bank.ae"
                  autoComplete="email"
                  inputMode="email"
                  aria-invalid={
                    email.trim().length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
                  }
                  className="h-10 rounded-xl border-line bg-paper"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pilot-bank" className="text-[12px] font-semibold">
                  {t("Institution", "المؤسسة", lang)}
                </Label>
                <Input
                  id="pilot-bank"
                  value={bank}
                  onChange={(e) => setBank(e.target.value)}
                  placeholder={t("Your bank or insurance firm", "مصرفك أو شركة التأمين", lang)}
                  autoComplete="organization"
                  aria-invalid={bank.trim().length > 0 && bank.trim().length < 2}
                  className="h-10 rounded-xl border-line bg-paper"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pilot-volume" className="text-[12px] font-semibold">
                    {t("Monthly card volume", "حجم البطاقات الشهري", lang)}
                  </Label>
                  <select
                    id="pilot-volume"
                    value={volume}
                    onChange={(e) => setVolume(e.target.value)}
                    className="h-10 w-full rounded-xl border border-line bg-paper px-3 text-[13px] text-foreground outline-none transition focus:border-primary/50"
                  >
                    <option value="">{t("Select…", "اختر…", lang)}</option>
                    <option value="&lt; 100k cards">
                      {t("Under 100k cards", "أقل من ١٠٠ ألف بطاقة", lang)}
                    </option>
                    <option value="100k – 1M">
                      {t("100k – 1M cards", "١٠٠ ألف – مليون بطاقة", lang)}
                    </option>
                    <option value="1M – 5M">
                      {t("1M – 5M cards", "١ – ٥ ملايين بطاقة", lang)}
                    </option>
                    <option value="&gt; 5M">
                      {t("Over 5M cards", "أكثر من ٥ ملايين بطاقة", lang)}
                    </option>
                  </select>
                </div>
                <div className="flex items-end pb-0.5">
                  <p className="text-[11px] leading-snug text-ink-3">
                    {t(
                      "Stored securely in our European infrastructure. We never share your details — see our",
                      "تُحفظ بياناتك بأمان في بنيتنا الأوروبية. ولا نشارك تفاصيلك أبداً — اطّلع على",
                      lang,
                    )}{" "}
                    {/* An anchor, not a `setView` button. `/privacy` is a real
                        route, and a crawler reading this sentence cannot follow a
                        button. The dialog still closes on click, because leaving
                        it open over a navigating page is worse than either. */}
                    <a
                      href="/privacy"
                      onClick={() => close(false)}
                      className="underline decoration-line underline-offset-2 transition hover:text-primary"
                    >
                      {t("Privacy Policy", "سياسة الخصوصية", lang)}
                    </a>
                    .
                  </p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pilot-msg" className="text-[12px] font-semibold">
                  {t("Anything specific to scope?", "هل هناك جوانب محددة لتحديد نطاقها؟", lang)}{" "}
                  <span className="font-normal text-ink-3">
                    {t("(optional)", "(اختياري)", lang)}
                  </span>
                </Label>
                <Textarea
                  id="pilot-msg"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  placeholder={t(
                    "e.g. Card-not-present fraud on debit portfolio, Arabic + English calls, CBUAE reporting…",
                    "مثال: احتيال البطاقات غير الحاضرة في محفظة الخصم، ومكالمات بالعربية والإنجليزية، وتقارير المصرف المركزي…",
                    lang,
                  )}
                  className="resize-none rounded-xl border-line bg-paper"
                />
              </div>
              {error && (
                <div
                  role="alert"
                  className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12.5px] font-medium text-red-700"
                >
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={!valid || busy}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-primary py-3 text-[13.5px] font-semibold text-white shadow-[0_8px_22px_-8px_rgba(11,122,85,0.6)] transition hover:bg-green-deep disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    {t("Submitting…", "جارٍ الإرسال…", lang)}
                  </>
                ) : (
                  <>
                    <CalendarCheck className="h-4 w-4" />
                    {t("Request pilot", "اطلب تجربة ميدانية", lang)}
                  </>
                )}
              </button>
              <p className="text-center text-[11px] text-ink-3">
                {t(
                  `Or email ${SUPPORT_EMAIL} — we reply personally`,
                  `أو راسلنا على ${SUPPORT_EMAIL} — نردّ شخصياً`,
                  lang,
                )}
              </p>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
