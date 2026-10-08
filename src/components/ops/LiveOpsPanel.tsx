"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PhoneCall, User, Bot, ShieldCheck, Radio, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LiveDot } from "@/components/fx/core";

/**
 * Live Operations Panel — real-time transcript viewer for active calls.
 *
 * Shows the conversation between the AI agent and the customer as it happens,
 * with a typewriter effect for incoming lines. Uses the same realtime
 * infrastructure as the Console (SSE fallback + websocket push).
 *
 * The panel is read-only: it displays what the audit chain records, never
 * writes to it. A transcript line is rendered only after the audit chain has
 * committed it, so the panel can never show a line that isn't audited.
 */

export type TranscriptLine = {
  id: string;
  speaker: "agent" | "customer" | "system";
  text: string;
  tag?: string;
  ts: string;
};

export type LiveCall = {
  caseRef: string;
  riskScore: number | null;
  lang: string;
  state: string;
  startedAt: string;
  durationSecs: number;
  transcript: TranscriptLine[];
};

type LiveOpsPanelProps = {
  /** The case ref being watched, or null when no call is active. */
  activeCallRef: string | null;
  /** Real-time transcript lines for the active call. */
  transcript: TranscriptLine[];
  /** Call metadata for the active call. */
  call: LiveCall | null;
  /** Connection status for the realtime feed. */
  rtStatus: "connecting" | "live" | "unavailable";
};

/* ————— typewriter hook ————— */

function useTypewriter(text: string, speed = 18) {
  // One state object rather than `displayed` + `done`: `done` is DERIVED from
  // `chars >= text.length`, so keeping a second copy of it meant a second thing
  // that could disagree with the first.
  const [shown, setShown] = useState({ text: "", chars: 0 });

  // Reset during RENDER when the text changes, which is React's documented
  // "adjust state when a prop changes" pattern. Doing this in an effect is what
  // react-hooks/set-state-in-effect flags, and it is not a style preference:
  // an effect reset runs AFTER the commit, so the panel repaints one frame
  // showing the previous line's text before the reset lands.
  if (shown.text !== text) setShown({ text, chars: 0 });

  useEffect(() => {
    if (!text) return;
    let i = 0;
    const iv = setInterval(() => {
      i += 2;
      // The `prev.text === text` guard makes a stale interval from a previous
      // line harmless: after a correction rewrites the text, the old timer
      // cannot keep advancing the new one.
      setShown((prev) =>
        prev.text === text ? { text, chars: i >= text.length ? text.length : i } : prev,
      );
      if (i >= text.length) clearInterval(iv);
    }, speed);
    return () => clearInterval(iv);
  }, [text, speed]);

  const done = !text || shown.chars >= text.length;
  return { displayed: done ? text : text.slice(0, shown.chars), done };
}

/* ————— single transcript line ————— */

