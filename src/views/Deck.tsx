"use client";

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  NotebookPen,
  Play,
  ShieldCheck,
  PhoneCall,
  Languages,
  Snowflake,
  FileCheck2,
  BrainCircuit,
  Webhook,
  Mic,
  Lock,
  Clock,
  HeartPulse,
  CheckCheck,
  RotateCcw,
  X,
} from "lucide-react";
import { DECK } from "@/lib/deck";
import { useApp } from "@/lib/store";
import { Chip } from "@/components/fx/core";
import { cn } from "@/lib/utils";

const BASE_STATS = [
  { v: "38 min", en: "detection → contact delay", ar: "التأخير" },
  { v: "22%", en: "alerts with immediate response", ar: "الاستجابة الفورية" },
  { v: "43%", en: "prevention after detection", ar: "المنع" },
  { v: "AED 340M", en: "annual losses · top-5 banks", ar: "الخسائر" },
  { v: "2.8 / 5", en: "fraud-experience CSAT", ar: "الرضا" },
  { v: "65%", en: "language coverage", ar: "التغطية اللغوية" },
];

export function Deck() {
  const { lang, setLang, setView } = useApp();
  const [idx, setIdx] = useState(0);
  const [scriptOpen, setScriptOpen] = useState(true);
  const slide = DECK[idx];

  const next = useCallback(() => setIdx((i) => Math.min(DECK.length - 1, i + 1)), []);
  const prev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        prev();
      } else if (e.key.toLowerCase() === "s") {
        setScriptOpen((s) => !s);
      } else if (e.key === "Home") setIdx(0);
      else if (e.key === "End") setIdx(DECK.length - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev]);

  const isAr = lang === "ar";
  const title = isAr ? slide.titleAr : slide.titleEn;
  const sub = isAr ? slide.subAr : slide.subEn;
  const script = isAr ? slide.scriptAr : slide.scriptEn;

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col bg-[#0c110e]">
      {/* progress */}
      <div className="h-1 w-full bg-white/10">
        <motion.div
          className="h-full bg-gradient-to-r from-[#0b7a55] to-[#17a673]"
          animate={{ width: `${((idx + 1) / DECK.length) * 100}%` }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        />
      </div>

      {/* top bar */}
      <div className="flex items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
            <ShieldCheck className="h-4 w-4 text-green-bright" strokeWidth={1.7} />
          </span>
          <div className="leading-none">
            <p className="text-[12.5px] font-semibold text-white">SecureVoice AI — Pitch Deck</p>
            <p className="micro mt-1 !text-[8.5px] text-white/40">{slide.kicker}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="flex items-center rounded-full border border-white/15 p-0.5"
            role="group"
            aria-label="Deck language"
          >
            {(["en", "ar"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-[11.5px] font-semibold transition",
                  l === "ar" && "font-arabic",
                  lang === l ? "bg-green-bright text-[#07130d]" : "text-white/55 hover:text-white",
                )}
              >
                {l === "en" ? "EN" : "عربي"}
              </button>
            ))}
          </div>
          <button
            onClick={() => setScriptOpen((s) => !s)}
            className={cn(
              "flex items-center gap-2 rounded-full border px-3.5 py-2 text-[11.5px] font-semibold transition",
              scriptOpen
                ? "border-green-bright/40 bg-green-bright/10 text-green-bright"
                : "border-white/15 text-white/60 hover:text-white",
            )}
          >
            {scriptOpen ? <X className="h-3.5 w-3.5" /> : <NotebookPen className="h-3.5 w-3.5" />}
            Script {scriptOpen ? "shown" : "hidden"} · S
          </button>
          <button
            onClick={() => setView("home")}
            className="flex items-center gap-1.5 rounded-full border border-white/15 px-3.5 py-2 text-[11.5px] font-semibold text-white/60 transition hover:text-white"
          >
            Exit
          </button>
        </div>
      </div>

      {/* body */}
      <div className="flex min-h-0 flex-1 gap-4 px-4 pb-4 sm:px-6">
        {/* slide stage */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="relative flex-1 overflow-hidden rounded-3xl bg-white shadow-2xl">
            <AnimatePresence mode="wait">
              <motion.div
                key={slide.id}
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
                className="sv-scroll h-full overflow-y-auto p-7 sm:p-10 lg:p-12"
              >
                <RenderSlide
                  slideId={slide.id}
                  layout={slide.layout}
                  title={title}
                  sub={sub}
                  isAr={isAr}
                />
              </motion.div>
            </AnimatePresence>
          </div>

          {/* controls */}
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={prev}
                disabled={idx === 0}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 text-white/80 transition hover:bg-white/10 disabled:opacity-30"
                aria-label="Previous slide"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={next}
                disabled={idx === DECK.length - 1}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-green-bright text-[#07130d] transition hover:bg-white disabled:opacity-30"
                aria-label="Next slide"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <span className="num ml-2 text-[12px] text-white/50">
                {String(idx + 1).padStart(2, "0")} / {DECK.length}
              </span>
            </div>
            <p className="hidden text-[11px] text-white/35 sm:block">
              ← → navigate · S script · Space next
            </p>
          </div>
        </div>

        {/* presenter script */}
        <AnimatePresence>
          {scriptOpen && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 340, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="hidden shrink-0 overflow-hidden lg:block"
            >
              <div className="flex h-full w-[340px] flex-col rounded-3xl border border-white/10 bg-white/5 p-5">
                <div className="flex items-center gap-2">
                  <NotebookPen className="h-4 w-4 text-green-bright" />
                  <span className="micro !text-[9px] text-white/50">
                    Speaker script · سكريبت المتحدث
                  </span>
                </div>
                <div className="sv-scroll mt-4 flex-1 overflow-y-auto" dir={isAr ? "rtl" : "ltr"}>
                  <p
                    className={cn(
                      "text-[13.5px] leading-[1.85] text-white/85",
                      isAr && "font-arabic text-[14px] leading-[2]",
                    )}
                  >
                    {script}
                  </p>
                </div>
                <div className="mt-4 border-t border-white/10 pt-4">
                  <p className="num text-[10.5px] text-white/40">
                    ~{Math.max(30, Math.round(script.split(" ").length / 2.4))}s spoken · slide{" "}
                    {idx + 1} of {DECK.length}
                  </p>
                </div>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ————————————————— SLIDE RENDERERS ————————————————— */

function RenderSlide({
  slideId,
  layout,
  title,
  sub,
  isAr,
}: {
  slideId: number;
  layout: string;
  title: string;
  sub?: string;
  isAr: boolean;
}) {
  const { setView } = useApp();
  const h = "font-display font-semibold tracking-tight text-[#101812]";
  const arCls = isAr ? "font-arabic" : "";

  if (layout === "cover")
    return (
      <div className="flex h-full flex-col justify-center">
        <Chip className="w-fit">Banking &amp; Insurance · 2026</Chip>
        <h1 className={cn(h, "mt-7 text-5xl leading-[1.02] sm:text-7xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            <>
              Real-Time Fraud
              <br />
              <span className="text-primary">Intervention</span> Voice Agent
            </>
          )}
        </h1>
        <p
          dir={isAr ? "rtl" : "ltr"}
          className={cn(
            "mt-6 max-w-xl text-[15px] leading-relaxed text-ink-2",
            isAr && "font-arabic",
          )}
        >
          {sub}
        </p>
        {!isAr && (
          <p dir="rtl" className="font-arabic mt-3 max-w-xl text-[15px] leading-relaxed text-ink-2">
            {DECK[0].subAr}
          </p>
        )}
        <div className="mt-9 flex flex-wrap gap-2.5">
          <Chip>Team SecureVoice · 5 people</Chip>
          <Chip>team@securevoice.ai</Chip>
          <Chip>ElevenLabs platform</Chip>
        </div>
        <p className="num mt-10 text-[11px] text-ink-3">Press → or Space to begin</p>
      </div>
    );

  if (layout === "statement")
    return (
      <div className="flex h-full flex-col justify-center">
        <div className="flex items-baseline gap-5">
          <span className="num text-[7rem] font-bold leading-none text-ink-3/40 sm:text-[10rem]">
            38
          </span>
          <div>
            <h2 className={cn(h, "text-4xl sm:text-5xl")}>
              {isAr ? (
                <span dir="rtl" className="font-arabic">
                  {title}
                </span>
              ) : (
                "minutes of open door"
              )}
            </h2>
            <p className="num mt-1 text-[13px] text-ink-3">
              AVG DETECTION → CONTACT · UAE TOP BANKS
            </p>
          </div>
        </div>
        <p
          className={cn("mt-8 max-w-2xl text-[15.5px] leading-[1.8] text-ink-2", arCls)}
          dir={isAr ? "rtl" : "ltr"}
        >
          {sub}
        </p>
      </div>
    );

  if (layout === "stats")
    return (
      <div className="flex h-full flex-col justify-center">
        <h2 className={cn(h, "text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {BASE_STATS.map((s) => (
            <div key={s.v} className="rounded-2xl border border-line bg-paper p-5">
              <p className="num text-[26px] font-bold tracking-tight text-primary">{s.v}</p>
              <p className="mt-1.5 text-[12px] leading-snug text-ink-2">{s.en}</p>
              <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">
                {s.ar}
              </p>
            </div>
          ))}
        </div>
      </div>
    );

  if (layout === "pillars")
    return (
      <div className="flex h-full flex-col justify-center">
        <h2 className={cn(h, "text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <p className="mt-4 max-w-2xl rounded-2xl bg-green-tint px-5 py-4 text-[14.5px] font-medium leading-relaxed text-green-deep">
          {sub}
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {[
            {
              icon: PhoneCall,
              en: "Immediate",
              ar: "فوري",
              d: "Call within 60s of the signal — no SMS, no queue",
            },
            {
              icon: Languages,
              en: "Multilingual",
              ar: "متعدد اللغات",
              d: "AR · EN · HI · UR · TL · ML — dialect-tuned",
            },
            {
              icon: Snowflake,
              en: "Action-capable",
              ar: "قادر على التنفيذ",
              d: "Verifies, freezes the card, hands off — compliantly",
            },
          ].map((p) => (
            <div key={p.en} className="rounded-2xl border border-line p-5">
              <p.icon className="h-5 w-5 text-primary" strokeWidth={1.7} />
              <p className="font-display mt-3 text-[16px] font-semibold">{p.en}</p>
              <p dir="rtl" className="font-arabic mt-0.5 text-[11.5px] text-ink-3">
                {p.ar}
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-2">{p.d}</p>
            </div>
          ))}
        </div>
      </div>
    );

  if (layout === "flow")
    return (
      <div className="flex h-full flex-col justify-center">
        <h2 className={cn(h, "text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <div className="mt-9 grid gap-2.5 sm:grid-cols-5">
          {[
            { icon: PhoneCall, n: "1", en: "Outbound call", ar: "اتصال", d: "T+60s SLA" },
            { icon: FileCheck2, n: "2", en: "Verification", ar: "تحقق", d: "no PINs, ever" },
            { icon: BrainCircuit, n: "3", en: "Confirmation", ar: "تأكيد", d: "plain language" },
            { icon: Snowflake, n: "4", en: "Card freeze", ar: "تجميد", d: "temporary only" },
            { icon: Webhook, n: "5", en: "Human handoff", ar: "تسليم", d: "full context" },
          ].map((s, i) => (
            <div key={s.n} className="relative">
              <div
                className={cn(
                  "h-full rounded-2xl border p-4",
                  i === 3 ? "border-primary bg-green-tint" : "border-line bg-white",
                )}
              >
                <div className="flex items-center justify-between">
                  <s.icon
                    className={cn(
                      "h-4.5 w-4.5 h-[18px] w-[18px]",
                      i === 3 ? "text-green-deep" : "text-primary",
                    )}
                    strokeWidth={1.7}
                  />
                  <span className="num text-[10px] font-bold text-ink-3">0{s.n}</span>
                </div>
                <p className="mt-3 text-[13px] font-semibold">{s.en}</p>
                <p dir="rtl" className="font-arabic mt-0.5 text-[10.5px] text-ink-3">
                  {s.ar}
                </p>
                <p className="num mt-2 text-[10px] text-ink-3">{s.d}</p>
              </div>
              {i < 4 && (
                <ChevronRight className="absolute -right-[13px] top-1/2 z-10 hidden h-4 w-4 -translate-y-1/2 text-[#b9c4bb] sm:block" />
              )}
            </div>
          ))}
        </div>
        <div className="mt-7 flex items-center gap-3 rounded-2xl bg-[#0c110e] px-5 py-4">
          <Play className="h-4 w-4 fill-green-bright text-green-bright" />
          <p className="text-[12.5px] text-white/75">
            Watch this exact flow run live — the demo reproduces it second by second.
          </p>
          <button
            onClick={() => setView("demo")}
            className="num ml-auto shrink-0 rounded-full bg-green-bright px-4 py-1.5 text-[11px] font-bold text-[#07130d]"
          >
            RUN DEMO
          </button>
        </div>
      </div>
    );

  if (layout === "components")
    return (
      <div className="flex h-full flex-col justify-center">
        <h2 className={cn(h, "text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <div className="mt-7 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              n: "Agent Workflows",
              d: "Branching logic: verification outcomes → fraud confirmation → actions",
              core: true,
            },
            {
              n: "Eleven v3 TTS",
              d: "Trustworthy natural voice in multiple languages — kills AI skepticism",
              core: true,
            },
            {
              n: "Scribe v2 Realtime STT",
              d: "Multilingual transcription + keyterm biasing for merchants & amounts",
              core: true,
            },
            {
              n: "Knowledge Base + RAG",
              d: "Verification protocols, fraud scenarios, compliant response scripts",
              core: false,
            },
            {
              n: "Webhook Tools",
              d: "Real-time fraud alerts in; card freeze execution out",
              core: false,
            },
            {
              n: "Twilio Telephony",
              d: "Immediate outbound calling to registered numbers",
              core: false,
            },
          ].map((c) => (
            <div
              key={c.n}
              className={cn(
                "rounded-2xl border p-4",
                c.core ? "border-primary/40 bg-green-tint/60" : "border-line bg-white",
              )}
            >
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-semibold">{c.n}</p>
                {c.core && <Chip className="!border-primary/30 !bg-white">core</Chip>}
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-2">{c.d}</p>
            </div>
          ))}
          <div className="flex items-center justify-center rounded-2xl border border-dashed border-line px-4 py-3">
            <p className="num text-[10.5px] text-ink-3">+ Agent Testing · pre-deploy validation</p>
          </div>
        </div>
      </div>
    );

  if (layout === "voice")
    return (
      <div className="flex h-full flex-col justify-center">
        <h2 className={cn(h, "text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          {[
            {
              n: "Marcus",
              l: "English",
              d: "Mature, professional male — calm authority under stress",
              tint: false,
            },
            {
              n: "فاطمة · Fatima",
              l: "العربية الفصحى + Gulf",
              d: "Clear, reassuring female — MSA with Gulf dialect tuning",
              tint: true,
            },
          ].map((v) => (
            <div
              key={v.n}
              className={cn(
                "rounded-2xl border p-6",
                v.tint ? "border-primary/40 bg-green-tint/50" : "border-line bg-white",
              )}
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex h-12 w-12 items-center justify-center rounded-full font-display text-lg font-bold",
                    v.tint ? "bg-primary text-white" : "bg-[#0c110e] text-green-bright",
                  )}
                >
                  {v.n[0]}
                </span>
                <div>
                  <p className="font-display text-[17px] font-semibold">{v.n}</p>
                  <p className={cn("text-[11.5px] text-ink-3", v.tint && "font-arabic")}>{v.l}</p>
                </div>
                <Mic className="ml-auto h-4 w-4 text-primary" />
              </div>
              <p className="mt-4 text-[12.5px] leading-relaxed text-ink-2">{v.d}</p>
            </div>
          ))}
        </div>
        <pre className="num mt-5 rounded-2xl bg-[#0c110e] p-5 text-[11.5px] leading-[1.8] text-green-bright">
          {`voice_config = {
  "stability": 0.70,          // consistent, steady
  "similarity_boost": 0.75,   // brand-accurate timbre
  "style": 0.30,              // warm, never theatrical
  "use_speaker_boost": true,  // phone-line clarity
  "pace": "conversational −8%" // listener is stressed
}`}
        </pre>
        <div className="mt-4 flex flex-wrap gap-2">
          {["Gulf Arabic", "MSA", "Urdu", "Hindi", "Filipino", "Malayalam"].map((d) => (
            <Chip key={d}>{d}</Chip>
          ))}
        </div>
      </div>
    );

  if (layout === "architecture")
    return (
      <div className="flex h-full flex-col justify-center">
        <h2 className={cn(h, "text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <div className="mt-6 space-y-2">
          {[
            { n: "Event Ingestion", d: "webhook listener · queue · validation", icon: Webhook },
            {
              n: "Agent Orchestration",
              d: "ElevenLabs workflows · state · context",
              icon: BrainCircuit,
            },
            { n: "Integration", d: "core banking APIs · freeze · history · CRM", icon: Webhook },
            { n: "Telephony", d: "Twilio outbound · quality · fallback", icon: PhoneCall },
            {
              n: "Analytics & Audit",
              d: "recording · transcription · compliance",
              icon: FileCheck2,
            },
          ].map((l, i) => (
            <div key={l.n} className="flex items-center gap-4">
              <span className="num w-8 text-[10px] text-ink-3">L{i + 1}</span>
              <div className="flex flex-1 items-center gap-3 rounded-xl border border-line bg-white px-4 py-3">
                <l.icon className="h-4 w-4 text-primary" />
                <span className="text-[13px] font-semibold">{l.n}</span>
                <span className="num ml-auto hidden text-[10.5px] text-ink-3 sm:block">{l.d}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Chip>OAuth 2.0 + mutual TLS</Chip>
          <Chip>encrypted in transit &amp; at rest</Chip>
          <Chip>60s SLA · pre-warmed channels</Chip>
          <Chip>multi-AZ · 99.99%</Chip>
        </div>
      </div>
    );

  if (layout === "table")
    return (
      <div className="flex h-full flex-col justify-center">
        <h2 className={cn(h, "text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <div className="mt-6 overflow-hidden rounded-2xl border border-line">
          {[
            {
              icon: Lock,
              g: "No PIN / password requests",
              m: "prompt prohibition + KB-scoped challenges",
            },
            {
              icon: Snowflake,
              g: "Pre-approved actions only",
              m: "one write action (freeze); rest → human",
            },
            {
              icon: Languages,
              g: "Language consistency",
              m: "locked after first response, dialect per profile",
            },
            {
              icon: FileCheck2,
              g: "Audit completeness",
              m: "recording + transcript + metadata, immutable",
            },
            {
              icon: Clock,
              g: "Calling-hour compliance",
              m: "TZ check vs profile; out-of-hours → queued",
            },
            {
              icon: HeartPulse,
              g: "Vulnerability handling",
              m: "distress detected → priority human handoff",
            },
          ].map((r, i) => (
            <div
              key={r.g}
              className={cn(
                "flex items-center gap-4 px-5 py-3.5",
                i % 2 === 0 ? "bg-white" : "bg-paper",
              )}
            >
              <r.icon className="h-4 w-4 shrink-0 text-primary" />
              <span className="w-56 shrink-0 text-[13px] font-semibold">{r.g}</span>
              <span className="text-[12px] text-ink-2">{r.m}</span>
            </div>
          ))}
        </div>
      </div>
    );

  if (layout === "metrics")
    return (
      <div className="flex h-full flex-col justify-center">
        <h2 className={cn(h, "text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <div className="mt-7 grid gap-4 sm:grid-cols-2">
          {[
            { k: "Prevention rate", b: "43%", t: "85%", w: ["43%", "85%"] },
            { k: "Contact delay", b: "38 min", t: "< 90 s", w: ["94%", "2%"] },
            { k: "Verification completion", b: "62%", t: "90%+", w: ["62%", "90%"] },
            { k: "CSAT", b: "2.8", t: "4.2 / 5", w: ["56%", "84%"] },
          ].map((m) => (
            <div key={m.k} className="rounded-2xl border border-line p-5">
              <div className="flex items-baseline justify-between">
                <p className="text-[13px] font-semibold">{m.k}</p>
                <p className="num text-[10.5px] text-ink-3">baseline → target</p>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <span className="num rounded-lg bg-secondary px-2.5 py-1 text-[13px] font-semibold text-ink-3">
                  {m.b}
                </span>
                <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                  <motion.div
                    className="absolute inset-y-0 left-0 rounded-full bg-[#c9d2ca]"
                    initial={{ width: 0 }}
                    animate={{ width: m.w[0] }}
                    transition={{ duration: 0.8 }}
                  />
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-ink-3" />
                <span className="num rounded-lg bg-green-tint px-2.5 py-1 text-[13px] font-bold text-green-deep">
                  {m.t}
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-5 text-[12px] text-ink-3">
          + operational cost −40% · multilingual coverage 65% → 95% · milestones at 30 / 90 / 365
          days
        </p>
      </div>
    );

  if (layout === "security")
    return (
      <div className="flex h-full flex-col justify-center">
        <h2 className={cn(h, "text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          {[
            {
              en: "AES-256 end-to-end",
              d: "All voice data encrypted in transit and at rest",
              ar: "تشفير كامل",
            },
            {
              en: "Tokenized PII",
              d: "Agent works with references, never raw customer data",
              ar: "ترميز البيانات",
            },
            {
              en: "Automated retention",
              d: "Data purged on regulatory schedules, without human touch",
              ar: "حذف تلقائي",
            },
            {
              en: "RBAC + audit",
              d: "Role-based dashboard access, every action audited",
              ar: "صلاحيات",
            },
          ].map((s) => (
            <div key={s.en} className="flex gap-4 rounded-2xl border border-line p-5">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" strokeWidth={1.7} />
              <div>
                <p className="text-[14px] font-semibold">{s.en}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{s.d}</p>
                <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">
                  {s.ar}
                </p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-5 text-[12.5px] text-ink-2">
          Compliance involved from the design phase — not as reviewers at the end. CBUAE-aligned by
          construction.
        </p>
      </div>
    );

  if (layout === "risks")
    return (
      <div className="flex h-full flex-col justify-center">
        <h2 className={cn(h, "text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <div className="mt-6 space-y-2">
          {[
            [
              "Customer trust in AI calls",
              "Transparent intro · natural voices · one-word human escape",
            ],
            [
              "False positive alerts",
              "High-confidence risk threshold only — never nags legitimate spend",
            ],
            ["Integration complexity", "Standard banking APIs · dedicated integration sprints"],
            [
              "Regulatory compliance",
              "Built-in from design phase · audit trails in core architecture",
            ],
            ["Multilingual accuracy", "Native-speaker testing · continuous dialect feedback loop"],
            ["System availability", "Multi-AZ deployment · 99.99% uptime SLA"],
          ].map(([r, m]) => (
            <div
              key={r}
              className="grid items-center gap-2 rounded-xl border border-line px-5 py-3 sm:grid-cols-[240px_1fr]"
            >
              <span className="flex items-center gap-2 text-[12.5px] font-semibold">
                <span className="h-1.5 w-1.5 rounded-full bg-red-soft" />
                {r}
              </span>
              <span className="flex items-center gap-2 text-[12px] text-ink-2">
                <CheckCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
                {m}
              </span>
            </div>
          ))}
        </div>
      </div>
    );

  if (layout === "roadmap")
    return (
      <div className="flex h-full flex-col justify-center">
        <p className="num text-[12px] font-bold text-primary">BY 14 OCTOBER · ١٤ أكتوبر</p>
        <h2 className={cn(h, "mt-3 text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <div className="mt-7 space-y-2.5">
          {[
            "End-to-end prototype: alert → call → verification → freeze → handoff",
            "English + Arabic fully operational, dialect-tuned",
            "Integration with mock banking systems",
            "Test suite with 90%+ pass rate on primary flows",
            "Demonstrable audit trail + guardrail enforcement",
          ].map((c) => (
            <div
              key={c}
              className="flex items-center gap-3 rounded-xl border border-line bg-white px-5 py-3.5"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                <CheckCheck className="h-3 w-3 text-white" />
              </span>
              <span className="text-[13.5px] font-medium">{c}</span>
            </div>
          ))}
        </div>
      </div>
    );

  if (layout === "team")
    return (
      <div className="flex h-full flex-col justify-center">
        <h2 className={cn(h, "text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              r: "Team Lead",
              d: "12 years fraud detection systems at tier-1 banks",
              ar: "القيادة",
            },
            {
              r: "Conversational AI",
              d: "Four shipped ElevenLabs implementations",
              ar: "الذكاء المحادثي",
            },
            { r: "Full-stack Engineer", d: "Banking API integration specialist", ar: "الهندسة" },
            { r: "Arabic Linguist + UX", d: "Voice trust across Gulf dialects", ar: "اللغويات" },
            { r: "Compliance", d: "CBUAE regulatory experience", ar: "الامتثال" },
            { r: "Track record", d: "50K+ voice calls / month, deployed", ar: "الخبرة" },
          ].map((m, i) => (
            <div
              key={m.r}
              className={cn(
                "rounded-2xl border p-5",
                i === 5 ? "border-primary/40 bg-green-tint/60" : "border-line bg-white",
              )}
            >
              <p className="num text-[10px] font-bold text-ink-3">
                {String(i + 1).padStart(2, "0")}
              </p>
              <p className="font-display mt-2 text-[15px] font-semibold">{m.r}</p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">{m.d}</p>
              <p dir="rtl" className="font-arabic mt-1.5 text-[11px] text-ink-3">
                {m.ar}
              </p>
            </div>
          ))}
        </div>
      </div>
    );

  if (layout === "proof")
    return (
      <div className="flex h-full flex-col justify-center">
        <h2 className={cn(h, "text-3xl sm:text-4xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            title
          )}
        </h2>
        <div className="mt-7 overflow-hidden rounded-2xl border border-line shadow-lg">
          <div className="flex items-center gap-2 bg-[#0c110e] px-4 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
            <span className="num ml-3 flex-1 rounded-md bg-white/10 px-3 py-1 text-[11px] text-white/70">
              securevoice.ai/demo — simulated fraud scenario · full call flow · mock banking
              integration
            </span>
          </div>
          <div className="grid gap-3 bg-paper p-5 sm:grid-cols-3">
            {[
              {
                icon: PhoneCall,
                t: "Trigger alert → call",
                d: "Watch the agent dial, greet, and lock language",
              },
              {
                icon: FileCheck2,
                t: "Verify & confirm",
                d: "Challenge flow, zero secrets, plain-language confirmation",
              },
              {
                icon: Snowflake,
                t: "Freeze & handoff",
                d: "API executes freeze; specialist receives context",
              },
            ].map((c) => (
              <div key={c.t} className="rounded-xl border border-line bg-white p-4">
                <c.icon className="h-4 w-4 text-primary" />
                <p className="mt-2.5 text-[13px] font-semibold">{c.t}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">{c.d}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-2.5">
          <button
            onClick={() => setView("demo")}
            className="flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            Open the live demo
          </button>
          <button
            onClick={() => setView("dashboard")}
            className="rounded-full border border-line px-5 py-2.5 text-[13px] font-semibold transition hover:border-primary/40 hover:text-primary"
          >
            Open the dashboard
          </button>
        </div>
      </div>
    );

  // closing
  return (
    <div className="flex h-full flex-col justify-center">
      <h2 className={cn(h, "max-w-3xl text-4xl leading-[1.1] sm:text-6xl")}>
        {isAr ? (
          <span dir="rtl" className="font-arabic">
            {title}
          </span>
        ) : (
          <>
            Detection is solved. <span className="text-primary">Intervention is not.</span>
          </>
        )}
      </h2>
      <p
        className={cn("mt-6 max-w-xl text-[15.5px] leading-relaxed text-ink-2", arCls)}
        dir={isAr ? "rtl" : "ltr"}
      >
        {sub}
      </p>
      <div className="mt-9 flex flex-wrap gap-2.5">
        <Chip>38 min → 60 s</Chip>
        <Chip>AED 340M / year at stake</Chip>
        <Chip>6+ languages</Chip>
        <Chip>CBUAE-aligned</Chip>
        <Chip>team@securevoice.ai</Chip>
      </div>
      <button
        onClick={() => setView("demo")}
        className="mt-8 flex w-fit items-center gap-2.5 rounded-full bg-[#0c110e] px-6 py-3.5 text-[14px] font-semibold text-white transition hover:bg-green-deep"
      >
        <RotateCcw className="h-4 w-4" />
        Replay the whole demo from the start
      </button>
    </div>
  );
}
