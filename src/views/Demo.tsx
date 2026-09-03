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
  type ScenarioEvent,
  type ScenarioKind,
  type Phase,
} from "@/lib/scenario";
import { useApp } from "@/lib/store";
import { Chip, LiveDot, Skeleton } from "@/components/fx/core";
import { Waveform, Equalizer } from "@/components/fx/Waveform";
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
    en: "The agent has exactly one write action: a temporary, reversible freeze (or transfer hold). Watch the API receipt land in the rail.",
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
  const [callLang, setCallLang] = useState<"en" | "ar">("en");
  const spokenRef = useRef<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);

  const SCEN = useMemo(() => buildScenario(kind), [kind]);
  const META = SCENARIO_LIBRARY.find((s) => s.kind === kind)!;
  const pick = (k: ScenarioKind) => {
    if (k === kind) return;
    setKind(k);
    setStarted(false);
    setRunning(false);
    setTime(0);
    spokenRef.current.clear();
    try {
      window.speechSynthesis.cancel();
    } catch {}
  };

  /* ——— playback engine ——— */
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => {
      setTime((prev) => {
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
    [time, started, SCEN]
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

  /* ——— browser TTS (best effort) ——— */
  useEffect(() => {
    if (!audioOn || !started) return;
    const latest = revealed[revealed.length - 1];
    if (!latest || spokenRef.current.has(latest.id)) return;
    if (latest.speaker !== "agent" && latest.speaker !== "customer") return;
    spokenRef.current.add(latest.id);
    try {
      const u = new SpeechSynthesisUtterance(callLang === "ar" ? latest.ar : latest.en);
      u.lang = callLang === "ar" ? "ar-SA" : "en-US";
      u.rate = 1.02;
      const voices = window.speechSynthesis.getVoices();
      const v = voices.find((x) => x.lang.startsWith(callLang === "ar" ? "ar" : "en"));
      if (v) u.voice = v;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {
      /* TTS unavailable — silent */
    }
  }, [revealed, audioOn, started, callLang]);

  useEffect(() => {
    if (!running) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
  }, [running]);

  /* ——— autoscroll transcript ——— */
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [revealed.length]);

  const start = () => {
    spokenRef.current.clear();
    try {
      window.speechSynthesis.cancel();
    } catch {}
    setTime(0);
    setStarted(true);
    setRunning(true);
  };
  const restart = () => {
    spokenRef.current.clear();
    try {
      window.speechSynthesis.cancel();
    } catch {}
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
            <span className="micro text-primary">Live simulation</span>
            <span className="h-px w-10 bg-line" />
            <span dir="rtl" className="font-arabic text-[13px] text-ink-3">محاكاة حية</span>
          </div>
          <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            One fraud alert. One minute. Watch the intervention.
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
                Simulate fraud alert
              </button>
              <span className="num hidden rounded-full border border-line bg-white px-3 py-1.5 text-[11px] text-ink-3 sm:block">
                PLAYBACK 2×
              </span>
            </>
          ) : (
            <>
              <button
                onClick={() => setRunning((r) => !r)}
                disabled={done}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-white text-foreground transition hover:border-primary/50 hover:text-primary disabled:opacity-40"
                aria-label={running ? "Pause" : "Play"}
              >
                {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
              <button
                onClick={restart}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-white text-foreground transition hover:border-primary/50 hover:text-primary"
                aria-label="Restart"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                onClick={skip}
                disabled={done}
                className="flex h-10 items-center gap-1.5 rounded-full border border-line bg-white px-3.5 text-[12.5px] font-semibold text-ink-2 transition hover:border-primary/50 hover:text-primary disabled:opacity-40"
              >
                <FastForward className="h-3.5 w-3.5" />
                Skip
              </button>
              {/* speed */}
              <div className="flex items-center rounded-full border border-line bg-white p-0.5">
                {[1, 1.5, 2].map((s) => (
                  <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    className={cn(
                      "num rounded-full px-2.5 py-1.5 text-[11.5px] font-semibold transition",
                      speed === s ? "bg-[#0c110e] text-white" : "text-ink-3 hover:text-foreground"
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
      <div className="mt-7 grid gap-3 sm:grid-cols-3">
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
                  : "border-line bg-white hover:border-primary/40"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "micro !text-[9.5px]",
                    sel ? "!text-green-deep" : "!text-ink-3"
                  )}
                >
                  {lang === "ar" ? m.vector.ar : m.vector.en}
                </span>
                <span
                  className={cn(
                    "num rounded-full px-2 py-0.5 text-[10px] font-bold",
                    sel ? "bg-red-soft text-white" : "bg-paper text-ink-3"
                  )}
                >
                  {m.risk}
                </span>
              </div>
              <p className="mt-2 text-[14px] font-semibold tracking-tight">
                {lang === "ar" ? m.title.ar : m.title.en}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
                {lang === "ar" ? m.desc.ar : m.desc.en}
              </p>
              <div className="mt-3 flex items-center justify-between">
                <span className="num text-[11px] font-semibold text-foreground">
                  {lang === "ar" ? m.amount.ar : m.amount.en}
                </span>
                <span
                  className={cn(
                    "text-[10.5px] font-semibold",
                    sel ? "text-green-deep" : "text-ink-3 group-hover:text-primary"
                  )}
                >
                  {sel ? (lang === "ar" ? "الحالة المحددة ✓" : "Selected ✓") : lang === "ar" ? "تشغيل هذه الحالة" : "Run this case →"}
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
                          : "border-line bg-white text-ink-3"
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
                        isDone || isCurrent ? "text-foreground" : "text-ink-3"
                      )}
                    >
                      {p.en}
                    </p>
                    <p dir="rtl" className="font-arabic whitespace-nowrap text-[10px] text-ink-3">
                      {p.ar}
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
                  <p className="num mt-1 text-[11px] text-white/50">{META.assetLine}</p>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                {started && !done && (
                  <span className="flex items-center gap-1.5 rounded-full bg-red-tint px-2.5 py-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-red-soft sv-blink" />
                    <span className="num text-[10.5px] font-bold text-red-soft">REC</span>
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
                speaking ? "text-primary" : "text-ink-3"
              )}
            >
              {speaking === "agent"
                ? "AGENT ▲"
                : speaking === "customer"
                  ? "CUST ▲"
                  : started
                    ? "——"
                    : "IDLE"}
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
                    Standing by for the next fraud signal
                  </p>
                  <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-ink-2">
                    Armed case:{" "}
                    <span className="font-semibold text-foreground">
                      {lang === "ar" ? META.title.ar : META.title.en}
                    </span>
                    . Fire the alert to push it through the risk engine — the agent will call,
                    verify, and stop the loss in one call.
                  </p>
                </div>
                <button
                  onClick={start}
                  className="flex items-center gap-2.5 rounded-full bg-primary px-7 py-3.5 text-[14.5px] font-semibold text-white shadow-[0_10px_26px_-8px_rgba(11,122,85,0.6)] transition hover:bg-green-deep"
                >
                  <Zap className="h-4 w-4" />
                  Simulate fraud alert now
                </button>
                <p className="num text-[10.5px] text-ink-3">
                  PLAYBACK 2× · FULL CALL ≈ 35 SECONDS
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
                <span className="num text-[10.5px] text-ink-3">TRANSCRIBING…</span>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {/* transcript controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-paper px-5 py-3 sm:px-6">
            <div className="flex items-center rounded-full border border-line bg-white p-0.5">
              {(["en", "ar"] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => setCallLang(l)}
                  className={cn(
                    "rounded-full px-3 py-1 text-[11.5px] font-semibold transition",
                    l === "ar" && "font-arabic",
                    callLang === l ? "bg-primary text-white" : "text-ink-3 hover:text-foreground"
                  )}
                >
                  {l === "en" ? "Transcript EN" : "النص عربي"}
                </button>
              ))}
            </div>
            <button
              onClick={() => setAudioOn((a) => !a)}
              className="flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-[11.5px] font-medium text-ink-2 transition hover:border-primary/40 hover:text-primary"
            >
              {audioOn ? <Volume2 className="h-3.5 w-3.5 text-primary" /> : <VolumeX className="h-3.5 w-3.5" />}
              Agent audio {audioOn ? "on" : "off"}
            </button>
          </div>
        </div>

        {/* ————— OPS RAIL ————— */}
        <div className="space-y-4">
          {/* alert card */}
          <RailCard
            icon={<CircleAlert className="h-4 w-4 text-red-soft" />}
            title="Fraud Alert"
            ar="إشارة الاحتيال"
            active={started}
          >
            {started ? (
              <div className="space-y-2.5 text-[12.5px]">
                <Row k="Risk score" v={META.risk} hot />
                <Row k="Amount" v={lang === "ar" ? META.amount.ar : META.amount.en} />
                <Row k="Merchant" v={lang === "ar" ? META.merchant.ar : META.merchant.en} />
                <Row k="Signals" v={lang === "ar" ? META.signals.ar : META.signals.en} />
                <Row k="Rule" v="P1 · SLA 60s" />
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
            title="Agent Pipeline"
            ar="مسار الوكيل"
            active={started}
          >
            <div className="space-y-2">
              {[
                { k: "webhook", t: 0 },
                { k: "queue · P1", t: 2 },
                { k: "dial · twilio", t: 4 },
                { k: "connected · 1.2s", t: 6 },
              ].map((s) => {
                const on = started && time >= s.t;
                return (
                  <div key={s.k} className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full transition-colors",
                        on ? "bg-primary" : "bg-[#d3d9d0]"
                      )}
                    />
                    <span
                      className={cn(
                        "num text-[11px]",
                        on ? "text-foreground" : "text-ink-3"
                      )}
                    >
                      {s.k}
                    </span>
                    {on && <span className="num ml-auto text-[10px] text-green-deep">ok</span>}
                  </div>
                );
              })}
            </div>
          </RailCard>

          {/* freeze */}
          <RailCard
            icon={<Snowflake className="h-4 w-4 text-primary" />}
            title="Protective Action"
            ar="إجراء الحماية"
            active={time >= 50}
          >
            {time >= 45 ? (
              <div>
                <p className="num text-[10.5px] leading-relaxed text-ink-2">{META.freezePath}</p>
                <pre className="num mt-2 overflow-x-auto rounded-lg bg-[#0c110e] p-3 text-[10.5px] leading-relaxed text-green-bright">
{time >= 50
  ? META.freezeOk.join("\n")
  : `→ awaiting customer
  confirmation…`}
                </pre>
                {time >= 50 && (
                  <div className="mt-2.5 flex items-center gap-2">
                    <CheckCheck className="h-3.5 w-3.5 text-green-deep" />
                    <span className="text-[11.5px] font-semibold text-green-deep">
                      {kind === "wire" ? "Transfer held — payee blocked" : "Card frozen — reversible"}
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
            title="Human Handoff"
            ar="التسليم"
            active={time >= 58}
          >
            {time >= 58 ? (
              <div className="space-y-2.5 text-[12.5px]">
                <Row k="Specialist" v="Sara H. · fraud desk" />
                <Row k="Case" v={`${META.caseId} · P1`} />
                <Row k="Context" v="verification + sentiment" />
                <div className="flex items-center gap-2 pt-1">
                  <FileCheck2 className="h-3.5 w-3.5 text-green-deep" />
                  <span className="text-[11.5px] font-semibold text-green-deep">
                    Audit log sealed · immutable
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

      {/* ——— what to watch for ——— */}
      <div className="mt-5 rounded-2xl border border-line bg-white px-5 py-3.5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-green-tint">
            <Eye className="h-3.5 w-3.5 text-primary" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <p className="micro !text-[9.5px] text-ink-3">
              {lang === "ar" ? "ما الذي تستحق المشاهدة" : "What to watch for"}
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
                {lang === "ar"
                  ? HINTS[started ? phase : "idle"].ar
                  : HINTS[started ? phase : "idle"].en}
              </motion.p>
            </AnimatePresence>
          </div>
          <span className="num ml-auto hidden shrink-0 text-[10px] text-ink-3 sm:block">
            {String(phaseIdx + 1).padStart(2, "0")}/07 ·{" "}
            {lang === "ar" ? PHASES[phaseIdx].ar : PHASES[phaseIdx].en}
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
                <p className="micro text-green-bright">Outcome · تم الحل</p>
                <div className="mt-4 flex items-baseline gap-3">
                  <span className="num text-6xl font-semibold">61</span>
                  <span className="num text-xl text-green-bright">seconds</span>
                  <span className="ml-2 text-[13px] text-white/55">vs 38 minutes today</span>
                </div>
                <p className="mt-3 max-w-lg text-[14px] leading-relaxed text-white/70">
                  Fraud signal → connected call → verified identity → confirmed fraud →{" "}
                  {kind === "wire" ? "transfer held" : "card frozen"} → warm handoff. Estimated
                  prevented loss:{" "}
                  <span className="num font-semibold text-white">
                    {lang === "ar" ? META.preventedLoss.ar : META.preventedLoss.en}
                  </span>
                  . Every step logged for CBUAE audit.
                </p>
              </div>
              <div className="flex flex-col gap-2.5">
                <button
                  onClick={restart}
                  className="flex items-center justify-center gap-2 rounded-full bg-green-bright px-6 py-3 text-[13.5px] font-semibold text-[#07130d] transition hover:bg-white"
                >
                  <RotateCcw className="h-4 w-4" />
                  Replay simulation
                </button>
                <button
                  onClick={() => useApp.getState().setView("dashboard")}
                  className="rounded-full border border-white/20 px-6 py-3 text-[13px] font-semibold text-white/85 transition hover:border-white/50"
                >
                  See it in the dashboard
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
  ar,
  active,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  ar: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border bg-white p-4.5 p-5 transition-all",
        active ? "border-primary/30 shadow-[0_14px_34px_-24px_rgba(11,122,85,0.45)]" : "border-line"
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-paper">
            {icon}
          </span>
          <span className="text-[13px] font-semibold">{title}</span>
        </div>
        <span dir="rtl" className="font-arabic text-[11px] text-ink-3">
          {ar}
        </span>
      </div>
      {children}
    </div>
  );
}

function Bubble({ e, callLang }: { e: ScenarioEvent; callLang: "en" | "ar" }) {
  const primary = callLang === "ar" ? e.ar : e.en;
  const secondary = callLang === "ar" ? e.en : e.ar;
  const primaryRtl = callLang === "ar";

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
            <Chip>{e.tag ?? "system"}</Chip>
            <span className="num text-[10px] text-ink-3">
              t+{e.t}s
            </span>
          </div>
          <p className="mt-1.5 text-[12.5px] font-medium leading-relaxed text-ink-2">
            {primary}
          </p>
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
            : "rounded-tr-md bg-green-tint text-foreground"
        )}
      >
        <div className="mb-1.5 flex items-center gap-2">
          {isAgent ? (
            <PhoneOutgoing className="h-3 w-3 text-green-bright" />
          ) : (
            <User className="h-3 w-3 text-green-deep" />
          )}
          <span
            className={cn(
              "micro !text-[9px]",
              isAgent ? "!text-green-bright" : "!text-green-deep"
            )}
          >
            {isAgent ? "Agent" : "Customer"}
          </span>
          <span className={cn("num text-[9.5px]", isAgent ? "text-white/40" : "text-ink-3")}>
            t+{e.t}s
          </span>
        </div>
        <p
          dir={primaryRtl ? "rtl" : "ltr"}
          className={cn(
            primaryRtl ? "font-arabic" : "",
            "text-[13.5px] leading-relaxed"
          )}
        >
          {primary}
        </p>
        <p
          dir={primaryRtl ? "ltr" : "rtl"}
          className={cn(
            primaryRtl ? "" : "font-arabic",
            "mt-1.5 border-t pt-1.5 text-[11px] leading-relaxed",
            isAgent ? "border-white/10 text-white/55" : "border-green-deep/10 text-ink-3"
          )}
        >
          {secondary}
        </p>
      </div>
    </motion.div>
  );
}
