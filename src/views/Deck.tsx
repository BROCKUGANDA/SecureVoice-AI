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
import { useApp, t } from "@/lib/store";
import { Chip } from "@/components/fx/core";
import { cn } from "@/lib/utils";

/** Arabic counterpart for each slide kicker — `deck.ts` keeps the English only. */
const KICKER_AR: Record<number, string> = {
  1: "SecureVoice AI · الخدمات المصرفية والتأمين",
  2: "01 · المشكلة",
  3: "02 · خط الأساس اليوم",
  4: "03 · الفكرة",
  5: "04 · مسار المكالمة",
  6: "05 · لماذا ElevenLabs",
  7: "06 · نظام تصميم الصوت",
  8: "07 · بنية التكامل",
  9: "08 · الضمانات",
  10: "09 · مؤشرات النجاح",
  11: "10 · الأمن والامتثال",
  12: "11 · المخاطر ومعالجتها",
  13: "12 · ما سيكون جاهزاً",
  14: "13 · الفريق",
  15: "14 · إثبات البناء",
  16: "SecureVoice AI",
};

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
            <p className="text-[12.5px] font-semibold text-white">
              {t("SecureVoice AI — Pitch Deck", "SecureVoice AI — العرض التقديمي", lang)}
            </p>
            <p className="micro mt-1 !text-[8.5px] text-white/40">
              {t(slide.kicker, KICKER_AR[slide.id] ?? slide.kicker, lang)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="flex items-center rounded-full border border-white/15 p-0.5"
            role="group"
            aria-label={t("Deck language", "لغة العرض", lang)}
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
            {scriptOpen
              ? t("Script shown · S", "السكريبت معروض · S", lang)
              : t("Script hidden · S", "السكريبت مخفي · S", lang)}
          </button>
          <button
            onClick={() => setView("home")}
            className="flex items-center gap-1.5 rounded-full border border-white/15 px-3.5 py-2 text-[11.5px] font-semibold text-white/60 transition hover:text-white"
          >
            {t("Exit", "خروج", lang)}
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
                aria-label={t("Previous slide", "الشريحة السابقة", lang)}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={next}
                disabled={idx === DECK.length - 1}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-green-bright text-[#07130d] transition hover:bg-white disabled:opacity-30"
                aria-label={t("Next slide", "الشريحة التالية", lang)}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <span className="num ml-2 text-[12px] text-white/50">
                {String(idx + 1).padStart(2, "0")} / {DECK.length}
              </span>
            </div>
            <p className="hidden text-[11px] text-white/35 sm:block">
              {t(
                "← → navigate · S script · Space next",
                "→ ← للتنقل · S للسكريبت · مسافة للتالي",
                lang,
              )}
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
                    ~{Math.max(30, Math.round(script.split(" ").length / 2.4))}
                    {t("s spoken", "ث منطوقة", lang)} · {t("slide", "شريحة", lang)} {idx + 1}{" "}
                    {t("of", "من", lang)} {DECK.length}
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
  const { setView, lang } = useApp();
  const h = "font-display font-semibold tracking-tight text-[#101812]";
  const arCls = isAr ? "font-arabic" : "";

  if (layout === "cover")
    return (
      <div className="flex h-full flex-col justify-center">
        <Chip className="w-fit">
          {t("Banking & Insurance · 2026", "الخدمات المصرفية والتأمين · 2026", lang)}
        </Chip>
        <h1 className={cn(h, "mt-7 text-5xl leading-[1.02] sm:text-7xl")}>
          {isAr ? (
            <span dir="rtl" className="font-arabic">
              {title}
            </span>
          ) : (
            <>
              {t("Real-Time Fraud", "الاحتيال", lang)}
              <br />
              <span className="text-primary">
                {t("Intervention", "والتدخّل الفوري", lang)}
              </span>{" "}
              {t("Voice Agent", "عبر وكيل صوتي", lang)}
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
          <Chip>{t("Team SecureVoice · 5 people", "فريق SecureVoice · ٥ أعضاء", lang)}</Chip>
          <Chip>team@securevoice.ai</Chip>
          <Chip>{t("ElevenLabs platform", "منصة ElevenLabs", lang)}</Chip>
        </div>
        <p className="num mt-10 text-[11px] text-ink-3">
          {t("Press → or Space to begin", "اضغط → أو المسافة للبدء", lang)}
        </p>
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
                t("minutes of open door", "دقائق من باب مفتوح", lang)
              )}
            </h2>
            <p className="num mt-1 text-[13px] text-ink-3">
              {t(
                "AVG DETECTION → CONTACT · UAE TOP BANKS",
                "متوسط الكشف → التواصل · كبرى المصارف الإماراتية",
                lang,
              )}
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
              dAr: "اتصال خلال ٦٠ ثانية من الإشارة — بلا رسائل نصية وبلا طوابير",
            },
            {
              icon: Languages,
              en: "Multilingual",
              ar: "متعدد اللغات",
              d: "AR · EN · HI · UR · TL · ML — dialect-tuned",
              dAr: "AR · EN · HI · UR · TL · ML — معايَرة حسب اللهجة",
            },
            {
              icon: Snowflake,
              en: "Action-capable",
              ar: "قادر على التنفيذ",
              d: "Verifies, freezes the card, hands off — compliantly",
              dAr: "يتحقق، ويجمّد البطاقة، ويسلّم لأخصائي — بما يتوافق مع الأنظمة",
            },
          ].map((p) => (
            <div key={p.en} className="rounded-2xl border border-line p-5">
              <p.icon className="h-5 w-5 text-primary" strokeWidth={1.7} />
              <p className="font-display mt-3 text-[16px] font-semibold">{p.en}</p>
              <p dir="rtl" className="font-arabic mt-0.5 text-[11.5px] text-ink-3">
                {p.ar}
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-2">{t(p.d, p.dAr, lang)}</p>
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
            {
              icon: PhoneCall,
              n: "1",
              en: "Outbound call",
              ar: "اتصال",
              d: "T+60s SLA",
              dAr: "اتصال خلال ٦٠ ثانية",
            },
            {
              icon: FileCheck2,
              n: "2",
              en: "Verification",
              ar: "تحقق",
              d: "no PINs, ever",
              dAr: "دون رموز سرية إطلاقاً",
            },
            {
              icon: BrainCircuit,
              n: "3",
              en: "Confirmation",
              ar: "تأكيد",
              d: "plain language",
              dAr: "لغة واضحة ومباشرة",
            },
            {
              icon: Snowflake,
              n: "4",
              en: "Card freeze",
              ar: "تجميد",
              d: "temporary only",
              dAr: "مؤقت فقط",
            },
            {
              icon: Webhook,
              n: "5",
              en: "Human handoff",
              ar: "تسليم",
              d: "full context",
              dAr: "كامل السياق",
            },
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
                <p className="num mt-2 text-[10px] text-ink-3">{t(s.d, s.dAr, lang)}</p>
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
            {t(
              "Watch this exact flow run live — the demo reproduces it second by second.",
              "شاهد هذا المسار يعمل حيّاً — العرض الحي يعيد إنتاجه ثانية بثانية.",
              lang,
            )}
          </p>
          <button
            onClick={() => setView("demo")}
            className="num ml-auto shrink-0 rounded-full bg-green-bright px-4 py-1.5 text-[11px] font-bold text-[#07130d]"
          >
            {t("RUN DEMO", "شغّل العرض", lang)}
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
              nAr: "مسارات الوكيل",
              d: "Branching logic: verification outcomes → fraud confirmation → actions",
              dAr: "منطق تفرّع: نتائج التحقق → تأكيد الاحتيال → الإجراءات",
              core: true,
            },
            {
              n: "Eleven v3 TTS",
              nAr: "تحويل النص إلى كلام Eleven v3",
              d: "Trustworthy natural voice in multiple languages — kills AI skepticism",
              dAr: "صوت طبيعي موثوق بعدة لغات — يقضي على الشك في الذكاء الاصطناعي",
              core: true,
            },
            {
              n: "Scribe v2 Realtime STT",
              nAr: "التفريغ الفوري Scribe v2 STT",
              d: "Multilingual transcription + keyterm biasing for merchants & amounts",
              dAr: "تفريغ نصي متعدد اللغات مع توجيه المصطلحات للتجار والمبالغ",
              core: true,
            },
            {
              n: "Knowledge Base + RAG",
              nAr: "قاعدة المعرفة + RAG",
              d: "Verification protocols, fraud scenarios, compliant response scripts",
              dAr: "بروتوكولات التحقق، وسيناريوهات الاحتيال، وسكربتات رد متوافقة مع الأنظمة",
              core: false,
            },
            {
              n: "Webhook Tools",
              nAr: "أدوات Webhook",
              d: "Real-time fraud alerts in; card freeze execution out",
              dAr: "تنبيهات احتيال فورية إلى الداخل؛ وتنفيذ تجميد البطاقة إلى الخارج",
              core: false,
            },
            {
              n: "Twilio Telephony",
              nAr: "الهاتفة Twilio",
              d: "Immediate outbound calling to registered numbers",
              dAr: "اتصال صادر فوري بالأرقام المسجّلة",
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
                <p className="text-[13px] font-semibold">{t(c.n, c.nAr, lang)}</p>
                {c.core && (
                  <Chip className="!border-primary/30 !bg-white">{t("core", "أساسي", lang)}</Chip>
                )}
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-2">
                {t(c.d, c.dAr, lang)}
              </p>
            </div>
          ))}
          <div className="flex items-center justify-center rounded-2xl border border-dashed border-line px-4 py-3">
            <p className="num text-[10.5px] text-ink-3">
              {t(
                "+ Agent Testing · pre-deploy validation",
                "+ اختبار الوكيل · تحقق قبل النشر",
                lang,
              )}
            </p>
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
              lAr: "الإنجليزية",
              d: "Mature, professional male — calm authority under stress",
              dAr: "صوت رجالي ناضج واحترافي — هدوء وثقة تحت الضغط",
              tint: false,
            },
            {
              n: "فاطمة · Fatima",
              l: "العربية الفصحى + Gulf",
              lAr: "العربية الفصحى + Gulf",
              d: "Clear, reassuring female — MSA with Gulf dialect tuning",
              dAr: "صوت نسائي واضح ومُطمئن — فصحى مع معايرة للهجة الخليجية",
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
                  <p className={cn("text-[11.5px] text-ink-3", v.tint && "font-arabic")}>
                    {t(v.l, v.lAr, lang)}
                  </p>
                </div>
                <Mic className="ml-auto h-4 w-4 text-primary" />
              </div>
              <p className="mt-4 text-[12.5px] leading-relaxed text-ink-2">{t(v.d, v.dAr, lang)}</p>
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
          {[
            { en: "Gulf Arabic", ar: "العربية الخليجية" },
            { en: "MSA", ar: "العربية الفصحى" },
            { en: "Urdu", ar: "الأردية" },
            { en: "Hindi", ar: "الهندية" },
            { en: "Filipino", ar: "الفلبينية" },
            { en: "Malayalam", ar: "الماليالامية" },
          ].map((d) => (
            <Chip key={d.en}>{t(d.en, d.ar, lang)}</Chip>
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
            {
              n: "Event Ingestion",
              nAr: "استيعاب الأحداث",
              d: "webhook listener · queue · validation",
              dAr: "مستقبل webhook · قائمة انتظار · تحقق",
              icon: Webhook,
            },
            {
              n: "Agent Orchestration",
              nAr: "تنسيق الوكيل",
              d: "ElevenLabs workflows · state · context",
              dAr: "مسارات ElevenLabs · الحالة · السياق",
              icon: BrainCircuit,
            },
            {
              n: "Integration",
              nAr: "التكامل",
              d: "core banking APIs · freeze · history · CRM",
              dAr: "واجهات البنك الأساسية · التجميد · السجل · إدارة العلاقات",
              icon: Webhook,
            },
            {
              n: "Telephony",
              nAr: "الهاتفة",
              d: "Twilio outbound · quality · fallback",
              dAr: "اتصال صادر Twilio · الجودة · بديل احتياطي",
              icon: PhoneCall,
            },
            {
              n: "Analytics & Audit",
              nAr: "التحليلات والتدقيق",
              d: "recording · transcription · compliance",
              dAr: "تسجيل · تفريغ نصي · امتثال",
              icon: FileCheck2,
            },
          ].map((l, i) => (
            <div key={l.n} className="flex items-center gap-4">
              <span className="num w-8 text-[10px] text-ink-3">L{i + 1}</span>
              <div className="flex flex-1 items-center gap-3 rounded-xl border border-line bg-white px-4 py-3">
                <l.icon className="h-4 w-4 text-primary" />
                <span className="text-[13px] font-semibold">{t(l.n, l.nAr, lang)}</span>
                <span className="num ml-auto hidden text-[10.5px] text-ink-3 sm:block">
                  {t(l.d, l.dAr, lang)}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Chip>{t("OAuth 2.0 + mutual TLS", "OAuth 2.0 مع TLS متبادل", lang)}</Chip>
          <Chip>{t("encrypted in transit & at rest", "تشفير أثناء النقل وفي التخزين", lang)}</Chip>
          <Chip>
            {t(
              "60s SLA · pre-warmed channels",
              "زمن استجابة ٦٠ ثانية · قنوات مُجهّزة مسبقاً",
              lang,
            )}
          </Chip>
          <Chip>{t("multi-AZ · 99.99%", "مناطق توافر متعددة · ٩٩.٩٩٪", lang)}</Chip>
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
              gAr: "لا طلب لرموز سرية أو كلمات مرور",
              m: "prompt prohibition + KB-scoped challenges",
              mAr: "منع في التوجيه النصي + تحديات من قاعدة المعرفة",
            },
            {
              icon: Snowflake,
              g: "Pre-approved actions only",
              gAr: "إجراءات معتمدة مسبقاً فقط",
              m: "one write action (freeze); rest → human",
              mAr: "إجراء كتابة واحد (التجميد)؛ والباقي → بشري",
            },
            {
              icon: Languages,
              g: "Language consistency",
              gAr: "ثبات اللغة",
              m: "locked after first response, dialect per profile",
              mAr: "تثبيت بعد أول رد، واللهجة حسب ملف العميل",
            },
            {
              icon: FileCheck2,
              g: "Audit completeness",
              gAr: "اكتمال سجل التدقيق",
              m: "recording + transcript + metadata, immutable",
              mAr: "تسجيل + نص مفرّغ + بيانات وصفية، غير قابل للتغيير",
            },
            {
              icon: Clock,
              g: "Calling-hour compliance",
              gAr: "الالتزام بأوقات الاتصال",
              m: "TZ check vs profile; out-of-hours → queued",
              mAr: "تحقق من المنطقة الزمنية؛ وخارج الأوقات → في الطابور",
            },
            {
              icon: HeartPulse,
              g: "Vulnerability handling",
              gAr: "التعامل مع الحالات الهشّة",
              m: "distress detected → priority human handoff",
              mAr: "كشف الضيق → تسليم فوري لأخصائي بشري",
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
            { k: "Prevention rate", kAr: "نسبة المنع", b: "43%", t: "85%", w: ["43%", "85%"] },
            { k: "Contact delay", kAr: "زمن التواصل", b: "38 min", t: "< 90 s", w: ["94%", "2%"] },
            {
              k: "Verification completion",
              kAr: "اكتمال التحقق",
              b: "62%",
              t: "90%+",
              w: ["62%", "90%"],
            },
            { k: "CSAT", kAr: "رضا العملاء", b: "2.8", t: "4.2 / 5", w: ["56%", "84%"] },
          ].map((m) => (
            <div key={m.k} className="rounded-2xl border border-line p-5">
              <div className="flex items-baseline justify-between">
                <p className="text-[13px] font-semibold">{t(m.k, m.kAr, lang)}</p>
                <p className="num text-[10.5px] text-ink-3">
                  {t("baseline → target", "خط الأساس → الهدف", lang)}
                </p>
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
          {t(
            "+ operational cost −40% · multilingual coverage 65% → 95% · milestones at 30 / 90 / 365 days",
            "+ تكلفة تشغيلية أقل بـ ٤٠٪ · تغطية لغوية من ٦٥٪ إلى ٩٥٪ · محطات تقييم عند ٣٠ / ٩٠ / ٣٦٥ يوماً",
            lang,
          )}
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
              dAr: "جميع بيانات الصوت مشفّرة أثناء النقل وفي التخزين",
              ar: "تشفير كامل",
            },
            {
              en: "Tokenized PII",
              d: "Agent works with references, never raw customer data",
              dAr: "يعمل الوكيل بمراجع، لا ببيانات العملاء الخام",
              ar: "ترميز البيانات",
            },
            {
              en: "Automated retention",
              d: "Data purged on regulatory schedules, without human touch",
              dAr: "حذف البيانات وفق الجداول التنظيمية، دون تدخل بشري",
              ar: "حذف تلقائي",
            },
            {
              en: "RBAC + audit",
              d: "Role-based dashboard access, every action audited",
              dAr: "وصول للوحة التحكم حسب الأدوار، وكل إجراء مسجّل",
              ar: "صلاحيات",
            },
          ].map((s) => (
            <div key={s.en} className="flex gap-4 rounded-2xl border border-line p-5">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" strokeWidth={1.7} />
              <div>
                <p className="text-[14px] font-semibold">{s.en}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{t(s.d, s.dAr, lang)}</p>
                <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">
                  {s.ar}
                </p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-5 text-[12.5px] text-ink-2">
          {t(
            "Compliance involved from the design phase — not as reviewers at the end. CBUAE-aligned by construction.",
            "الامتثال مشارك من مرحلة التصميم — لا مراجِعاً في النهاية. متوافق مع أنظمة المصرف المركزي بطبيعة البناء.",
            lang,
          )}
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
              "ثقة العميل في مكالمات الذكاء الاصطناعي",
              "تعريف شفاف · أصوات طبيعية · كلمة واحدة للوصول إلى بشري",
            ],
            [
              "False positive alerts",
              "High-confidence risk threshold only — never nags legitimate spend",
              "تنبيهات كاذبة",
              "عتبة مخاطرة عالية الثقة فقط — دون إزعاج العميل عن إنفاقه المشروع",
            ],
            [
              "Integration complexity",
              "Standard banking APIs · dedicated integration sprints",
              "تعقيد التكامل",
              "واجهات بنكية قياسية · فترات تكامل مخصّصة",
            ],
            [
              "Regulatory compliance",
              "Built-in from design phase · audit trails in core architecture",
              "الامتثال التنظيمي",
              "مدمج من مرحلة التصميم · سجلات تدقيق في قلب البنية",
            ],
            [
              "Multilingual accuracy",
              "Native-speaker testing · continuous dialect feedback loop",
              "الدقة اللغوية",
              "اختبار مع متحدثين أصليين · حلقة تغذية راجعة مستمرة للهجات",
            ],
            [
              "System availability",
              "Multi-AZ deployment · 99.99% uptime SLA",
              "جاهزية النظام",
              "نشر في مناطق توافر متعددة · اتفاقية توافر ٩٩.٩٩٪",
            ],
          ].map(([r, m, rAr, mAr]) => (
            <div
              key={r}
              className="grid items-center gap-2 rounded-xl border border-line px-5 py-3 sm:grid-cols-[240px_1fr]"
            >
              <span className="flex items-center gap-2 text-[12.5px] font-semibold">
                <span className="h-1.5 w-1.5 rounded-full bg-red-soft" />
                {t(r, rAr, lang)}
              </span>
              <span className="flex items-center gap-2 text-[12px] text-ink-2">
                <CheckCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
                {t(m, mAr, lang)}
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
            [
              "End-to-end prototype: alert → call → verification → freeze → handoff",
              "نموذج أولي كامل: تنبيه → اتصال → تحقق → تجميد → تسليم",
            ],
            [
              "English + Arabic fully operational, dialect-tuned",
              "الإنجليزية والعربية تعملان بكامل طاقتهما، معايرة حسب اللهجة",
            ],
            ["Integration with mock banking systems", "تكامل كامل مع أنظمة بنكية محاكاة"],
            [
              "Test suite with 90%+ pass rate on primary flows",
              "حزمة اختبارات بنسبة نجاح تتجاوز ٩٠٪ على المسارات الرئيسية",
            ],
            [
              "Demonstrable audit trail + guardrail enforcement",
              "سجل تدقيق قابل للعرض مع فرض الضمانات",
            ],
          ].map(([c, cAr]) => (
            <div
              key={c}
              className="flex items-center gap-3 rounded-xl border border-line bg-white px-5 py-3.5"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                <CheckCheck className="h-3 w-3 text-white" />
              </span>
              <span className="text-[13.5px] font-medium">{t(c, cAr, lang)}</span>
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
              rAr: "قيادة الفريق",
              d: "12 years fraud detection systems at tier-1 banks",
              dAr: "١٢ عاماً في أنظمة كشف الاحتيال بمصارف من الدرجة الأولى",
              ar: "القيادة",
            },
            {
              r: "Conversational AI",
              rAr: "الذكاء المحادثي",
              d: "Four shipped ElevenLabs implementations",
              dAr: "أربع تطبيقات منفّذة على ElevenLabs",
              ar: "الذكاء المحادثي",
            },
            {
              r: "Full-stack Engineer",
              rAr: "مهندس Full-stack",
              d: "Banking API integration specialist",
              dAr: "أخصائي تكامل واجهات البنك",
              ar: "الهندسة",
            },
            {
              r: "Arabic Linguist + UX",
              rAr: "لغويات عربية + تجربة مستخدم",
              d: "Voice trust across Gulf dialects",
              dAr: "ثقة الصوت عبر اللهجات الخليجية",
              ar: "اللغويات",
            },
            {
              r: "Compliance",
              rAr: "الامتثال",
              d: "CBUAE regulatory experience",
              dAr: "خبرة تنظيمية لدى المصرف المركزي",
              ar: "الامتثال",
            },
            {
              r: "Track record",
              rAr: "سجلّ حافل",
              d: "50K+ voice calls / month, deployed",
              dAr: "أكثر من ٥٠ ألف مكالمة صوتية شهرياً، منفّذة فعلياً",
              ar: "الخبرة",
            },
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
              <p className="font-display mt-2 text-[15px] font-semibold">{t(m.r, m.rAr, lang)}</p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">{t(m.d, m.dAr, lang)}</p>
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
              {t(
                "securevoice.ai/demo — simulated fraud scenario · full call flow · mock banking integration",
                "securevoice.ai/demo — سيناريو احتيال محاكى · مسار المكالمة كاملاً · تكامل بنكي تجريبي",
                lang,
              )}
            </span>
          </div>
          <div className="grid gap-3 bg-paper p-5 sm:grid-cols-3">
            {[
              {
                icon: PhoneCall,
                t: "Trigger alert → call",
                tAr: "إطلاق التنبيه → الاتصال",
                d: "Watch the agent dial, greet, and lock language",
                dAr: "شاهد الوكيل يتصل، ويحيّي، ويثبّت اللغة",
              },
              {
                icon: FileCheck2,
                t: "Verify & confirm",
                tAr: "تحقق وتأكيد",
                d: "Challenge flow, zero secrets, plain-language confirmation",
                dAr: "مسار تحقق، بلا أسرار، وتأكيد بلغة واضحة",
              },
              {
                icon: Snowflake,
                t: "Freeze & handoff",
                tAr: "تجميد وتسليم",
                d: "API executes freeze; specialist receives context",
                dAr: "الواجهة تنفّذ التجميد؛ والأخصائي يستلم السياق",
              },
            ].map((c) => (
              <div key={c.t} className="rounded-xl border border-line bg-white p-4">
                <c.icon className="h-4 w-4 text-primary" />
                <p className="mt-2.5 text-[13px] font-semibold">{t(c.t, c.tAr, lang)}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">
                  {t(c.d, c.dAr, lang)}
                </p>
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
            {t("Open the live demo", "افتح العرض الحي", lang)}
          </button>
          <button
            onClick={() => setView("dashboard")}
            className="rounded-full border border-line px-5 py-2.5 text-[13px] font-semibold transition hover:border-primary/40 hover:text-primary"
          >
            {t("Open the dashboard", "افتح لوحة التحكم", lang)}
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
            {t("Detection is solved.", "الكشف محلول.", lang)}{" "}
            <span className="text-primary">
              {t("Intervention is not.", "التدخّل ليس كذلك.", lang)}
            </span>
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
        <Chip>{t("38 min → 60 s", "٣٨ دقيقة → ٦٠ ثانية", lang)}</Chip>
        <Chip>{t("AED 340M / year at stake", "٣٤٠ مليون درهم سنوياً", lang)}</Chip>
        <Chip>{t("6+ languages", "٦+ لغات", lang)}</Chip>
        <Chip>{t("CBUAE-aligned", "متوافق مع CBUAE", lang)}</Chip>
        <Chip>team@securevoice.ai</Chip>
      </div>
      <button
        onClick={() => setView("demo")}
        className="mt-8 flex w-fit items-center gap-2.5 rounded-full bg-[#0c110e] px-6 py-3.5 text-[14px] font-semibold text-white transition hover:bg-green-deep"
      >
        <RotateCcw className="h-4 w-4" />
        {t("Replay the whole demo from the start", "أعد تشغيل العرض الحي من البداية", lang)}
      </button>
    </div>
  );
}
