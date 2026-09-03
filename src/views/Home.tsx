"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  PhoneOutgoing,
  Languages,
  ShieldCheck,
  FileCheck2,
  Play,
  Zap,
  LayoutDashboard,
  BookOpenText,
  Webhook,
  Lock,
  Fingerprint,
  Snowflake,
  Headset,
  CalendarCheck,
  CheckCircle2,
} from "lucide-react";
import { useApp, t } from "@/lib/store";
import { Reveal, Counter, LiveDot, Chip } from "@/components/fx/core";
import { Waveform, Equalizer } from "@/components/fx/Waveform";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

const ELEVEN = [
  "Agent Workflows",
  "Eleven v3 TTS",
  "Scribe v2 Realtime",
  "Knowledge Base + RAG",
  "Webhook Tools",
  "Twilio Telephony",
  "Agent Testing",
];

const FEATURES = [
  {
    icon: PhoneOutgoing,
    en: "Immediate multilingual outreach",
    ar: "اتصال فوري متعدد اللغات",
    body: "The agent dials within 60 seconds of the fraud signal — no SMS to ignore, no queue. It speaks the customer's language from the first syllable: Arabic, English, Hindi, Urdu, Filipino, Malayalam.",
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
    body: "One write action exists in the agent's tool scope: the temporary card freeze. Anything irreversible — replacement, transfer, refund — goes to a human with full context.",
  },
  {
    icon: FileCheck2,
    en: "An audit trail that satisfies CBUAE",
    ar: "سجل تدقيق يلبي أنظمة المصرف المركزي",
    body: "Every call recorded, transcribed bilingually, and sealed with verification method, actions, and handoff reason into immutable AES-256 storage.",
  },
];

const STEPS = [
  { n: "01", en: "Alert received", ar: "إشارة", d: "Fraud engine webhook, risk ≥ threshold" },
  { n: "02", en: "Outbound call", ar: "اتصال", d: "Connected in ~1s, language locked" },
  { n: "03", en: "Verification", ar: "تحقق", d: "Challenge flow — no PINs, ever" },
  { n: "04", en: "Card freeze", ar: "تجميد", d: "Temporary, pre-approved, reversible" },
  { n: "05", en: "Human handoff", ar: "تسليم", d: "Specialist receives full context" },
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
    body: "Pick one of three fraud cases — card fraud, ATM cash-out, or a wire scam — and fire the alert yourself. The agent calls, verifies, and stops the loss in 61 seconds.",
    cta: "Open the live demo",
    view: "demo",
  },
  {
    n: "02",
    icon: LayoutDashboard,
    en: "Operate the console",
    ar: "شغّل لوحة التحكم",
    body: "Monitor active calls, tune the risk threshold, flip guardrails on and off, and search the immutable audit log — the same console a bank fraud desk would run.",
    cta: "Open the dashboard",
    view: "dashboard",
  },
  {
    n: "03",
    icon: BookOpenText,
    en: "Inspect the architecture",
    ar: "افحص البنية",
    body: "The full call flow with guardrail checkpoints, the five-layer voice stack, and the baseline-to-target metrics behind the 61-second promise.",
    cta: "Open the deep dive",
    view: "product",
  },
];

