"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play,
  Pause,
  RotateCcw,
  FastForward,
  Zap,
  PhoneCall,
  PhoneOutgoing,
  Webhook,
  Snowflake,
  Headset,
  FileCheck2,
  Volume2,
  VolumeX,
  CircleAlert,
  CheckCheck,
  Eye,
  User,
} from "lucide-react";
import {
  buildScenario,
  SCENARIO_LIBRARY,
  SCENARIO_TOTAL,
  PHASES,
  VOICE_BY_LANG,
  CALL_LANG_LABEL,
  eventText,
  type ScenarioEvent,
  type ScenarioKind,
  type Phase,
  type CallLang,
} from "@/lib/scenario";
import AmountDisplay from "@/components/AmountDisplay";
import {
  TTS_VOICE,
  speakText,
  stopVoice,
  prefetchSpeech,
  type VoiceRole,
} from "@/lib/voice-client";
import { useApp, t } from "@/lib/store";
import { Chip, LiveDot, Skeleton } from "@/components/fx/core";
import { Waveform, Equalizer } from "@/components/fx/Waveform";
import { LiveVoicePanel } from "@/components/demo/LiveVoicePanel";
import { cn } from "@/lib/utils";

const AGENT_DUR = 7.5; // virtual seconds agent "speaks" per line
const CUSTOMER_DUR = 3.2;

/** Phase-aware guidance shown under the player */
const HINTS: Record<Phase | "idle", { en: string; ar: string }> = {
  idle: {
    en: "Pick a fraud case below and fire the alert yourself — the 60-second SLA clock starts the moment the webhook lands.",
    ar: "اختر حالة احتيال أدناه وأطلق التنبيه بنفسك — تبدأ ساعة الستين ثانية لحظة وصول الويب هوك.",
  },
  alert: {
    en: "The SLA clock starts on the webhook — watch the timer in the stage header race the 60-second promise.",
    ar: "تبدأ ساعة الستين ثانية عند الويب هوك — راقب المؤقت في رأس المسرح قبل انتهاء المهلة.",
  },
  dial: {
    en: "The outbound call connects in about one second — the agent reaches the customer before the fraudster finishes their script.",
    ar: "يتم توصيل الاتصال الصادر خلال نحو ثانية — يصل الوكيل إلى العميل قبل أن يُكمل المحتال نصّه.",
  },
  intro: {
    en: "The agent announces that the call is recorded and confirms who it is speaking to — no secrets requested, ever.",
    ar: "يعلن الوكيل أن المكالمة مسجلة ويؤكد هوية الطرف الآخر — دون طلب أي أسرار أبداً.",
  },
  verify: {
    en: "Verification is merchant-based: two transactions the customer knows, one they don't. No PINs, no passwords, no OTPs.",
    ar: "التحقق يعتمد على المعاملات: عمليتان يعرفهما العميل وواحدة لا يعرفها. دون رموز سرية أو كلمات مرور.",
  },
  confirm: {
    en: "A precise, quoted confirmation — exact amount, exact merchant, explicit yes or no. Nothing vague is acted on.",
    ar: "تأكيد دقيق ومقتبس — المبلغ والمتجر بالتفصيل، ونعم أو لا صريحة. لا يُتخذ إجراء على أي غموض.",
  },
  action: {
    en: "The agent has exactly one write action: a temporary, reversible protective step — a card freeze, a transfer hold, or a claim-payout hold for an insurer — and a human confirms it. Watch the API receipt land in the rail.",
    ar: "للوكيل إجراء كتابي واحد فقط: تجميد مؤقت قابل للإلغاء (أو حجز حوالة). راقب وصول إيصال الـ API في الشريط.",
  },
  handoff: {
    en: "Everything travels with the warm handoff — transcript, verification method, sentiment, and the action receipt — and the audit log seals itself.",
    ar: "كل شيء ينتقل مع التسليم المباشر — النص، طريقة التحقق، المشاعر، وإيصال الإجراء — ثم يُقفل سجل التدقيق نفسه.",
  },
};

function eventDur(e: ScenarioEvent) {
  if (e.speaker === "agent") return AGENT_DUR + e.en.length / 40;
  if (e.speaker === "customer") return CUSTOMER_DUR;
  return 2.2;
}

