"use client";

/**
 * WP-7 — the live SLO panel.
 *
 * Its whole reason to exist is one contrast: the 38-minute industry baseline,
 * drawn on the same axis as our measured spans. Without that line this is a
 * table of numbers; with it, a bank operator sees where the fraudster's window
 * sits relative to theirs.
 *
 * The axis is LOGARITHMIC (`logAxisPosition`), because a linear axis would put
 * every real measurement inside the first 3% of the width next to a 2 280 000 ms
 * reference line — the baseline would be visible and the product invisible.
 *
 * Honest degradation, in order of severity:
 *   - no data        → the baseline line and the budgets are still drawn, every
 *                      track says "not measured", and a banner names what is
 *                      missing. A zero-length bar is NEVER drawn for an absent
 *                      measurement, because zero renders as "perfect".
 *   - stale/error    → the last good snapshot stays on screen, marked stale with
 *                      the failure, rather than silently blanking.
 *   - few samples    → each row publishes `n` and flags rows under the p95
 *                      sample floor, so a p95 over four samples cannot be read
 *                      as a p95 over four hundred.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  RefreshCw,
  Timer,
  XCircle,
} from "lucide-react";
import { Chip, LiveDot, StatusPill } from "@/components/fx/core";
import { cn } from "@/lib/utils";
import {
  AXIS_MAX_MS,
  AXIS_TICKS_MS,
  INDUSTRY_BASELINE,
  fasterThanBaselineBy,
  logAxisPosition,
  type SloWindowSnapshot,
  type SpanWindowSummary,
} from "@/lib/telemetry/slo";

type SloPanelProps = {
  /** Only spans started in the last N minutes. Omit for all recorded time. */
  windowMinutes?: number;
  /** How many of the most recent interventions to summarise. */
  interventions?: number;
  /** Poll interval. `0` disables polling (the operator is looking at a still frame). */
  pollMs?: number;
  className?: string;
};