export function Home() {
  const { setView, lang, launchDemo } = useApp();
  const [pilotOpen, setPilotOpen] = useState(false);

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
              <div className="inline-flex items-center gap-2.5 rounded-full border border-line bg-white py-1.5 pl-2 pr-3.5 shadow-sm">
                <span className="flex h-5 items-center rounded-full bg-green-tint px-2 text-[10px] font-bold uppercase tracking-wider text-green-deep">
                  v1.0
                </span>
                <LiveDot />
                <span className="text-[12px] font-medium text-ink-2">
                  Real-time fraud intervention · Built for UAE banking
                </span>
              </div>
            </Reveal>

            <Reveal delay={0.1}>
              <h1 className="font-display mt-7 text-[2.6rem] font-semibold leading-[1.04] tracking-tight sm:text-6xl lg:text-[4.2rem]">
                Fraud detected.
                <br />
                Call placed.{" "}
                <span className="relative inline-block text-primary">
                  Frozen.
                  <svg
                    className="absolute -bottom-2 left-0 w-full"
                    viewBox="0 0 120 8"
                    fill="none"
                    aria-hidden="true"
                  >
                    <motion.path
                      d="M2 6 C 30 1, 80 1, 118 5"
                      stroke="#14a374"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.9, delay: 0.9, ease: "easeOut" }}
                    />
                  </svg>
                </span>
                <br />
                In <span className="num">60</span> seconds.
              </h1>
            </Reveal>

            <Reveal delay={0.2}>
              <p dir="rtl" className="font-arabic mt-5 text-[15px] leading-relaxed text-ink-2">
                وكيل صوتي ذكي يتصل بالعميل بلغته خلال ستين ثانية من إشارة الاحتيال — يتحقق من هويته، يؤكد العملية، ويجمّد البطاقة، ثم يسلم لأخصائي بشري.
              </p>
            </Reveal>
            <Reveal delay={0.26}>
              <p className="mt-4 max-w-xl text-[15.5px] leading-relaxed text-ink-2">
                SecureVoice AI closes the gap between fraud detection and fraud intervention for
                UAE banks — turning a 38-minute wait into a one-minute call that stops the loss
                while it is still a phone call away.
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

            <Reveal delay={0.42}>
              <div className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-3">
                {[
                  { big: "38m → 60s", label: "contact delay" },
                  { big: "43% → 85%", label: "prevention rate" },
                  { big: "6+ langs", label: "Gulf-tuned voices" },
                ].map((s) => (
                  <div key={s.label} className="flex items-baseline gap-2">
                    <span className="num text-[15px] font-semibold text-foreground">{s.big}</span>
                    <span className="text-[12px] text-ink-3">{s.label}</span>
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
                {/* header */}
                <div className="flex items-center justify-between border-b border-line bg-[#0c110e] px-5 py-4">
                  <div className="flex items-center gap-3">
                    <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-green-bright/15">
                      <PhoneOutgoing className="h-4 w-4 text-green-bright" />
                      <span className="sv-pulse-ring absolute inset-0 rounded-full text-green-bright/70" />
                    </span>
                    <div className="leading-tight">
                      <p className="num text-[11px] text-white/50">OUTBOUND · SECUREVOICE AGENT</p>
                      <p className="text-[13.5px] font-semibold text-white">
                        Ahmed Al-Rashid · <span className="num">+971 •• ••• 4567</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 rounded-full bg-red-tint px-2.5 py-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-red-soft sv-blink" />
                    <span className="num text-[10.5px] font-semibold text-red-soft">REC</span>
                  </div>
                </div>

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
                    <p className="micro mb-1 text-ink-3">Agent · Fatima (AR-Gulf)</p>
                    <p dir="rtl" className="font-arabic text-[13px] leading-relaxed text-foreground">
                      أنت لم تُصرح بعملية ٢,٥٠٠ درهم — أهذا صحيح؟
                    </p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">
                      “You did not authorize the AED 2,500 transaction — is that correct?”
                    </p>
                  </div>
                  <div className="ml-auto max-w-[70%] rounded-2xl rounded-tr-md bg-green-tint px-3.5 py-2.5">
                    <p className="micro mb-1 text-green-deep">Customer</p>
                    <p dir="rtl" className="font-arabic text-[13px] leading-relaxed text-foreground">
                      صحيح. هذه العملية ليست مني.
                    </p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">
                      “Correct. That was not me.”
                    </p>
                  </div>
                </div>

                {/* action bar */}
                <div className="flex items-center justify-between gap-3 border-t border-line bg-paper px-5 py-3.5">
                  <Chip className="!bg-white">
                    <Lock className="h-3 w-3 text-primary" />
                    POST /cards/••4417/freeze → <span className="font-semibold text-green-deep">200 OK</span>
                  </Chip>
                  <Chip className="!bg-white">
                    <Webhook className="h-3 w-3 text-amber-soft" />
                    SLA <span className="font-semibold">61s</span>
                  </Chip>
                </div>
              </div>

              {/* floating chips */}
              <motion.div
                className="sv-float absolute -left-5 top-24 hidden rounded-2xl border border-line bg-white px-3.5 py-2.5 shadow-lg lg:block"
                initial={{ opacity: 0, x: -14 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 1.1 }}
              >
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  <div className="leading-tight">
                    <p className="text-[11px] font-semibold">Guardrail 01</p>
                    <p className="text-[10px] text-ink-3">No PINs requested</p>
                  </div>
                </div>
              </motion.div>
              <motion.div
                className="sv-float absolute -right-4 bottom-16 hidden rounded-2xl border border-line bg-white px-3.5 py-2.5 shadow-lg lg:block"
                style={{ animationDelay: "1.2s" }}
                initial={{ opacity: 0, x: 14 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 1.3 }}
              >
                <div className="flex items-center gap-2">
                  <Headset className="h-4 w-4 text-amber-soft" />
                  <div className="leading-tight">
                    <p className="text-[11px] font-semibold">Handoff ready</p>
                    <p className="text-[10px] text-ink-3">Sara H. · specialist</p>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          </Reveal>
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
                  Test-drive the platform — don&apos;t take our word for it
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
                  <p className="font-display mt-4 text-[16.5px] font-semibold tracking-tight">{s.en}</p>
                  <p dir="rtl" className="font-arabic mt-0.5 text-[12px] text-ink-3">{s.ar}</p>
                  <p className="mt-2.5 flex-1 text-[13px] leading-relaxed text-ink-2">{s.body}</p>
                  <button
                    onClick={() => (s.view === "demo" ? launchDemo() : setView(s.view))}
                    className="mt-5 flex w-fit items-center gap-1.5 rounded-full border border-line bg-white px-4 py-2 text-[12.5px] font-semibold text-foreground transition hover:border-primary/50 hover:text-primary"
                  >
                    {s.cta}
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
          <div className="sv-marquee flex w-max items-center gap-10 px-4">
            {[...ELEVEN, ...ELEVEN].map((x, i) => (
              <span key={i} className="flex items-center gap-3 whitespace-nowrap">
                <span className="micro text-ink-3">{x}</span>
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
              <p className="micro text-ink-3">Today · manual outreach</p>
              <div className="mt-6 flex items-baseline gap-2">
                <Counter to={38} className="text-7xl font-semibold tracking-tight text-ink-3 sm:text-8xl" />
                <span className="num text-2xl text-ink-3">min</span>
              </div>
              <p className="mt-4 max-w-sm text-[14.5px] leading-relaxed text-ink-2">
                Average delay between fraud detection and customer contact at top UAE banks.
                Only <span className="num font-semibold">22%</span> of alerts get an immediate
                response. The fraudster finishes first.
              </p>
              <div className="mt-8 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-red-soft" />
                <span className="text-[12px] font-medium text-red-soft">
                  AED 340M annual losses · prevention rate 43%
                </span>
              </div>
            </div>

            {/* securevoice */}
            <div className="relative bg-[#0c110e] p-8 text-white sm:p-12">
              <div
                className="absolute inset-0 opacity-70"
                style={{
                  background:
                    "radial-gradient(600px 240px at 85% 10%, rgba(20,163,116,0.22), transparent 60%)",
                }}
              />
              <div className="relative">
                <p className="micro text-green-bright">With SecureVoice AI</p>
                <div className="mt-6 flex items-baseline gap-2">
                  <Counter to={61} className="text-7xl font-semibold tracking-tight sm:text-8xl" />
                  <span className="num text-2xl text-green-bright">sec</span>
                </div>
                <p className="mt-4 max-w-sm text-[14.5px] leading-relaxed text-white/70">
                  From fraud signal to verified identity and frozen card — in the customer&apos;s
                  own language, inside a CBUAE-aligned guardrail, with a human one word away.
                </p>
                <div className="mt-8 flex flex-wrap gap-2">
                  <Chip className="!border-white/15 !bg-white/5 !text-white/85">verify · 2/3 challenge</Chip>
                  <Chip className="!border-white/15 !bg-white/5 !text-white/85">freeze · 240ms</Chip>
                  <Chip className="!border-white/15 !bg-white/5 !text-white/85">handoff · warm</Chip>
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
                <span className="micro text-primary">01 · Why it works</span>
                <span className="h-px w-10 bg-line" />
                <span dir="rtl" className="font-arabic text-[13px] text-ink-3">لماذا ينجح</span>
              </div>
              <h2 className="font-display mt-4 max-w-xl text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
                A voice agent banks can actually trust
              </h2>
            </div>
            <p className="max-w-sm text-[14px] leading-relaxed text-ink-2">
              Every design decision answers one question: would a risk officer at a CBUAE-regulated
              bank sign off on this?
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
                  <span dir="rtl" className="font-arabic text-[12px] text-ink-3">{f.ar}</span>
                </div>
                <h3 className="font-display mt-5 text-[17px] font-semibold tracking-tight">{f.en}</h3>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">{f.body}</p>
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
                The call, in five steps
              </h2>
              <button
                onClick={() => setView("product")}
                className="group flex items-center gap-1.5 text-[13.5px] font-semibold text-primary"
              >
                Open the deep dive
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
                    <span dir="rtl" className="font-arabic text-[11.5px] text-ink-3">{s.ar}</span>
                  </div>
                  <p className="font-display mt-4 text-[15px] font-semibold tracking-tight">{s.en}</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">{s.d}</p>
                  {i < 4 && (
                    <ArrowRight className="absolute -right-[13px] top-1/2 z-10 hidden h-4 w-4 -translate-y-1/2 text-[#b9c4bb] lg:block" />
                  )}
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ———————————————— CTA ———————————————— */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-24">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl bg-[#0c110e] px-8 py-14 text-center sm:px-12 lg:py-16">
            <div
              className="absolute inset-0"
              style={{
                background:
                  "radial-gradient(700px 300px at 50% -10%, rgba(20,163,116,0.25), transparent 65%)",
              }}
            />
            <div className="relative">
              <Languages className="mx-auto h-7 w-7 text-green-bright" strokeWidth={1.5} />
              <h2 className="font-display mx-auto mt-5 max-w-2xl text-3xl font-semibold leading-tight tracking-tight text-white sm:text-[2.6rem]">
                Don&apos;t read about intervention.{" "}
                <span className="text-green-bright">Watch it happen.</span>
              </h2>
              <p dir="rtl" className="font-arabic mx-auto mt-4 max-w-xl text-[14px] leading-relaxed text-white/60">
                شاهد المحاكاة الحية: تنبيه احتيال، اتصال بالعميل، تحقق من الهوية، تجميد البطاقة، وتسليم لأخصائي — كل ذلك في دقيقة واحدة.
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
                  className="rounded-full border border-white/20 px-6 py-3.5 text-[14px] font-semibold text-white/85 transition hover:border-white/50 hover:text-white"
                >
                  {t("Explore the dashboard", "استكشف اللوحة", lang)}
                </button>
                <button
                  onClick={() => setPilotOpen(true)}
                  className="flex items-center gap-2 rounded-full border border-white/20 px-6 py-3.5 text-[14px] font-semibold text-white/85 transition hover:border-white/50 hover:text-white"
                >
                  <CalendarCheck className="h-4 w-4" />
                  {t("Book a pilot", "احجز تجربة ميدانية", lang)}
                </button>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ———————————————— PILOT DIALOG ———————————————— */}
      <PilotDialog open={pilotOpen} onOpenChange={setPilotOpen} />
    </div>
  );
}

/* ————— pilot booking dialog ————— */

function PilotDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const { setView } = useApp();
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

  const valid = name.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && bank.trim().length >= 2;

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
        throw new Error(data.error || "Something went wrong. Please try again.");
      }
      setRef(data.ref ?? null);
      setSent(true);
      toast({
        title: "Pilot request received",
        description: "Our fraud team will reach out within one business day.",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Network error — please try again.";
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
                Request received
              </DialogTitle>
              <DialogDescription className="mx-auto mt-2 max-w-xs text-[13.5px] leading-relaxed text-ink-2">
                Thank you, {name.split(" ")[0]}. Our fraud team will contact you within one
                business day to scope a 30-day pilot on your card portfolio.
              </DialogDescription>
            </DialogHeader>
            {ref && (
              <div className="mx-auto mt-5 w-fit rounded-xl border border-line bg-paper px-4 py-2.5">
                <div className="micro text-[9px] text-ink-3">YOUR REFERENCE</div>
                <div className="mt-0.5 font-mono text-[14px] font-semibold tracking-wider text-foreground">
                  {ref}
                </div>
              </div>
            )}
            <button
              onClick={() => close(false)}
              className="mt-6 rounded-full bg-primary px-6 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="font-display text-xl font-semibold tracking-tight">
                Book a 30-day pilot
              </DialogTitle>
              <DialogDescription className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
                Run SecureVoice AI against a slice of your card portfolio. Deployment inside your
                VPC; no customer data leaves your tenancy.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-5 space-y-4">
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
                  <Label htmlFor="pilot-name" className="text-[12px] font-semibold">Full name</Label>
                  <Input
                    id="pilot-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Fatima Al-Rashid"
                    className="h-10 rounded-xl border-line bg-paper"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pilot-role" className="text-[12px] font-semibold">Role <span className="font-normal text-ink-3">(optional)</span></Label>
                  <Input
                    id="pilot-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="Head of Fraud"
                    className="h-10 rounded-xl border-line bg-paper"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pilot-email" className="text-[12px] font-semibold">Work email</Label>
                <Input
                  id="pilot-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="fatima@bank.ae"
                  className="h-10 rounded-xl border-line bg-paper"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pilot-bank" className="text-[12px] font-semibold">Institution</Label>
                <Input
                  id="pilot-bank"
                  value={bank}
                  onChange={(e) => setBank(e.target.value)}
                  placeholder="Your bank or insurance firm"
                  className="h-10 rounded-xl border-line bg-paper"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pilot-volume" className="text-[12px] font-semibold">Monthly card volume</Label>
                  <select
                    id="pilot-volume"
                    value={volume}
                    onChange={(e) => setVolume(e.target.value)}
                    className="h-10 w-full rounded-xl border border-line bg-paper px-3 text-[13px] text-foreground outline-none transition focus:border-primary/50"
                  >
                    <option value="">Select…</option>
                    <option value="&lt; 100k cards">Under 100k cards</option>
                    <option value="100k – 1M">100k – 1M cards</option>
                    <option value="1M – 5M">1M – 5M cards</option>
                    <option value="&gt; 5M">Over 5M cards</option>
                  </select>
                </div>
                <div className="flex items-end pb-0.5">
                  <p className="text-[11px] leading-snug text-ink-3">
                    Stored securely in our UAE region. We never share your details — see our{" "}
                    <button
                      onClick={() => { close(false); setView("privacy"); }}
                      className="underline decoration-line underline-offset-2 transition hover:text-primary"
                    >
                      Privacy Policy
                    </button>
                    .
                  </p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pilot-msg" className="text-[12px] font-semibold">Anything specific to scope? <span className="font-normal text-ink-3">(optional)</span></Label>
                <Textarea
                  id="pilot-msg"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  placeholder="e.g. Card-not-present fraud on debit portfolio, Arabic + English calls, CBUAE reporting…"
                  className="resize-none rounded-xl border-line bg-paper"
                />
              </div>
              {error && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12.5px] font-medium text-red-700">
                  {error}
                </div>
              )}
              <button
                onClick={submit}
                disabled={!valid || busy}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-primary py-3 text-[13.5px] font-semibold text-white shadow-[0_8px_22px_-8px_rgba(11,122,85,0.6)] transition hover:bg-green-deep disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    Submitting…
                  </>
                ) : (
                  <>
                    <CalendarCheck className="h-4 w-4" />
                    Request pilot
                  </>
                )}
              </button>
              <p className="text-center text-[11px] text-ink-3">
                Or email pilots@securevoice.ae · +971 4 000 0000
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
