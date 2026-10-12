"use client";

import { useEffect, useRef, useState } from "react";
import { Lock, Pause, Play, Loader2 } from "lucide-react";
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
 * ## The URL is fetched on press, never handed to the list
 *
 * A presigned recording URL is a BEARER credential: whoever holds it can pull a
 * bank customer's voice from the object store with no further check
 * (src/app/api/recordings/[id]/route.ts). So it does not appear in a table
 * payload, and it is not cached — it is requested from the download route, under
 * the operator's own session, at the moment press happens. That route also
 * re-checks the tenant on every call, so a URL cannot be replayed across cases.
 *
 * ## The three states, each of which is real
 *
 *   · `retrievable: false` — no conversation id on the case, so nothing was ever
 *     archived. Says so, rather than showing a dead button.
 *   · a refused or empty download — recording is disabled for the organization,
 *     retention has swept it (src/lib/privacy/retention.ts), or the archive was
 *     never configured. Reported as unavailable, not as "sealed" by default.
 *   · a URL — plays.
 */
export function RecordingPlayer({
  src,
  caseId,
  caseRef,
  retrievable = true,
  playingId,
  onPlay,
  className,
}: {
  /** A URL the caller already holds. When absent, the press fetches one. */
  src?: string | null;
  caseId: string;
  /** Shown to the operator; the download is keyed on `caseId`. */
  caseRef?: string;
  playingId: string | null;
  onPlay: (id: string | null) => void;
  className?: string;
  /** False means this case never produced a recording to retrieve. */
  retrievable?: boolean;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [resolved, setResolved] = useState<string | null>(src ?? null);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const { lang } = useApp();

  const isPlaying = playingId === caseId;

  // An externally supplied URL wins; otherwise whatever this press resolved.
  const effectiveSrc = src ?? resolved;

  useEffect(() => {
    if (src !== undefined && src !== null) setResolved(src);
  }, [src]);

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

  if (!retrievable) {
    return (
      <span
        className={cn("inline-flex items-center gap-1 text-ink-3", className)}
        title={t(
          "No recording was captured for this case — the call never produced a conversation to archive.",
          "لم يُلتقط أي تسجيل لهذه الحالة — لم تُنتج المكالمة محادثة لأرشفتها.",
          lang,
        )}
      >
        <Lock className="h-3 w-3" aria-hidden="true" />
        <span className="text-[10.5px]">{t("none", "لا يوجد", lang)}</span>
      </span>
    );
  }

  if (!effectiveSrc && unavailable) {
    return (
      <span
        className={cn("inline-flex items-center gap-1 text-ink-3", className)}
        title={t(
          "This recording could not be retrieved. Audio is kept for 30 days, an organization can switch recording off, and the archive itself may not be configured on this deployment.",
          "تعذّر استرجاع هذا التسجيل. يُحفظ الصوت لمدة 30 يوماً، ويمكن للمؤسسة تعطيل التسجيل، وقد لا يكون الأرشيف مُهيّأً على هذا النشر.",
          lang,
        )}
      >
        <Lock className="h-3 w-3" aria-hidden="true" />
        <span className="text-[10.5px]">{t("unavailable", "غير متاح", lang)}</span>
      </span>
    );
  }

  if (!effectiveSrc) {
    // Nothing resolved yet and nothing failed: the row is idle, and pressing it
    // is what asks the download route for a short-lived URL.
    return (
      <span className={cn("inline-flex items-center", className)}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void fetchAndPlay()}
          aria-label={`${t("Play", "تشغيل", lang)} ${t("recording for case", "تسجيل الحالة", lang)} ${caseRef ?? caseId}`}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-line bg-white text-ink-2 transition hover:border-primary/40 hover:text-primary disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
        </button>
      </span>
    );
  }

  async function fetchAndPlay() {
    setBusy(true);
    setUnavailable(null);
    try {
      const res = await fetch(`/api/recordings/${encodeURIComponent(caseId)}/download`, {
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        // Keep the CODE (`storage_not_configured`, `recording_not_found`) and
        // render the operator's sentence from it; the status goes to the report.
        const code = body.error ?? `download_refused_${res.status}`;
        reportClientError("recording-download", new Error(code), {
          http_status: String(res.status),
        });
        setUnavailable(code);
        return;
      }
      setResolved(body.url);
      onPlay(caseId);
      setPlaying(true);
    } catch (err) {
      setUnavailable(err instanceof Error ? err.message : "download_failed");
    } finally {
      setBusy(false);
    }
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
        src={effectiveSrc}
        preload="none"
        onEnded={() => {
          setPlaying(false);
          onPlay(null);
        }}
        onError={() => {
          // A presigned URL that expired or a store that refused: the operator
          // needs to see "unavailable", not a button that does nothing.
          setPlaying(false);
          onPlay(null);
          setResolved(null);
          setUnavailable("playback_failed");
        }}
        onPause={() => setPlaying(false)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={`${playing ? t("Pause", "إيقاف مؤقت", lang) : t("Play", "تشغيل", lang)} ${t("recording for case", "تسجيل الحالة", lang)} ${caseRef ?? caseId}`}
        className="flex h-7 w-7 items-center justify-center rounded-full border border-line bg-white text-ink-2 transition hover:border-primary/40 hover:text-primary"
      >
        {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      </button>
    </span>
  );
}
