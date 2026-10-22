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
import { useApp, t } from "@/lib/store";
import { VOICE_BY_LANG, type CallLang } from "@/lib/scenario";
import {
  blobToWavBase64,
  stopVoice,
  streamSpeech,
  STRICT_VOICE_UNAVAILABLE,
} from "@/lib/voice-client";
import { Input } from "@/components/ui/input";
import { PanelHeader } from "@/components/ui/PanelHeader";
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
  /**
   * How this turn was produced. A typed turn has no caller speech end and no
   * ASR, so its `latencyMs` is the routing span only; calling that a "turn"
   * would publish a faster product than a phone caller experiences. A spoken
   * turn starts the clock when the caller stops speaking (push-to-talk here),
   * so ASR + routing is the honest total.
   */
  modality: "typed" | "spoken";
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
  /**
   * This panel's mount IS one call. The server counts consecutive unclear turns
   * against `callRef` and hands a caller who cannot be understood over to a human
   * after four; send nothing and every request looks like a fresh call, so that
   * ceiling is unreachable from the surface judges actually use.
   */
  const callRefRef = useRef<string | null>(null);
  /**
   * Server-issued conversation token, echoed on every turn.
   *
   * Reset alongside `callRefRef` whenever a new call starts, so a finished
   * conversation's streak cannot be inherited by the next one through a stale
   * token.
   */
  const convIdRef = useRef<string | null>(null);
  /** True from the click until getUserMedia resolves. Guards double-clicks. */
  const startingRec = useRef(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const autoStop = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakSeq = useRef(0);
  /**
   * Set when the reply was NOT spoken by the vendor's neural voice. The copy beside
   * this player claims a neural reply, and the fallback is silent about which voice
   * the visitor actually hears — so the claim is unfalsifiable to the person listening
   * unless it is annotated here.
   */
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* scroll the conversation — snap, not smooth: a long reply must be fully
     visible the moment it lands, and an in-flight smooth scroll is what made
     the last bubble look clipped against the guardrail footer. */
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "auto" });
  }, [turns, phase]);

  /* cleanup on unmount + language switch */
  useEffect(() => {
    return () => {
      if (autoStop.current) clearTimeout(autoStop.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recRef.current?.state === "recording") recRef.current.stop();
      speakSeq.current += 1;
      // AND actually stop the audio.
      //
      // The cleanup bumped `speakSeq`, which `streamSpeech` has no way to observe —
      // it exposes no cancellation API — so the bump did nothing at all, and
      // `stopVoice()` (which pauses the current clip AND calls
      // speechSynthesis.cancel()) was never called. On unmount the agent kept
      // talking and the browser kept speaking: audio from a component that no
      // longer exists. This component backs BOTH the landing-page widget and the
      // demo panel, so two instances can be live at once and they talk over each
      // other.
      stopVoice();
    };
  }, []);
  useEffect(() => {
    // Same on a language switch, and for the same reason: the pending reply is in
    // the OLD language, so leaving it playing speaks the language the user just
    // turned off.
    speakSeq.current += 1;
    stopVoice();
  }, [callLang]);

  const speakReply = (text: string, allowBargeIn: boolean) => {
    setPhase("speaking");
    speakSeq.current += 1;
    const seq = speakSeq.current;
    setVoiceNote(null);
    // Streaming first (ElevenLabs chunked pipe + barge-in). Barge-in is only
    // armed for a turn the caller actually spoke: a typed turn has already
    // finished, so the mic can only prompt for permission or let speaker
    // bleed cut the reply short.
    streamSpeech(text, callLang, "agent", 1, {
      bargeIn: allowBargeIn,
      strict: true,
    })
      .catch(() => ({ streamed: false, bargeIn: false, neural: false, reason: "threw" }))
      .then((outcome) => {
        if (seq !== speakSeq.current) return; // a newer line owns the turn now
        if (!outcome.neural) {
          // Strict mode never falls back to the device voice; say what happened.
          setVoiceNote(t(STRICT_VOICE_UNAVAILABLE.en, STRICT_VOICE_UNAVAILABLE.ar, lang));
        }
        setPhase("idle");
      });
  };

  const sendTurn = async (text: string, asrMs?: number) => {
    const clean = text.trim();
    if (!clean || clean.length > 600) return;
    const modality: Turn["modality"] = asrMs === undefined ? "typed" : "spoken";
    setError(null);
    turnId.current += 1;
    const youId = turnId.current;
    setTurns((p) => [...p, { id: youId, role: "you", text: clean, modality, asrMs }]);
    setPhase("agent");
    const started = performance.now();
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: clean,
          lang: callLang,
          ...(callRefRef.current ? { callRef: callRefRef.current } : {}),
          // Server-issued conversation token. Without this the server counts every
          // turn as conversation #1, so the "four unclear turns then a human"
          // ceiling never fires — which is the guardrail a judge is most likely to
          // meet and least likely to notice missing.
          ...(convIdRef.current ? { convId: convIdRef.current } : {}),
        }),
      });
      const data = await res.json().catch(() => ({ error: "Unreadable response" }));
      // The route returns the reference it audited under - adopt it and every
      // later turn on this call lands on the same streak.
      if (typeof data?.callRef === "string" && !callRefRef.current) {
        callRefRef.current = data.callRef;
      }
      // Same for the conversation token, and UNCONDITIONALLY: the server mints a
      // new one whenever the presented token is absent or unrecognised, so this
      // must always take the server's value rather than keeping a stale one.
      if (typeof data?.convId === "string") {
        convIdRef.current = data.convId;
      }
      if (!res.ok || !data.reply) throw new Error(data.error || "Agent unavailable");
      turnId.current += 1;
      setTurns((p) => [
        ...p,
        {
          id: turnId.current,
          role: "agent",
          text: data.reply,
          modality,
          intent: data.intent,
          action: data.action,
          escalate: data.escalate as boolean | undefined,
          escalationReason: data.escalationReason as string | undefined,
          latencyMs: data.latencyMs ?? Math.round(performance.now() - started),
          asrMs,
        },
      ]);
      speakReply(data.reply, modality === "spoken");
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
    // SYNCHRONOUS in-flight guard, set BEFORE the await.
    //
    // The old check was `if (phase !== "idle") return`, read from React state —
    // and state does not update until this function yields at `getUserMedia`. So
    // two clicks during the browser's permission prompt BOTH passed the check,
    // both awaited, and the second overwrote streamRef/recRef. The first stream's
    // mic tracks were then orphaned: never stopped, so the browser's recording
    // indicator stayed on, with nothing left able to reach them. A MediaRecorder
    // was left running too.
    //
    // A ref is the only thing that is current within a single tick.
    if (startingRec.current) return;
    if (phase !== "idle") return;
    startingRec.current = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        setError(
          lang === "ar"
            ? "الميكروفون غير مدعوم — اكتب إجابتك."
            : "Microphone unsupported here — type your answer below.",
        );
        return;
      }
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
      // Stop whatever DID arrive. A stream granted after a failure here would
      // otherwise keep the mic indicator on with no recorder referencing it.
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      streamRef.current = null;
      recRef.current = null;
    } finally {
      startingRec.current = false;
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
      setError(
        lang === "ar" ? "لم نسمع شيئاً — حاول مجدداً." : "Didn't catch anything — try again.",
      );
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
      {/* header — black band shared via PanelHeader, matching the rail cards */}
      <PanelHeader
        className="sm:px-6"
        icon={
          <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-white/10 ring-1 ring-green-bright/40">
            <AudioLines className="h-5 w-5 text-green-bright" />
            {phase === "recording" && (
              <span className="sv-pulse-ring absolute inset-0 rounded-full text-green-bright/70" />
            )}
          </span>
        }
        title={
          <>
            <p className="text-[14px] font-semibold text-white">
              {lang === "ar" ? "تحدّث مع الوكيل" : "Talk to the agent"}{" "}
              <span dir="rtl" className="font-arabic text-[12px] font-normal text-white/60">
                · تحدث مع الوكيل
              </span>
            </p>
            <p className="num mt-1 text-[10.5px] text-white/60">
              REAL STT → GUARDRAILED ROUTING → ELEVENLABS AGENT VOICE · {VOICE_BY_LANG[callLang]}
            </p>
          </>
        }
        right={
          <span className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[10.5px] font-semibold text-white/80">
            <Fingerprint className="h-3 w-3 text-green-bright" />
            {lang === "ar" ? "لا رموز سرية · أبداً" : "No PINs · No OTPs · Ever"}
          </span>
        }
      />

      <div className="grid lg:grid-cols-[0.92fr_1.08fr]">
        {/* left — controls */}
        <div className="flex flex-col items-center gap-4 border-b border-line px-6 py-6 lg:border-b-0 lg:border-r">
          <p className="max-w-sm text-center text-[12.5px] leading-relaxed text-ink-2">
            {lang === "ar"
              ? "أجب كما يجابة العميل. تحدّث عبر الميكروفون — أو اكتب — ويستجيب خط الأنابيب الحقيقي: التعرّف على الكلام، التوجيه المحكوم، ورد صوتي عصبي بـ"
              : "Answer as the customer would. Speak into your microphone — or type — and the real pipeline responds: speech recognition, deterministic guardrail routing, and an ElevenLabs agent voice reply in "}
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
            aria-label={
              phase === "recording"
                ? t("Stop recording", "إيقاف التسجيل", lang)
                : t("Start recording", "بدء التسجيل", lang)
            }
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

          {voiceNote && (
            // Audible either way — this says in whose voice, so the copy above can be
            // checked by the person hearing it rather than only by the audit row.
            <p
              role="status"
              className="max-w-sm text-center text-[11.5px] leading-snug text-amber-soft"
            >
              {voiceNote}
            </p>
          )}

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
                          ? "ex. « cette transaction n'est pas la mienne »"
                          : 'e.g. "That transaction is not mine"'
              }
              maxLength={600}
              className="h-10 flex-1 rounded-full border-line bg-paper px-4"
              aria-label={t("Type your answer", "اكتب إجابتك", lang)}
            />
            <button
              type="submit"
              disabled={!typed.trim() || busy}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-white transition hover:bg-green-deep disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={t("Send", "إرسال", lang)}
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
            aria-label={t("Live conversation transcript", "سجل المحادثة الحيّة", lang)}
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
                        <span className="num">
                          {t.modality === "spoken" && typeof t.asrMs === "number"
                            ? ` · ASR ${t.asrMs}ms`
                            : ` · ${lang === "ar" ? "مكتوب" : "typed"}`}
                        </span>
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
                  <div className="max-w-[88%] rounded-2xl rounded-tl-md bg-green-tint px-4 py-3 text-foreground">
                    <div className="mb-1 flex items-center gap-2">
                      <PhoneOutgoing className="h-3 w-3 text-primary" />
                      {t.escalate && (
                        <span
                          className="micro !text-[8.5px] rounded-full bg-red-soft/20 px-1.5 py-0.5 !text-red-soft"
                          title={t.escalationReason}
                        >
                          {lang === "ar" ? "تسليم بشري" : "HUMAN TALKOVER"}
                        </span>
                      )}
                      <span className="micro !text-[9px] !text-primary">
                        {lang === "ar" ? "الوكيل · " : "Agent · "}
                        {VOICE_BY_LANG[callLang]}
                      </span>
                      {typeof t.latencyMs === "number" && (
                        <span
                          className="num text-[9.5px] text-ink-3"
                          title={
                            t.modality === "spoken"
                              ? "From the end of your speech to the reply text (ASR + routing)."
                              : "Routing only. A typed turn has no caller speech end and no ASR, so this is not a phone-turn latency."
                          }
                        >
                          {t.modality === "spoken"
                            ? `turn ${(t.asrMs ?? 0) + t.latencyMs}ms`
                            : `typed · routing ${t.latencyMs}ms`}
                        </span>
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
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
                      {t.intent && (
                        <span
                          className={cn(
                            "num rounded-full px-2 py-0.5 text-[9.5px] font-bold",
                            INTENT_CHIP[t.intent]?.tone ?? "bg-secondary text-ink-2",
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
                        <span className="num rounded-full bg-secondary px-2 py-0.5 text-[9.5px] font-bold text-ink-2">
                          action: none · {lang === "ar" ? "أُغلقت المراجعة" : "review closed"}
                        </span>
                      )}
                      {t.action === "clarify" && (
                        <span className="num rounded-full bg-secondary px-2 py-0.5 text-[9.5px] font-bold text-ink-2">
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
                ? "الضمانات على هذا الخط: لا يطلب الوكيل أبداً رمزاً سرياً أو كلمة مرور أو رمز تحقق؛ يمكنه تنفيذ إجراء كتابي واحد معتمد مسبقاً (تجميد مؤقت للبطاقة)؛ ويُكتب كل دور في سجل التدقيق. زمن الدور المنطوق يبدأ من نهاية كلامك (تحويل + توجيه)؛ أما الدور المكتوب فيُعرض زمن التوجيه فقط."
                : "Guardrails on this line: the agent never asks for PINs, passwords, or one-time passcodes; it can execute exactly one pre-approved write action (temporary card freeze); every turn is written to the audit log. A spoken turn is timed from the end of your speech (ASR + routing); a typed turn shows routing only."}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
