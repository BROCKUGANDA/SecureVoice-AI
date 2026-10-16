"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useApp, t } from "@/lib/store";

/**
 * Voice-plane reachability banner.
 *
 * It asks one question and is only allowed to assert what that question can
 * answer: is the service that places calls reachable, through the same edge
 * path a real call takes. `src/worker/voice-stream.ts` answers
 * `/realtime/voice-health` and `Caddyfile` routes it, so a green result here is
 * a live round trip through the proxy that fronts the media stream ΓÇö not a
 * guess about a process this page cannot see.
 *
 * THE THREE STATES, AND WHY "UNKNOWN" IS NOT "DEGRADED"
 *
 * The previous version of this component polled
 * `https://voice.securevoice.ai/api/health`. That domain has never existed ΓÇö
 * `nslookup` answers `Non-existent domain`, and the hostname appears nowhere in
 * the Caddyfile, the compose files, or terraform. So the fetch threw on every
 * visit, on every route, thirty seconds after load, forever: a permanent red
 * bar on a fraud platform's marketing site, asserting an outage that was not
 * happening and an alert nobody had been sent. A probe that cannot fail is
 * decoration, and a probe that cannot PASS is worse, because its output is
 * indistinguishable from an incident.
 *
 * So a failed measurement is not a negative measurement, and the three are kept
 * apart deliberately:
 *
 *   ┬╖ 200                       ΓåÆ `healthy`. The plane answered.
 *   ┬╖ 502 / 503 / 504           ΓåÆ `degraded`. The edge is up and could not
 *                                 reach the plane behind it. That IS the outage
 *                                 this banner exists to report.
 *   ┬╖ anything else, including
 *     404 and network failure   ΓåÆ `unknown`. Renders nothing.
 *
 * 404 has to be `unknown` and not `degraded`, because it is the state of every
 * deployment before this change reaches the edge, and of every local `next dev`
 * run, where no Caddy fronts the worker at all. Treating it as degraded would
 * reintroduce the bug in a new costume. A visitor whose own laptop has no
 * network is the other case the rule covers: their fetch fails, and the voice
 * engine is fine.
 *
 * The banner also no longer claims "our team has been alerted". Nothing in this
 * repository pages anyone for voice-plane health ΓÇö `canary.yml` gates and rolls
 * back a deploy, and the `fraud_oncall` pager in `src/lib/notifications.ts` is
 * for fraud cases. Until an alert actually fires, the sentence would be a
 * promise the software cannot keep.
 */

const PROBE_URL = process.env.NEXT_PUBLIC_VOICE_HEALTH_URL ?? "/realtime/voice-health";
const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;

type Probe = "healthy" | "degraded" | "unknown";

/** Exported for tests: the whole safety of the banner lives in this mapping. */
export function classify(status: number | null): Probe {
  if (status === 200) return "healthy";
  if (status === 502 || status === 503 || status === 504) return "degraded";
  return "unknown";
}

export default function HealthCheck() {
  const lang = useApp((s) => s.lang);
  const [state, setState] = useState<Probe>("unknown");

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(PROBE_URL, {
          cache: "no-store",
          signal: ctrl.signal,
          credentials: "omit",
        });
        if (!cancelled) setState(classify(res.status));
      } catch {
        // Could not reach the edge at all, which says nothing about the plane.
        if (!cancelled) setState("unknown");
      } finally {
        clearTimeout(timer);
      }
    };

    // Immediately, then on the interval. The first probe used to wait out a full
    // 30 s tick, so a genuine outage announced itself by pushing the entire page
    // down mid-read. Measuring at once moves that shift to before anything is
    // read, and answers the question the banner asks before it asks it.
    void probe();
    const interval = setInterval(() => void probe(), PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (state !== "degraded") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-b border-line bg-red-tint px-4 py-2 text-center text-[12.5px] font-medium text-red-soft"
    >
      <span className="mx-auto flex max-w-3xl items-center justify-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t(
          "Outbound calls may be delayed ΓÇö the voice engine is not responding.",
          "┘é╪» ╪¬╪¬╪ú╪«╪▒ ╪º┘ä┘à┘â╪º┘ä┘à╪º╪¬ ╪º┘ä╪╡╪º╪»╪▒╪⌐ ΓÇö ┘ä╪ú┘å ┘à╪¡╪▒┘â ╪º┘ä╪╡┘ê╪¬ ┘ä╪º ┘è╪│╪¬╪¼┘è╪¿.",
          lang,
        )}
      </span>
    </div>
  );
}
