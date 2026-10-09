"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Mic,
  Square,
  Loader2,
  AudioLines,
  PhoneOutgoing,
  Fingerprint,
  SendHorizontal,
  User,
} from "lucide-react";
import { useApp } from "@/lib/store";
import { VOICE_BY_LANG, type CallLang } from "@/lib/scenario";
import { blobToWavBase64, streamSpeech } from "@/lib/voice-client";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * LIVE CONVERSATION — real STT (mic or typed) → guardrailed agent
 * intent routing → neural voice reply.
 *
 * Shared surface: the same component backs the landing page's public
 * "talk to the agent" widget and the Demo view's conversation panel, so
 * the two can never drift. No authentication is required here — the
 * /api/asr, /api/agent and /api/tts/stream endpoints accept anonymous
 * callers and rate-limit them per IP, which is exactly the surface a
 * signed-out judge uses.
 */

type Turn = {
  id: number;
  role: "you" | "agent";
  text: string;
  intent?: string;
  action?: string;
  escalate?: boolean;
  escalationReason?: string;
  latencyMs?: number;
  asrMs?: number;
};

type ConvPhase = "idle" | "recording" | "asr" | "agent" | "speaking";

const CONV_STATUS: Record<ConvPhase, { en: string; ar: string }> = {
  idle: { en: "Press to speak — or type below", ar: "اضغط للتحدث — أو اكتب أدناه" },
  recording: { en: "Listening… tap to finish", ar: "يستمع… اضغط للإنهاء" },
  asr: { en: "Transcribing speech…", ar: "جارٍ تحويل الكلام إلى نص…" },
  agent: { en: "Agent routing the turn…", ar: "الوكيل يوجه الطلب…" },
  speaking: { en: "Agent replying by voice…", ar: "الوكيل يرد صوتياً…" },
};

const INTENT_CHIP: Record<string, { label: string; tone: string }> = {
  deny_fraud: { label: "intent: deny_fraud", tone: "bg-red-tint text-red-soft" },
  confirm_authorized: {
    label: "intent: confirm_authorized",
    tone: "bg-green-tint text-green-deep",
  },
  greeting: { label: "intent: greeting", tone: "bg-paper text-ink-2" },
  unclear: { label: "intent: clarify", tone: "bg-amber-tint text-amber-soft" },
};