function TranscriptLineView({ line }: { line: TranscriptLine }) {
  const { displayed, done } = useTypewriter(line.text);
  const isAgent = line.speaker === "agent";
  const isSystem = line.speaker === "system";

  if (isSystem) {
    return (
      <div className="flex items-start gap-2 py-1">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-ink-100">
          <Radio className="h-3 w-3 text-ink-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium italic text-ink-4">{displayed}</p>
          {line.tag && (
            <span className="mt-0.5 inline-block rounded bg-ink-100 px-1.5 py-0.5 text-[9px] font-semibold text-ink-4">
              {line.tag}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex items-start gap-2 py-1.5", isAgent ? "justify-start" : "justify-end")}>
      {isAgent && (
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-green-tint">
          <Bot className="h-3 w-3 text-primary" />
        </span>
      )}
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2",
          isAgent
            ? "rounded-tl-sm bg-white border border-line"
            : "rounded-tr-sm bg-[#0c110e] text-white",
        )}
      >
        <p className={cn("text-[12px] leading-snug", isAgent ? "text-ink-2" : "text-white/90")}>
          {displayed}
          {!done && (
            <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-current align-middle" />
          )}
        </p>
        {line.tag && (
          <span
            className={cn(
              "mt-1 inline-block rounded px-1.5 py-0.5 text-[9px] font-semibold",
              isAgent ? "bg-green-tint text-primary" : "bg-white/10 text-white/60",
            )}
          >
            {line.tag}
          </span>
        )}
      </div>
      {!isAgent && (
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-ink-800">
          <User className="h-3 w-3 text-white/70" />
        </span>
      )}
    </div>
  );
}

/* ————— duration formatter ————— */

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* ————— main panel ————— */

export function LiveOpsPanel({ activeCallRef, transcript, call, rtStatus }: LiveOpsPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  const stateTone =
    call?.state === "CONFIRMED_FRAUD"
      ? "red"
      : call?.state === "CONFIRMED_LEGITIMATE"
        ? "green"
        : call?.state === "ANSWERED"
          ? "green"
          : call?.state === "DIALING" || call?.state === "RINGING"
            ? "amber"
            : "gray";

  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-white">
      {/* header */}
      <div className="flex items-center justify-between border-b border-line bg-[#0c110e] px-5 py-4">
        <div className="flex items-center gap-2.5">
          <LiveDot className={rtStatus === "live" ? "text-green-bright" : "text-amber-400"} />
          <span className="micro !text-[9.5px] text-white/70">LIVE OPERATIONS</span>
        </div>
        <div className="flex items-center gap-2">
          {call && (
            <span className="num rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white">
              {formatDuration(call.durationSecs)}
            </span>
          )}
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide",
              rtStatus === "live"
                ? "bg-green-bright/15 text-green-bright"
                : rtStatus === "connecting"
                  ? "bg-amber-400/15 text-amber-400"
                  : "bg-white/10 text-white/40",
            )}
          >
            {rtStatus === "live" ? "live" : rtStatus === "connecting" ? "connecting" : "sse"}
          </span>
        </div>
      </div>

      {/* call metadata */}
      {call && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-paper/50 px-5 py-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-4">
              Case
            </span>
            <span className="num text-[12px] font-semibold text-ink-2">{call.caseRef}</span>
          </div>
          {call.riskScore !== null && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-4">
                Risk
              </span>
              {/* The band word is the signal, not the color: a red 0.94 and an
                  amber 0.82 are indistinguishable to a color-blind analyst, and
                  to a screen reader both are just numbers. So the severity is
                  stated in words — visible and in the accessible name. */}
              <span
                role="img"
                aria-label={`Risk ${call.riskScore >= 0.9 ? "high" : call.riskScore >= 0.75 ? "elevated" : "standard"}, score ${call.riskScore.toFixed(2)}`}
                className={cn(
                  "num text-[12px] font-semibold",
                  call.riskScore >= 0.9
                    ? "text-red-500"
                    : call.riskScore >= 0.75
                      ? "text-amber-500"
                      : "text-green-600",
                )}
              >
                {call.riskScore >= 0.9 ? "High" : call.riskScore >= 0.75 ? "Elevated" : "Standard"}{" "}
                {call.riskScore.toFixed(2)}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-4">
              Lang
            </span>
            <span className="text-[12px] font-semibold text-ink-2">{call.lang}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-4">
              State
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-bold",
                stateTone === "red" && "bg-red-100 text-red-700",
                stateTone === "green" && "bg-green-100 text-green-700",
                stateTone === "amber" && "bg-amber-100 text-amber-700",
                stateTone === "gray" && "bg-ink-100 text-ink-500",
              )}
            >
              {call.state}
            </span>
          </div>
        </div>
      )}

      {/* transcript area.
          role="log" carries an implicit aria-live="polite": screen readers
          announce new transcript lines as they arrive without stealing focus,
          which is exactly the analyst use case (JAWS/NVDA following a live
          call). aria-atomic="false" so only the new line is read, not the
          whole 360px scrollback, and aria-relevant="additions" so edits to
          existing lines (redaction) do not re-announce. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label={activeCallRef ? `Live transcript for call ${activeCallRef}` : "Live transcript, no active call"}
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions"
        tabIndex={0}
        className="h-[360px] overflow-y-auto px-4 py-3 sv-scroll"
      >
        {!activeCallRef || transcript.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <PhoneCall className="h-8 w-8 text-ink-3" strokeWidth={1.4} />
            <p className="max-w-[260px] text-[12.5px] leading-snug text-ink-3">
              {activeCallRef
                ? "Waiting for the first transcript line…"
                : "No active call. Fire a signal to start a live intervention."}
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            <AnimatePresence initial={false}>
              {transcript.map((line) => (
                <motion.div
                  key={line.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <TranscriptLineView line={line} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* footer */}
      <div className="flex items-center justify-between border-t border-line bg-paper/50 px-5 py-2.5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
          <span className="text-[10.5px] text-ink-3">Recorded · audited · PII-redacted</span>
        </div>
        <div className="flex items-center gap-2">
          <Volume2 className="h-3.5 w-3.5 text-ink-4" />
          <span className="text-[10.5px] text-ink-4">
            {transcript.length} line{transcript.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
