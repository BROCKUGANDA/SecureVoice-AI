"use client";

import { useEffect, useRef, useState } from "react";
import { Lock, Pause, Play } from "lucide-react";
import { useApp, t } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * Play a case recording, one at a time.
 *
 * "One at a time" is a requirement, not a preference. A table of twelve rows,
 * each with its own `<audio>`, lets an operator start four of them and get
 * overlapping speech from four different customers — which reads as a broken
 * console rather than as four recordings. The component that is playing pauses
 * every other one by telling the table which id owns playback.
 *
 * `src` null means there is NO recording, which is a real state: audio is
 * retained for 30 days and an organization can have recording disabled outright
 * (src/lib/privacy/retention.ts). The chip says so rather than showing a
 * disabled play button that implies the file is merely missing.
 */
export function RecordingPlayer({
  src,
  caseId,
  playingId,
  onPlay,
  className,
}: {
  src: string | null;
  caseId: string;
  playingId: string | null;
  onPlay: (id: string | null) => void;
  className?: string;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const { lang } = useApp();

  const isPlaying = playingId === caseId;

  // Stop the moment another row takes playback. Doing this in an effect (rather
  // than only in the click handler) means a row that starts playing from some
  // other path still yields.
  //
  // The effect ONLY touches the external system (the element); the state follows
  // from the element's own `pause` event via `onPause` below. Setting state
  // synchronously in the effect body is what the React Compiler's lint rule
  // rejects, and the event handler is the same update without the cascading
  // render.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!isPlaying && !el.paused) el.pause();
  }, [isPlaying]);

  if (!src) {
    return (
      <span
        className={cn("inline-flex items-center gap-1 text-ink-3", className)}
        title={t(
          "No recording retained for this case. Audio is kept for 30 days and can be switched off entirely per organization.",
          "لا يوجد تسجيل محفوظ لهذه الحالة. يُحفظ الصوت لمدة 30 يوماً ويمكن تعطيل التسجيل تماماً على مستوى كل مؤسسة.",
          lang,
        )}
      >
        <Lock className="h-3 w-3" aria-hidden="true" />
        <span className="text-[10.5px]">{t("sealed", "مُغلّف", lang)}</span>
      </span>
    );
  }

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      onPlay(caseId);
      setPlaying(true);
      void el.play().catch(() => {
        // Autoplay policy or a decode failure: fall back to "not playing"
        // rather than leaving the button in a lying state.
        setPlaying(false);
        onPlay(null);
      });
    } else {
      el.pause();
      setPlaying(false);
      onPlay(null);
    }
  };

  return (
    <span className={cn("inline-flex items-center", className)}>
      <audio
        ref={ref}
        src={src}
        preload="none"
        onEnded={() => {
          setPlaying(false);
          onPlay(null);
        }}
        onPause={() => setPlaying(false)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={`${playing ? t("Pause", "إيقاف مؤقت", lang) : t("Play", "تشغيل", lang)} ${t("recording for case", "تسجيل الحالة", lang)} ${caseId}`}
        className="flex h-7 w-7 items-center justify-center rounded-full border border-line bg-white text-ink-2 transition hover:border-primary/40 hover:text-primary"
      >
        {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      </button>
    </span>
  );
}