export function LiveVoicePanel({ callLang }: { callLang: CallLang }) {
  const { lang } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState<ConvPhase>("idle");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const turnId = useRef(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const autoStop = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakSeq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  /* scroll the conversation */
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, phase]);

  /* cleanup on unmount + language switch */
  useEffect(() => {
    return () => {
      if (autoStop.current) clearTimeout(autoStop.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recRef.current?.state === "recording") recRef.current.stop();
      speakSeq.current += 1;
    };
  }, []);
  useEffect(() => {
    speakSeq.current += 1; // kill in-flight replies on language switch
  }, [callLang]);

  const speakReply = (text: string) => {
    setPhase("speaking");
    speakSeq.current += 1;
    const seq = speakSeq.current;
    // streaming first (ElevenLabs chunked pipe + barge-in), buffered fallback
    streamSpeech(text, callLang, "agent", 1)
      .catch(() => ({ streamed: false, bargeIn: false }))
      .then(() => {
        if (seq === speakSeq.current) setPhase("idle");
      });
  };

  const sendTurn = async (text: string, asrMs?: number) => {
    const clean = text.trim();
    if (!clean || clean.length > 600) return;
    setError(null);
    turnId.current += 1;
    const youId = turnId.current;
    setTurns((p) => [...p, { id: youId, role: "you", text: clean, asrMs }]);
    setPhase("agent");
    const started = performance.now();
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean, lang: callLang }),
      });
      const data = await res.json().catch(() => ({ error: "Unreadable response" }));
      if (!res.ok || !data.reply) throw new Error(data.error || "Agent unavailable");
      turnId.current += 1;
      setTurns((p) => [
        ...p,
        {
          id: turnId.current,
          role: "agent",
          text: data.reply,
          intent: data.intent,
          action: data.action,
          escalate: data.escalate as boolean | undefined,
          escalationReason: data.escalationReason as string | undefined,
          latencyMs: data.latencyMs ?? Math.round(performance.now() - started),
        },
      ]);
      speakReply(data.reply);
    } catch (e) {
      setError(
        lang === "ar"
          ? "لم يستجب الوكيل — حاول مرة أخرى أو اكتب سؤالك."
          : "The agent did not respond — try again or type your answer.",
      );
      setPhase("idle");
    }
  };

  const startRec = async () => {
    setError(null);
    if (phase !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError(
        lang === "ar"
          ? "الميكروفون غير مدعوم — اكتب إجابتك."
          : "Microphone unsupported here — type your answer below.",
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => finishRecording();
      mr.start();
      recRef.current = mr;
      setPhase("recording");
      autoStop.current = setTimeout(() => stopRec(), 15000);
    } catch {
      setError(
        lang === "ar"
          ? "تعذّر الوصول إلى الميكروفون — اسمح بالوصول أو اكتب إجابتك."
          : "Microphone blocked — allow access or type your answer below.",
      );
    }
  };

  const stopRec = () => {
    if (autoStop.current) clearTimeout(autoStop.current);
    if (recRef.current?.state === "recording") recRef.current.stop();
  };

  const finishRecording = async () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const blob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || "audio/webm" });
    if (blob.size < 1200) {
      setError(lang === "ar" ? "لم نسمع شيئاً — حاول مجدداً." : "Didn't catch anything — try again.");
      setPhase("idle");
      return;
    }
    setPhase("asr");
    const t0 = performance.now();
    try {
      const b64 = await blobToWavBase64(blob);
      const res = await fetch("/api/asr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: b64, mime: "audio/wav", lang: callLang }),
      });
      const data = await res.json().catch(() => ({ error: "Unreadable response" }));
      if (!res.ok || !data.text) throw new Error(data.error || "Transcription failed");
      await sendTurn(data.text, Math.round(performance.now() - t0));
    } catch (e) {
      setError(
        (e instanceof Error && e.message) ||
          (lang === "ar"
            ? "فشل التحويل — اكتب إجابتك."
            : "Transcription failed — type your answer below."),
      );
      setPhase("idle");
    }
  };

  const busy = phase !== "idle" && phase !== "recording";
  const status = CONV_STATUS[phase];

  return (
    <section className="overflow-hidden rounded-3xl border border-line bg-white shadow-[0_24px_60px_-40px_rgba(16,24,18,0.35)]">
      {/* header */}
      <div className="relative flex flex-wrap items-center justify-between gap-3 overflow-hidden bg-[#0c110e] px-5 py-4 sm:px-6">
        <div
          className="absolute inset-0 opacity-50"
          style={{
            background:
              "radial-gradient(420px 150px at 15% 0%, rgba(20,163,116,0.3), transparent 60%)",
          }}
        />
        <div className="relative flex items-center gap-3">
          <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-green-bright/15 ring-1 ring-green-bright/30">
            <AudioLines className="h-5 w-5 text-green-bright" />
            {phase === "recording" && (
              <span className="sv-pulse-ring absolute inset-0 rounded-full text-green-bright/70" />
            )}
          </span>
          <div className="leading-tight">
            <p className="text-[14px] font-semibold text-white">
              {lang === "ar" ? "تحدّث مع الوكيل" : "Talk to the agent"}{" "}
              <span dir="rtl" className="font-arabic text-[12px] font-normal text-white/55">
                · تحدث مع الوكيل
              </span>
            </p>
            <p className="num mt-1 text-[10.5px] text-white/50">
              REAL STT → GUARDRAILED ROUTING → NEURAL VOICE · {VOICE_BY_LANG[callLang]}
            </p>
          </div>
        </div>
        <span className="relative flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[10.5px] font-semibold text-white/80">
          <Fingerprint className="h-3 w-3 text-green-bright" />
          {lang === "ar" ? "لا رموز سرية · أبداً" : "No PINs · No OTPs · Ever"}
        </span>
      </div>

      <div className="grid lg:grid-cols-[0.92fr_1.08fr]">
        {/* left — controls */}
        <div className="flex flex-col items-center gap-4 border-b border-line px-6 py-6 lg:border-b-0 lg:border-r">
          <p className="max-w-sm text-center text-[12.5px] leading-relaxed text-ink-2">
            {lang === "ar"
              ? "أجب كما يجابة العميل. تحدّث عبر الميكروفون — أو اكتب — ويستجيب خط الأنابيب الحقيقي: التعرّف على الكلام، التوجيه المحكوم، ورد صوتي عصبي بـ"
              : "Answer as the customer would. Speak into your microphone — or type — and the real pipeline responds: speech recognition, deterministic guardrail routing, and a neural voice reply in "}
            <span className="font-semibold text-foreground">
              {callLang === "ar"
                ? "العربية"
                : callLang === "hi"
                  ? "हिन्दी"
                  : callLang === "ur"
                    ? "اردو"
                    : callLang === "fr"
                      ? "Français"
                      : callLang === "sw"
                        ? "Kiswahili"
                        : "English"}
            </span>
            .
          </p>

          <button
            onClick={phase === "recording" ? stopRec : startRec}
            disabled={busy}
            aria-label={phase === "recording" ? "Stop recording" : "Start recording"}
            className={cn(
              "relative flex h-16 w-16 items-center justify-center rounded-full transition-all",
              phase === "recording"
                ? "bg-red-soft text-white"
                : busy
                  ? "bg-paper text-ink-3"
                  : "bg-primary text-white hover:bg-green-deep",
            )}
          >
            {phase === "recording" ? (
              <Square className="h-5 w-5 fill-current" />
            ) : busy ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <Mic className="h-6 w-6" strokeWidth={1.8} />
            )}
            {phase === "recording" && (
              <span className="sv-pulse-ring absolute inset-0 rounded-full text-red-soft/60" />
            )}
          </button>

          <p
            className={cn(
              "text-[12px] font-medium",
              phase === "recording" ? "text-red-soft" : "text-ink-3",
            )}
          >
            {lang === "ar" ? status.ar : status.en}
          </p>

          <div className="flex w-full max-w-sm items-center gap-2">
            <div className="h-px flex-1 bg-line" />
            <span className="text-[10.5px] text-ink-3">
              {lang === "ar" ? "أو اكتب بدلاً من ذلك" : "or type instead"}
            </span>
            <div className="h-px flex-1 bg-line" />
          </div>

          <form
            className="flex w-full max-w-sm items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!typed.trim() || busy) return;
              sendTurn(typed);
              setTyped("");
            }}
          >
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={
                callLang === "ar"
                  ? "مثال: هذه العملية ليست مني"
                  : callLang === "hi"
                    ? "जैसे: यह मेरा लेनदेन नहीं है"
                    : callLang === "ur"
                      ? "مثال: یہ لین دین میرا نہیں ہے"
                      : callLang === "sw"
                        ? "Mfano: hili si jambo langu"
                        : callLang === "fr"
                          ? 'ex. « cette transaction n\'est pas la mienne »'
                          : 'e.g. "That transaction is not mine"'
              }
              maxLength={600}
              className="h-10 flex-1 rounded-full border-line bg-paper px-4"
              aria-label="Type your answer"
            />
            <button
              type="submit"
              disabled={!typed.trim() || busy}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-white transition hover:bg-green-deep disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send"
            >
              <SendHorizontal className="h-4 w-4" />
            </button>
          </form>

          {error && (
            <p className="max-w-sm rounded-xl bg-red-tint px-3.5 py-2 text-center text-[11.5px] font-medium text-red-soft">
              {error}
            </p>
          )}
        </div>

        {/* right — conversation transcript */}
        <div className="flex flex-col">
          <div
            ref={listRef}
            role="log"
            aria-label="Live conversation transcript"
            aria-live="polite"
            className="sv-scroll h-[340px] space-y-3.5 overflow-y-auto px-5 py-5 sm:px-6"
          >
            {turns.length === 0 && phase === "idle" && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-green-tint">
                  <Mic className="h-5 w-5 text-primary" strokeWidth={1.7} />
                </span>
                <p className="max-w-xs text-[13px] leading-relaxed text-ink-2">
                  {lang === "ar" ? (
                    <>
                      لا توجد أدوار بعد. قل{" "}
                      <span className="font-semibold text-foreground">«هذه العملية ليست مني»</span>{" "}
                      لتشغيل إجراء الحماية — أو{" "}
                      <span className="font-semibold text-foreground">«عمليتي»</span> لإغلاق
                      المراجعة.
                    </>
                  ) : (
                    <>
                      No turns yet. Say{" "}
                      <span className="font-semibold text-foreground">
                        “that transaction is not mine”
                      </span>{" "}
                      to trigger the protective action — or{" "}
                      <span className="font-semibold text-foreground">“it&apos;s mine”</span> to
                      close the review.
                    </>
                  )}
                </p>
              </div>
            )}

            {turns.map((t) =>
              t.role === "you" ? (
                <motion.div
                  key={t.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex justify-end"
                >
                  <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-green-tint px-4 py-3">
                    <div className="mb-1 flex items-center gap-2">
                      <User className="h-3 w-3 text-green-deep" />
                      <span className="micro !text-[9px] !text-green-deep">
                        {lang === "ar" ? "أنت" : "You"}
                        {typeof t.asrMs === "number" && (
                          <span className="num"> · ASR {t.asrMs}ms</span>
                        )}
                      </span>
                    </div>
                    <p
                      className={cn(
                        "text-[13px] leading-relaxed",
                        callLang === "ar" && "font-arabic",
                      )}
                      dir={callLang === "ar" || callLang === "ur" ? "rtl" : "ltr"}
                    >
                      {t.text}
                    </p>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key={t.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex justify-start"
                >
                  <div className="max-w-[88%] rounded-2xl rounded-tl-md bg-[#0c110e] px-4 py-3 text-white">
                    <div className="mb-1 flex items-center gap-2">
                      <PhoneOutgoing className="h-3 w-3 text-green-bright" />
                      {t.escalate && (
                        <span
                          className="micro !text-[8.5px] rounded-full bg-red-soft/20 px-1.5 py-0.5 !text-red-soft"
                          title={t.escalationReason}
                        >
                          {lang === "ar" ? "تسليم بشري" : "HUMAN TALKOVER"}
                        </span>
                      )}
                      <span className="micro !text-[9px] !text-green-bright">
                        {lang === "ar" ? "الوكيل · " : "Agent · "}
                        {VOICE_BY_LANG[callLang].split(" ")[0]}
                      </span>
                      {typeof t.latencyMs === "number" && (
                        <span className="num text-[9.5px] text-white/40">turn {t.latencyMs}ms</span>
                      )}
                    </div>
                    <p
                      className={cn(
                        "text-[13px] leading-relaxed",
                        callLang === "ar" && "font-arabic",
                      )}
                      dir={callLang === "ar" || callLang === "ur" ? "rtl" : "ltr"}
                    >
                      {t.text}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-white/10 pt-2">
                      {t.intent && (
                        <span
                          className={cn(
                            "num rounded-full px-2 py-0.5 text-[9.5px] font-bold",
                            INTENT_CHIP[t.intent]?.tone ?? "bg-white/10 text-white/70",
                          )}
                        >
                          {INTENT_CHIP[t.intent]?.label ?? t.intent}
                        </span>
                      )}
                      {t.action === "card_freeze" && (
                        <span className="num rounded-full bg-green-bright/15 px-2 py-0.5 text-[9.5px] font-bold text-green-bright">
                          action: card_freeze · {lang === "ar" ? "قابل للإلغاء" : "reversible"}
                        </span>
                      )}
                      {t.action === "none" && (
                        <span className="num rounded-full bg-white/10 px-2 py-0.5 text-[9.5px] font-bold text-white/70">
                          action: none · {lang === "ar" ? "أُغلقت المراجعة" : "review closed"}
                        </span>
                      )}
                      {t.action === "clarify" && (
                        <span className="num rounded-full bg-white/10 px-2 py-0.5 text-[9.5px] font-bold text-white/70">
                          action: clarify · {lang === "ar" ? "لم يُنفّذ شيء" : "nothing executed"}
                        </span>
                      )}
                    </div>
                  </div>
                </motion.div>
              ),
            )}

            {(phase === "asr" || phase === "agent") && (
              <div className="flex items-center gap-2 pl-1">
                <span className="h-2 w-2 rounded-full bg-primary sv-blink" />
                <span className="num text-[10.5px] text-ink-3">
                  {phase === "asr" ? "SCRIBE · TRANSCRIBING…" : "AGENT · ROUTING…"}
                </span>
              </div>
            )}
          </div>
          <div className="border-t border-line bg-paper px-5 py-2.5 sm:px-6">
            <p className="text-[10.5px] leading-relaxed text-ink-3">
              {lang === "ar"
                ? "الضمانات على هذا الخط: لا يطلب الوكيل أبداً رمزاً سرياً أو كلمة مرور أو رمز تحقق؛ يمكنه تنفيذ إجراء كتابي واحد معتمد مسبقاً (تجميد مؤقت للبطاقة)؛ ويُكتب كل دور في سجل التدقيق."
                : "Guardrails on this line: the agent never asks for PINs, passwords, or one-time passcodes; it can execute exactly one pre-approved write action (temporary card freeze); every turn is written to the audit log."}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