export function SloPanel({
  windowMinutes,
  interventions = 50,
  pollMs = 15_000,
  className,
}: SloPanelProps) {
  const [snapshot, setSnapshot] = useState<SloWindowSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setRefreshing(true);
      try {
        const params = new URLSearchParams({ interventions: String(interventions) });
        if (windowMinutes !== undefined) params.set("windowMinutes", String(windowMinutes));
        const res = await fetch(`/api/status/spans?${params.toString()}`, {
          signal,
          cache: "no-store",
        });
        const body = (await res.json().catch(() => null)) as
          (SloWindowSnapshot & { error?: string }) | null;
        if (!res.ok || !body) {
          setError(`latency feed unavailable (HTTP ${res.status})`);
        } else {
          setSnapshot(body);
          // A field-level `error` (unreadable log, malformed lines) is surfaced,
          // but the measured rows still render — the numbers are real, the log
          // has a blemish, and conflating the two would hide both.
          setError(body.error ?? null);
        }
      } catch (err) {
        if ((err as Error)?.name !== "AbortError")
          setError("latency feed unreachable — showing the last good snapshot");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [interventions, windowMinutes],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    if (pollMs <= 0) return () => controller.abort();
    const iv = setInterval(() => void load(controller.signal), pollMs);
    return () => {
      controller.abort();
      clearInterval(iv);
    };
  }, [load, pollMs]);

  const spans = snapshot?.spans ?? [];
  const measured = spans.filter((s) => s.samples > 0);
  const hasData = snapshot ? snapshot.ok && measured.length > 0 : false;
  const baselinePct = logAxisPosition(INDUSTRY_BASELINE.ms);
  const worstP95 = snapshot?.worst?.p95Ms ?? null;
  const speedup = fasterThanBaselineBy(worstP95, INDUSTRY_BASELINE.ms);

  return (
    <section
      className={cn("rounded-3xl border border-line bg-white p-6", className)}
      aria-label="Latency SLO panel"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="micro text-[9px] text-primary">LATENCY SLO</span>
            {hasData && !error && <LiveDot />}
          </div>
          <h2 className="font-display mt-2 text-[15px] font-semibold">
            Interventions, measured against the 38-minute baseline
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip className="!text-[10.5px]">
            <Activity className="h-3 w-3 text-primary" />
            {snapshot ? `${snapshot.interventionsComplete} measured interventions` : "…"}
          </Chip>
          {snapshot && (
            <StatusPill tone={snapshot.meets30InterventionThreshold ? "green" : "amber"}>
              <Timer className="h-3 w-3" /> {snapshot.requiredInterventions} required
            </StatusPill>
          )}
          <button
            type="button"
            onClick={() => {
              const controller = new AbortController();
              void load(controller.signal);
            }}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[10.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary disabled:opacity-40"
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
            Refresh
          </button>
        </div>
      </header>

      {/* the contrast, stated in words as well as drawn */}
      <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-2xl border border-line bg-paper/60 px-4 py-3">
        <span className="micro text-[9px] text-ink-3">INDUSTRY BASELINE</span>
        <span className="num text-[13px] font-semibold text-ink-2">{INDUSTRY_BASELINE.label}</span>
        <span className="text-[11px] text-ink-3">
          fraud flag → customer contact ({INDUSTRY_BASELINE.kind}, cited below)
        </span>
        {hasData && worstP95 !== null ? (
          <span className="num text-[13px] font-semibold text-primary">
            ours: {fmtMs(worstP95)} on the worst span
            {speedup !== null && ` · ${Math.round(speedup)}× faster`}
          </span>
        ) : (
          <span className="text-[11.5px] font-medium text-ink-3">ours: not measured yet</span>
        )}
      </div>

      {error && (
        <p
          role="status"
          className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[12px] text-amber-900"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      {loading && !snapshot ? (
        <div className="mt-5 space-y-2.5" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="sv-shimmer h-9 rounded-xl bg-paper" />
          ))}
        </div>
      ) : (
        <SloChart spans={spans} baselinePct={baselinePct} hasData={hasData} snapshot={snapshot} />
      )}

      <footer className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10.5px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-full bg-primary" /> p95
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-px bg-primary/60" /> p50
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-px bg-amber-soft" /> budget (p95 target)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-4 border-l border-dashed border-ink-3" /> {INDUSTRY_BASELINE.label}{" "}
          baseline
        </span>
      </footer>

      <p className="mt-3 text-[10.5px] leading-relaxed text-ink-3">
        Log axis, {fmtMs(AXIS_MAX_MS)} full scale. Spans with fewer than 30 samples publish their
        p95 but mark it untrusted.
        {snapshot ? ` Source: ${snapshot.source}.` : ""}
      </p>
    </section>
  );
}

/* ————— chart ————— */

/**
 * The chart body.
 *
 * Exported for the honesty tests: the panel's own first paint is a skeleton, so
 * a test cannot reach the no-data rows through the component without a DOM and
 * an async effect. Rendering this directly proves what the tests need to prove —
 * that an unmeasured span says so and draws no bar.
 */