export function Demo() {
  const { lang, demoIntent, consumeDemoIntent } = useApp();

  const [kind, setKind] = useState<ScenarioKind>("card");
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState(2);
  const [audioOn, setAudioOn] = useState(true);
  const [callLang, setCallLang] = useState<CallLang>("en");
  const spokenRef = useRef<Set<string>>(new Set());
  const audioBusyRef = useRef(false); // scenario clock freezes while a line is spoken
  const endRef = useRef<HTMLDivElement>(null);
  const speakSeq = useRef(0);

  const SCEN = useMemo(() => buildScenario(kind), [kind]);
  const META = SCENARIO_LIBRARY.find((s) => s.kind === kind)!;
  const pick = (k: ScenarioKind) => {
    if (k === kind) return;
    setKind(k);
    setStarted(false);
    setRunning(false);
    setTime(0);
    spokenRef.current.clear();
    stopVoice();
  };

  const pickLang = (l: CallLang) => {
    if (l === callLang) return;
    setCallLang(l);
    spokenRef.current.clear(); // re-speak subsequent lines in the new language
    stopVoice();
  };

  /* ——— playback engine ———
     The clock pauses while a line's audio is still speaking, so neural voice
     always finishes naturally instead of being cut off by the next phase. */
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => {
      setTime((prev) => {
        if (audioBusyRef.current) return prev; // voice owns the tempo
        const next = prev + 0.1 * speed;
        if (next >= SCENARIO_TOTAL) {
          setRunning(false);
          return SCENARIO_TOTAL;
        }
        return next;
      });
    }, 100);
    return () => clearInterval(iv);
  }, [running, speed]);

  const revealed = useMemo(
    () => (started ? SCEN.filter((e) => e.t <= time) : []),
    [time, started, SCEN],
  );
  const done = time >= SCENARIO_TOTAL;
  const phase: Phase = revealed.length ? revealed[revealed.length - 1].phase : "alert";
  const phaseIdx = PHASES.findIndex((p) => p.id === phase);

  /* ——— who is speaking right now ——— */
  const speaking = useMemo<"agent" | "customer" | null>(() => {
    for (let i = revealed.length - 1; i >= 0; i--) {
      const e = revealed[i];
      if (e.speaker === "agent" && time < e.t + eventDur(e)) return "agent";
      if (e.speaker === "customer" && time < e.t + eventDur(e)) return "customer";
      if (time >= e.t + eventDur(e)) break;
    }
    return null;
  }, [revealed, time]);

  /* ——— neural voice playback (server TTS, browser fallback) ——— */
  useEffect(() => {
    if (!audioOn || !started) return;
    const latest = revealed[revealed.length - 1];
    if (!latest || spokenRef.current.has(latest.id)) return;
    if (latest.speaker !== "agent" && latest.speaker !== "customer") return;
    spokenRef.current.add(latest.id);
    speakSeq.current += 1;
    const seq = speakSeq.current;
    stopVoice();
    audioBusyRef.current = true;
    const role: VoiceRole = latest.speaker === "agent" ? "agent" : "customer";
    const text = eventText(latest, callLang);
    speakText(text, callLang, role, Math.min(speed, 2)).then((neural) => {
      if (seq !== speakSeq.current) return; // a newer line owns the flag now
      audioBusyRef.current = false;
      if (!neural) return;
      /* browser fallback already spoken inside speakText */
    });
    // pre-warm the next spoken line so the reply starts without a gap
    const idx = SCEN.indexOf(latest);
    const next = SCEN.slice(idx + 1).find((e) => e.speaker === "agent" || e.speaker === "customer");
    if (next) {
      const ntext = eventText(next, callLang);
      prefetchSpeech(
        ntext,
        TTS_VOICE[callLang][next.speaker === "agent" ? "agent" : "customer"],
        callLang,
      );
    }
  }, [revealed, audioOn, started, callLang, speed, SCEN]);

  useEffect(() => {
    if (!running) stopVoice();
  }, [running]);

  /* unmount — release audio + mic-safe cleanup */
  useEffect(() => {
    return () => stopVoice();
  }, []);

  /* ——— autoscroll transcript ——— */
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [revealed.length]);

  const start = () => {
    spokenRef.current.clear();
    stopVoice();
    setTime(0);
    setStarted(true);
    setRunning(true);
  };
  const restart = () => {
    spokenRef.current.clear();
    stopVoice();
    setTime(0);
    setStarted(true);
    setRunning(true);
  };
  const skip = () => {
    setTime(SCENARIO_TOTAL);
    setRunning(false);
  };

  /* keep the latest start() closure available to one-shot effects */
  const startRef = useRef<() => void>(() => {});
  useEffect(() => {
    startRef.current = start;
  });

  /* ——— one-shot: a "launch live demo" CTA arrived (usually before mount) — begin playback ——— */
  useEffect(() => {
    if (!demoIntent) return;
    consumeDemoIntent();
    startRef.current();
  }, [demoIntent, consumeDemoIntent]);

  const elapsed = Math.floor(time);
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="mx-auto max-w-7xl scroll-mt-24 px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
      {/* ——— heading ——— */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <span className="micro text-primary">{t("Live simulation", "محاكاة حية", lang)}</span>
          </div>
          <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            {t(
              "One fraud alert. One minute. Watch the intervention.",
              "تنبيه احتيال واحد. دقيقة واحدة. شاهد التدخل.",
              lang,
            )}
          </h1>
        </div>
        {/* controls */}
        <div className="flex scroll-mt-24 flex-wrap items-center gap-2">
          {!started ? (
            <>
              <button
                onClick={start}
                className="flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-[13.5px] font-semibold text-white shadow-[0_8px_22px_-8px_rgba(11,122,85,0.6)] transition hover:bg-green-deep"
              >
                <Zap className="h-4 w-4" />
                {t("Simulate fraud alert", "محاكاة تنبيه احتيال", lang)}
              </button>
              <span className="num hidden rounded-full border border-line bg-white px-3 py-1.5 text-[11px] text-ink-3 sm:block">
                {t("PLAYBACK 2×", "تشغيل بسرعة 2×", lang)}
              </span>
            </>
          ) : (
            <>
              <button
                onClick={() => setRunning((r) => !r)}
                disabled={done}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-white text-foreground transition hover:border-primary/50 hover:text-primary disabled:opacity-40"
                aria-label={running ? t("Pause", "إيقاف مؤقت", lang) : t("Play", "تشغيل", lang)}
              >
                {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
              <button
                onClick={restart}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-white text-foreground transition hover:border-primary/50 hover:text-primary"
                aria-label={t("Restart", "إعادة التشغيل", lang)}
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                onClick={skip}
                disabled={done}
                className="flex h-10 items-center gap-1.5 rounded-full border border-line bg-white px-3.5 text-[12.5px] font-semibold text-ink-2 transition hover:border-primary/50 hover:text-primary disabled:opacity-40"
              >
                <FastForward className="h-3.5 w-3.5" />
                {t("Skip", "تخطٍّ", lang)}
              </button>
              {/* speed */}
              <div className="flex items-center rounded-full border border-line bg-white p-0.5">
                {[1, 1.5, 2].map((s) => (
                  <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    className={cn(
                      "num rounded-full px-2.5 py-1.5 text-[11.5px] font-semibold transition",
                      speed === s ? "bg-[#0c110e] text-white" : "text-ink-3 hover:text-foreground",
                    )}
                  >
                    {s}×
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ——— scenario picker ——— */}
      <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {SCENARIO_LIBRARY.map((m) => {
          const sel = m.kind === kind;
          return (
            <button
              key={m.kind}
              onClick={() => pick(m.kind)}
              aria-pressed={sel}
              className={cn(
                "group rounded-2xl border p-4 text-left transition-all",
                sel
                  ? "border-primary bg-green-tint shadow-[0_14px_34px_-24px_rgba(11,122,85,0.5)]"
                  : "border-line bg-white hover:border-primary/40",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn("micro !text-[9.5px]", sel ? "!text-green-deep" : "!text-ink-3")}
                >
                  {t(m.vector.en, m.vector.ar, lang)}
                </span>
                <span
                  className={cn(
                    "num rounded-full px-2 py-0.5 text-[10px] font-bold",
                    sel ? "bg-red-soft text-white" : "bg-paper text-ink-3",
                  )}
                >
                  {m.risk}
                </span>
              </div>
              <p className="mt-2 text-[14px] font-semibold tracking-tight">
                {t(m.title.en, m.title.ar, lang)}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
                {t(m.desc.en, m.desc.ar, lang)}
              </p>
              <div className="mt-3 flex items-center justify-between">
                <span className="font-semibold text-foreground">
                  {/* Layer 4: Intl-formatted currency — never shows "$" for AED */}
                  <AmountDisplay
                    amount={
                      parseFloat(
                        (m.amount.en || m.amount.ar || "0")
                          .replace(/[A-Z]/g, "")
                          .trim()
                          .replace(/,/g, ""),
                      ) || 0
                    }
                    currency="AED"
                  />
                </span>
                <span
                  className={cn(
                    "text-[10.5px] font-semibold",
                    sel ? "text-green-deep" : "text-ink-3 group-hover:text-primary",
                  )}
                >
                  {sel
                    ? t("Selected ✓", "الحالة المحددة ✓", lang)
                    : t("Run this case →", "تشغيل هذه الحالة", lang)}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* ——— phase stepper ——— */}
      <div className="mt-8 overflow-x-auto sv-scroll">
        <div className="flex min-w-[680px] items-start gap-0">
          {PHASES.map((p, i) => {
            const isDone = i < phaseIdx || done;
            const isCurrent = i === phaseIdx && !done;
            return (
              <div key={p.id} className="flex flex-1 items-start">
                <div className="flex flex-col items-center gap-2">
                  <span
                    className={cn(
                      "relative flex h-7 w-7 items-center justify-center rounded-full border text-[10.5px] font-bold transition-all",
                      isDone
                        ? "border-primary bg-primary text-white"
                        : isCurrent
                          ? "border-primary bg-green-tint text-green-deep"
                          : "border-line bg-white text-ink-3",
                    )}
                  >
                    {isDone ? <CheckCheck className="h-3.5 w-3.5" /> : p.n}
                    {isCurrent && (
                      <span className="sv-pulse-ring absolute inset-0 rounded-full text-primary" />
                    )}
                  </span>
                  <div className="text-center">
                    <p
                      className={cn(
                        "whitespace-nowrap text-[11px] font-semibold",
                        isDone || isCurrent ? "text-foreground" : "text-ink-3",
                      )}
                    >
                      {t(p.en, p.ar, lang)}
                    </p>
                  </div>
                </div>
                {i < PHASES.length - 1 && (
                  <div className={cn("sv-dots mt-[13px] h-[2px] w-full flex-1 opacity-70")} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ——— main grid ——— */}
      <div className="mt-8 grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
        {/* ————— CALL STAGE ————— */}
        <div className="overflow-hidden rounded-3xl border border-line bg-white shadow-[0_24px_60px_-40px_rgba(16,24,18,0.35)]">
          {/* stage header */}
          <div className="relative overflow-hidden bg-[#0c110e] px-5 py-4 sm:px-6">
            <div
              className="absolute inset-0 opacity-60"
              style={{
                background:
                  "radial-gradient(420px 160px at 20% 0%, rgba(20,163,116,0.28), transparent 60%)",
              }}
            />
            <div className="relative flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3.5">
                <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-green-bright/15 ring-1 ring-green-bright/30">
                  {done ? (
                    <PhoneCall className="h-5 w-5 text-green-bright" />
                  ) : (
                    <PhoneOutgoing className="h-5 w-5 text-green-bright" />
                  )}
                  {running && (
                    <span className="sv-pulse-ring absolute inset-0 rounded-full text-green-bright/70" />
                  )}
                </span>
                <div className="leading-tight">
                  <p className="text-[14px] font-semibold text-white">
                    {META.customer}{" "}
                    <span className="num ml-1 text-[11px] font-normal text-white/50">
                      {META.phone}
                    </span>
                  </p>
                  <p className="num mt-1 text-[11px] text-white/50">
                    {t("VOICE", "الصوت", lang)} · {VOICE_BY_LANG[callLang]} · {META.assetId}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                {started && !done && (
                  <span className="flex items-center gap-1.5 rounded-full bg-red-tint px-2.5 py-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-red-soft sv-blink" />
                    <span className="num text-[10.5px] font-bold text-red-soft">
                      {t("REC", "تسجيل", lang)}
                    </span>
                  </span>
                )}
                <span className="num rounded-full bg-white/10 px-3 py-1.5 text-[13px] font-semibold text-white">
                  {started ? `${mm}:${ss}` : "00:00"}
                </span>
              </div>
            </div>
          </div>

          {/* waveform strip */}
          <div className="flex items-center gap-3 border-b border-line bg-paper px-5 py-3 sm:px-6">
            <Equalizer active={speaking === "agent"} className="h-4 text-primary" />
            <Waveform
              active={!!speaking}
              intensity={speaking === "customer" ? 0.6 : 1}
              color={speaking === "customer" ? "#b97a11" : "#0b7a55"}
              className="h-12 w-full"
              bars={56}
            />
            <span
              className={cn(
                "num w-16 text-right text-[10.5px]",
                speaking ? "text-primary" : "text-ink-3",
              )}
            >
              {speaking === "agent"
                ? t("AGENT ▲", "الوكيل ▲", lang)
                : speaking === "customer"
                  ? t("CUST ▲", "العميل ▲", lang)
                  : started
                    ? "——"
                    : t("IDLE", "خامل", lang)}
            </span>
          </div>

          {/* transcript */}
          <div className="sv-scroll h-[420px] space-y-3.5 overflow-y-auto px-4 py-5 sm:px-6">
            {!started && (
              <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
                <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-green-tint">
                  <Zap className="h-6 w-6 text-primary" strokeWidth={1.6} />
                  <span className="sv-pulse-ring absolute inset-0 rounded-2xl text-primary/40" />
                </span>
                <div>
                  <p className="font-display text-lg font-semibold">
                    {t(
                      "Standing by for the next fraud signal",
                      "استعداداً لإشارة الاحتيال التالية",
                      lang,
                    )}
                  </p>
                  <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-ink-2">
                    {t("Armed case", "الحالة المُجهّزة", lang)}:{" "}
                    <span className="font-semibold text-foreground">
                      {t(META.title.en, META.title.ar, lang)}
                    </span>
                    .{" "}
                    {t(
                      "Fire the alert to push it through the risk engine — the agent will call, verify, and stop the loss in one call.",
                      "أطلق التنبيه ليدفعه عبر محرك المخاطر — سيتصل الوكيل بالعميل، ويتحقق من الهوية، ويوقف الخسارة في مكالمة واحدة.",
                      lang,
                    )}
                  </p>
                </div>
                <button
                  onClick={start}
                  className="flex items-center gap-2.5 rounded-full bg-primary px-7 py-3.5 text-[14.5px] font-semibold text-white shadow-[0_10px_26px_-8px_rgba(11,122,85,0.6)] transition hover:bg-green-deep"
                >
                  <Zap className="h-4 w-4" />
                  {t("Simulate fraud alert now", "محاكاة تنبيه الاحتيال الآن", lang)}
                </button>
                <p className="num text-[10.5px] text-ink-3">
                  {t(
                    "PLAYBACK 2× · FULL CALL ≈ 35 SECONDS",
                    "تشغيل بسرعة 2× · مكالمة كاملة ≈ 35 ثانية",
                    lang,
                  )}
                </p>
              </div>
            )}

            <AnimatePresence initial={false}>
              {revealed.map((e) => (
                <Bubble key={e.id} e={e} callLang={callLang} />
              ))}
            </AnimatePresence>
            {running && (
              <div className="flex items-center gap-2 pl-1">
                <span className="h-2 w-2 rounded-full bg-primary sv-blink" />
                <span className="num text-[10.5px] text-ink-3">
                  {t("TRANSCRIBING…", "جارٍ النسخ…", lang)}
                </span>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {/* transcript controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-paper px-5 py-3 sm:px-6">
            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-full border border-line bg-white p-0.5">
                {(["en", "ar", "hi", "ur", "fr", "sw"] as CallLang[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => pickLang(l)}
                    aria-pressed={callLang === l}
                    className={cn(
                      "rounded-full px-3 py-1 text-[11.5px] font-semibold transition",
                      (l === "ar" || l === "ur" || l === "hi") && "font-arabic",
                      callLang === l ? "bg-primary text-white" : "text-ink-3 hover:text-foreground",
                    )}
                  >
                    {l === "en"
                      ? "EN"
                      : l === "ar"
                        ? "عربي"
                        : l === "hi"
                          ? "हिन्दी"
                          : l === "fr"
                            ? "FR"
                            : l === "sw"
                              ? "SW"
                              : "اردو"}
                  </button>
                ))}
              </div>
              <span className="num hidden text-[9.5px] text-ink-3 lg:block">
                {t("CALL IN", "لغة المكالمة", lang)} {CALL_LANG_LABEL[callLang].toUpperCase()} ·{" "}
                {VOICE_BY_LANG[callLang]}
              </span>
            </div>
            <button
              onClick={() => setAudioOn((a) => !a)}
              aria-pressed={audioOn}
              className="flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-[11.5px] font-medium text-ink-2 transition hover:border-primary/40 hover:text-primary"
            >
              {audioOn ? (
                <Volume2 className="h-3.5 w-3.5 text-primary" />
              ) : (
                <VolumeX className="h-3.5 w-3.5" />
              )}
              {t("Agent audio", "صوت الوكيل", lang)}{" "}
              {audioOn ? t("on", "مُفعّل", lang) : t("off", "مُعطّل", lang)}
            </button>
          </div>
        </div>

        {/* ————— OPS RAIL ————— */}
        <div className="space-y-4">
          {/* alert card */}
          <RailCard
            icon={<CircleAlert className="h-4 w-4 text-red-soft" />}
            title={t("Fraud Alert", "إشارة الاحتيال", lang)}
            active={started}
          >
            {started ? (
              <div className="space-y-2.5 text-[12.5px]">
                <Row k={t("Risk score", "درجة الخطر", lang)} v={META.risk} hot />
                <Row k={t("Amount", "المبلغ", lang)} v={t(META.amount.en, META.amount.ar, lang)} />
                <Row
                  k={t("Merchant", "المتجر", lang)}
                  v={t(META.merchant.en, META.merchant.ar, lang)}
                />
                <Row
                  k={t("Signals", "الإشارات", lang)}
                  v={t(META.signals.en, META.signals.ar, lang)}
                />
                <Row k={t("Rule", "القاعدة", lang)} v="P1 · SLA 60s" />
              </div>
            ) : (
              <div className="space-y-2.5">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3.5 w-2/3" />
              </div>
            )}
          </RailCard>

          {/* pipeline */}
          <RailCard
            icon={<Webhook className="h-4 w-4 text-primary" />}
            title={t("Agent Pipeline", "مسار الوكيل", lang)}
            active={started}
          >
            <div className="space-y-2">
              {[
                { k: t("webhook", "ويب هوك", lang), t: 0 },
                { k: t("queue · P1", "قائمة الانتظار · P1", lang), t: 2 },
                { k: t("dial · twilio", "اتصال · twilio", lang), t: 4 },
                {
                  k:
                    kind === "voicemail"
                      ? t("answering machine · 1.4s", "رد آلي · 1.4 ثانية", lang)
                      : t("connected · 1.2s", "تم الاتصال · 1.2 ثانية", lang),
                  t: 6,
                },
              ].map((s) => {
                const on = started && time >= s.t;
                return (
                  <div key={s.k} className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full transition-colors",
                        on ? "bg-primary" : "bg-[#d3d9d0]",
                      )}
                    />
                    <span className={cn("num text-[11px]", on ? "text-foreground" : "text-ink-3")}>
                      {s.k}
                    </span>
                    {on && (
                      <span className="num ml-auto text-[10px] text-green-deep">
                        {t("ok", "تم", lang)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </RailCard>

          {/* freeze */}
          <RailCard
            icon={<Snowflake className="h-4 w-4 text-primary" />}
            title={t("Protective Action", "إجراء الحماية", lang)}
            active={time >= 50}
          >
            {time >= 45 ? (
              <div>
                <p className="num text-[10.5px] leading-relaxed text-ink-2">{META.freezePath}</p>
                <pre className="num mt-2 overflow-x-auto rounded-lg bg-[#0c110e] p-3 text-[10.5px] leading-relaxed text-green-bright">
                  {time >= 50
                    ? META.freezeOk.join("\n")
                    : `→ ${t("awaiting customer confirmation…", "في انتظار تأكيد العميل…", lang)}`}
                </pre>
                {time >= 50 && (
                  <div className="mt-2.5 flex items-center gap-2">
                    <CheckCheck className="h-3.5 w-3.5 text-green-deep" />
                    <span className="text-[11.5px] font-semibold text-green-deep">
                      {kind === "wire"
                        ? t(
                            "Transfer held — payee blocked",
                            "تم حجب الحوالة — المحال إليه محظور",
                            lang,
                          )
                        : kind === "claim"
                          ? t(
                              "Payout flagged for hold — a human confirms",
                              "تم تعليم مبلغ التعويض للحجب — يؤكّده إنسان",
                              lang,
                            )
                          : kind === "voicemail"
                            ? t(
                                "Case escalated to human review — nothing frozen automatically",
                                "تم تصعيد الحالة إلى مراجعة بشرية — لم يُجمّد شيء تلقائياً",
                                lang,
                              )
                            : t(
                                "Card frozen — reversible",
                                "تم تجميد البطاقة — قابل للإلغاء",
                                lang,
                              )}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2.5">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-14 w-full" />
              </div>
            )}
          </RailCard>

          {/* handoff */}
          <RailCard
            icon={<Headset className="h-4 w-4 text-amber-soft" />}
            title={t("Human Handoff", "التسليم لأخصائي", lang)}
            active={time >= 58}
          >
            {time >= 58 ? (
              <div className="space-y-2.5 text-[12.5px]">
                <Row k={t("Specialist", "الأخصائي", lang)} v="Sara H. · fraud desk" />
                <Row k={t("Case", "الحالة", lang)} v={`${META.caseId} · P1`} />
                <Row
                  k={t("Context", "السياق", lang)}
                  v={t("verification + sentiment", "التحقق + المشاعر", lang)}
                />
                <div className="flex items-center gap-2 pt-1">
                  <FileCheck2 className="h-3.5 w-3.5 text-green-deep" />
                  <span className="text-[11.5px] font-semibold text-green-deep">
                    {t(
                      "Audit log sealed · immutable",
                      "سجل التدقيق مُغلق · غير قابل للتغيير",
                      lang,
                    )}
                  </span>
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3.5 w-1/2" />
              </div>
            )}
          </RailCard>
        </div>
      </div>

      {/* ——— LIVE CONVERSATION: talk to the agent ——— */}
      <LiveVoicePanel callLang={callLang} />

      {/* ——— what to watch for ——— */}
      <div className="mt-5 rounded-2xl border border-line bg-white px-5 py-3.5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-green-tint">
            <Eye className="h-3.5 w-3.5 text-primary" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <p className="micro !text-[9.5px] text-ink-3">
              {t("What to watch for", "ما الذي تستحق المشاهدة", lang)}
            </p>
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={started ? phase : "idle"}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                className="mt-1 text-[13px] leading-relaxed text-ink-2"
              >
                {t(HINTS[started ? phase : "idle"].en, HINTS[started ? phase : "idle"].ar, lang)}
              </motion.p>
            </AnimatePresence>
          </div>
          <span className="num ml-auto hidden shrink-0 text-[10px] text-ink-3 sm:block">
            {String(phaseIdx + 1).padStart(2, "0")}/07 ·{" "}
            {t(PHASES[phaseIdx].en, PHASES[phaseIdx].ar, lang)}
          </span>
        </div>
      </div>

      {/* ——— OUTCOME BANNER ——— */}
      <AnimatePresence>
        {done && (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="relative mt-6 overflow-hidden rounded-3xl bg-[#0c110e] p-8 text-white sm:p-10"
          >
            <div
              className="absolute inset-0"
              style={{
                background:
                  "radial-gradient(600px 220px at 80% 0%, rgba(20,163,116,0.3), transparent 60%)",
              }}
            />
            <div className="relative flex flex-wrap items-center justify-between gap-8">
              <div>
                <p className="micro text-green-bright">
                  {t("Outcome · resolved", "النتيجة · تم الحل", lang)}
                </p>
                <div className="mt-4 flex items-baseline gap-3">
                  <span className="num text-6xl font-semibold">
                    {kind === "voicemail" ? "66" : "61"}
                  </span>
                  <span className="num text-xl text-green-bright">
                    {t("seconds", "ثانية", lang)}
                  </span>
                  <span className="ml-2 text-[13px] text-white/55">
                    {kind === "voicemail"
                      ? t(
                          "demo time — a real SMS reply arrives when the customer answers",
                          "زمن العرض — يصل رد SMS حقيقي عندما يجيب العميل",
                          lang,
                        )
                      : t("vs 38 minutes today", "مقابل 38 دقيقة اليوم", lang)}
                  </span>
                </div>
                <p className="mt-3 max-w-lg text-[14px] leading-relaxed text-white/70">
                  {kind === "voicemail" ? (
                    <>
                      {t(
                        "Fraud signal → voicemail → blind-ping SMS → customer replies NO →",
                        "إشارة احتيال → بريد صوتي → رسالة SMS تُرسل دون رد → يجيب العميل بـ لا →",
                        lang,
                      )}
                    </>
                  ) : (
                    <>
                      {t(
                        "Fraud signal → connected call → verified identity → confirmed fraud →",
                        "إشارة احتيال → اتصال ناجح → هوية موثّقة → احتيال مؤكد →",
                        lang,
                      )}
                    </>
                  )}
                  {kind === "wire"
                    ? t("transfer held", "تم حجب الحوالة", lang)
                    : kind === "claim"
                      ? t("payout flagged for hold", "تم تعليم التعويض للحجب", lang)
                      : kind === "voicemail"
                        ? t("SMS verdict", "حكم الرسالة النصية", lang)
                        : t("card frozen", "تم تجميد البطاقة", lang)}{" "}
                  →{" "}
                  {kind === "voicemail"
                    ? t("human review", "مراجعة بشرية", lang)
                    : t("warm handoff", "تسليم مباشر", lang)}
                  .{" "}
                  {kind === "voicemail"
                    ? t("Exposure under review:", "الخسارة المحتملة قيد المراجعة:", lang)
                    : t("Estimated prevented loss:", "الخسائر المُنعّة التقديرية:", lang)}{" "}
                  <span className="num font-semibold text-white">
                    {t(META.preventedLoss.en, META.preventedLoss.ar, lang)}
                  </span>
                  .{" "}
                  {t(
                    "Every step logged for CBUAE audit.",
                    "كل خطوة مسجّلة لتدقيق مصرف الإمارات المركزي.",
                    lang,
                  )}
                </p>
              </div>
              <div className="flex flex-col gap-2.5">
                <button
                  onClick={restart}
                  className="flex items-center justify-center gap-2 rounded-full bg-green-bright px-6 py-3 text-[13.5px] font-semibold text-[#07130d] transition hover:bg-white"
                >
                  <RotateCcw className="h-4 w-4" />
                  {t("Replay simulation", "إعادة تشغيل المحاكاة", lang)}
                </button>
                <button
                  onClick={() => useApp.getState().setView("dashboard")}
                  className="rounded-full border border-white/20 px-6 py-3 text-[13px] font-semibold text-white/85 transition hover:border-white/50"
                >
                  {t("See it in the dashboard", "شاهدها في لوحة التحكم", lang)}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ————— helpers ————— */

function Row({ k, v, hot }: { k: string; v: string; hot?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-3">{k}</span>
      <span className={cn("num text-right font-medium", hot ? "text-red-soft" : "text-foreground")}>
        {v}
      </span>
    </div>
  );
}

function RailCard({
  icon,
  title,
  active,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border bg-white p-4.5 p-5 transition-all",
        active
          ? "border-primary/30 shadow-[0_14px_34px_-24px_rgba(11,122,85,0.45)]"
          : "border-line",
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-paper">
            {icon}
          </span>
          <span className="text-[13px] font-semibold">{title}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

function Bubble({ e, callLang }: { e: ScenarioEvent; callLang: CallLang }) {
  const { lang } = useApp();
  const primary = eventText(e, callLang);
  const secondary = callLang === "en" ? e.ar : e.en;
  const primaryRtl = callLang === "ar" || callLang === "ur";

  if (e.speaker === "system") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex items-start gap-3 py-1"
      >
        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#0c110e]">
          <Zap className="h-3 w-3 text-green-bright" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Chip>{e.tag ?? t("system", "النظام", lang)}</Chip>
            <span className="num text-[10px] text-ink-3">t+{e.t}s</span>
          </div>
          <p className="mt-1.5 text-[12.5px] font-medium leading-relaxed text-ink-2">{primary}</p>
          {primaryRtl ? (
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">{secondary}</p>
          ) : (
            <p dir="rtl" className="font-arabic mt-0.5 text-[11.5px] leading-relaxed text-ink-3">
              {secondary}
            </p>
          )}
        </div>
      </motion.div>
    );
  }

  if (e.speaker === "api") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="rounded-xl border border-[#ecdcb8] bg-amber-tint px-3.5 py-2.5"
      >
        <div className="flex items-center gap-2">
          <Webhook className="h-3 w-3 text-amber-soft" />
          <Chip className="!border-[#ecdcb8] !bg-white">{e.tag}</Chip>
          <span className="num ml-auto text-[10px] text-ink-3">t+{e.t}s</span>
        </div>
        <p className="num mt-2 text-[11.5px] leading-relaxed text-ink-2">{primary}</p>
        {!primaryRtl && (
          <p dir="rtl" className="font-arabic mt-1 text-[11px] leading-relaxed text-ink-3">
            {secondary}
          </p>
        )}
      </motion.div>
    );
  }

  const isAgent = e.speaker === "agent";
  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className={cn("flex", isAgent ? "justify-start" : "justify-end")}
    >
      <div
        className={cn(
          "max-w-[88%] rounded-2xl px-4 py-3 sm:max-w-[80%]",
          isAgent
            ? "rounded-tl-md bg-[#0c110e] text-white"
            : "rounded-tr-md bg-green-tint text-foreground",
        )}
      >
        <div className="mb-1.5 flex items-center gap-2">
          {isAgent ? (
            <PhoneOutgoing className="h-3 w-3 text-green-bright" />
          ) : (
            <User className="h-3 w-3 text-green-deep" />
          )}
          <span
            className={cn("micro !text-[9px]", isAgent ? "!text-green-bright" : "!text-green-deep")}
          >
            {isAgent ? t("Agent", "الوكيل", lang) : t("Customer", "العميل", lang)}
          </span>
          <span className={cn("num text-[9.5px]", isAgent ? "text-white/40" : "text-ink-3")}>
            t+{e.t}s
          </span>
        </div>
        <p
          dir={primaryRtl ? "rtl" : "ltr"}
          className={cn(primaryRtl ? "font-arabic" : "", "text-[13.5px] leading-relaxed")}
        >
          {primary}
        </p>
        <p
          dir={primaryRtl ? "ltr" : "rtl"}
          className={cn(
            primaryRtl ? "" : "font-arabic",
            "mt-1.5 border-t pt-1.5 text-[11px] leading-relaxed",
            isAgent ? "border-white/10 text-white/55" : "border-green-deep/10 text-ink-3",
          )}
        >
          {secondary}
        </p>
      </div>
    </motion.div>
  );
}