export function SloChart({
  spans,
  baselinePct,
  hasData,
  snapshot,
}: {
  spans: SpanWindowSummary[];
  baselinePct: number | null;
  hasData: boolean;
  snapshot: SloWindowSnapshot | null;
}) {
  return (
    <div className="mt-5">
      {!hasData && (
        <div className="mb-4 rounded-2xl border border-dashed border-line bg-paper/60 px-4 py-3">
          <p className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-2">
            <CircleSlash className="h-4 w-4 text-ink-3" />
            No spans recorded in this window
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
            Every row below is a <span className="font-semibold">budget</span>, not a measurement.
            The bars and the verdict are absent on purpose: a zero-length bar would read as
            &quot;instant&quot;, and this panel does not draw a number it has not observed.
            {snapshot?.source ? ` (${snapshot.source})` : ""}
          </p>
        </div>
      )}

      {/* axis header */}
      <div className="flex items-end gap-3">
        <div className="w-[9.5rem] shrink-0" />
        <div className="relative h-5 flex-1 border-b border-line">
          {AXIS_TICKS_MS.map((t) => (
            <span
              key={t.ms}
              className="num absolute bottom-0.5 -translate-x-1/2 text-[9px] text-ink-3"
              style={{ left: `${logAxisPosition(t.ms) ?? 0}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div className="w-[8.5rem] shrink-0" />
      </div>

      <div className="mt-2 space-y-2.5">
        {spans.map((s) => (
          <Row key={s.span} summary={s} baselinePct={baselinePct} />
        ))}
      </div>
    </div>
  );
}

function Row({ summary, baselinePct }: { summary: SpanWindowSummary; baselinePct: number | null }) {
  const p95Pct = logAxisPosition(summary.p95Ms);
  const p50Pct = logAxisPosition(summary.p50Ms);
  const targetPct = logAxisPosition(summary.targetP95Ms);
  const met = summary.verdict.status === "met";
  const missed = summary.verdict.status === "missed";
  const measured = summary.samples > 0;

  return (
    <div className="flex items-center gap-3">
      <div className="w-[9.5rem] shrink-0">
        <p className="text-[11.5px] font-semibold leading-tight text-ink-2">{summary.label}</p>
        <p className="num mt-0.5 text-[10px] text-ink-3">≤ {fmtMs(summary.targetP95Ms)} p95</p>
      </div>

      <div
        className="relative h-7 flex-1 rounded-lg bg-paper/60"
        role="img"
        aria-label={
          measured
            ? `${summary.label}: p50 ${fmtMs(summary.p50Ms)}, p95 ${fmtMs(summary.p95Ms)}, budget ${fmtMs(summary.targetP95Ms)} — ${summary.verdict.status}`
            : `${summary.label}: not measured, budget ${fmtMs(summary.targetP95Ms)}`
        }
      >
        {/* The 38-minute reference line, repeated per row so the segments join
            into one continuous rule down the chart. */}
        {baselinePct !== null && (
          <span
            aria-hidden
            className="absolute inset-y-[-6px] border-l border-dashed border-ink-3/70"
            style={{ left: `${baselinePct}%` }}
          />
        )}
        {targetPct !== null && (
          <span
            aria-hidden
            className="absolute inset-y-1 w-px bg-amber-soft"
            style={{ left: `${targetPct}%` }}
          />
        )}
        {p95Pct !== null && (
          <span
            aria-hidden
            className={cn(
              "absolute inset-y-[5px] left-0 rounded-full",
              missed ? "bg-red-soft/70" : "bg-primary",
            )}
            style={{ width: `${p95Pct}%` }}
          />
        )}
        {p50Pct !== null && (
          <span
            aria-hidden
            className="absolute inset-y-0 w-px bg-primary/70"
            style={{ left: `${p50Pct}%` }}
          />
        )}
        {!measured && (
          <span className="absolute inset-0 flex items-center pl-2.5 text-[10.5px] font-medium text-ink-3">
            not measured
          </span>
        )}
      </div>

      <div className="w-[8.5rem] shrink-0 text-right">
        <p className="num text-[11.5px] font-semibold text-ink-2">
          {measured ? `${fmtMs(summary.p50Ms)} / ${fmtMs(summary.p95Ms)}` : "— / —"}
        </p>
        <div className="mt-0.5 flex items-center justify-end gap-1">
          {met && (
            <StatusPill tone="green">
              <CheckCircle2 className="h-3 w-3" /> met
            </StatusPill>
          )}
          {missed && (
            <StatusPill tone="red">
              <XCircle className="h-3 w-3" /> missed
            </StatusPill>
          )}
          {!measured && <StatusPill tone="gray">no data</StatusPill>}
          {measured && !summary.meetsSampleFloor && (
            <StatusPill tone="amber">n={summary.samples}</StatusPill>
          )}
        </div>
      </div>
    </div>
  );
}

/* ————— formatting ————— */

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(ms >= 600_000 ? 0 : 1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}
