/**
 * WP-7 — percentile maths and SLO verdicts.
 *
 * Pure and import-safe in the browser: the panel renders the same numbers the
 * report writes, so there is exactly one percentile implementation in the repo.
 *
 * Three decisions, each of which a reader of the artifact will depend on:
 *
 *   1. **Nearest rank, not interpolation.** `percentile()` always returns a value
 *      that was actually observed. Interpolating between two samples invents a
 *      number the system never produced, and at p95 over 30 samples that
 *      invented number is the difference between "met" and "missed".
 *   2. **An empty window is `null`, never `0`.** A zero-millisecond p95 is the
 *      most flattering lie available: it reads as a pass. Every distribution
 *      field is `number | null`, and `null` means NOT MEASURED.
 *   3. **The sample count travels with the percentile.** A p95 over 4 samples is
 *      noise. `meetsSampleFloor` is published next to every distribution so a
 *      reader can refuse the number without recomputing anything.
 */

import {
  INDUSTRY_BASELINE,
  SPAN_DEFINITIONS,
  SPAN_NAMES,
  SPAN_TARGETS,
  TERMINAL_SPAN,
  spanLabel,
  targetP95Ms,
  type SpanName,
  type SpanRecord,
  type SpanRecorderDiagnostics,
} from "./spans";

/**
 * Samples below which a p95 is reported but not trusted. 30 is the brief's
 * intervention floor, so a span that clears the floor has at least as many
 * samples as the gate demands interventions.
 */
export const P95_SAMPLE_FLOOR = 30;

/** A sample this many times over budget is surfaced as an outlier, not hidden. */
export const OUTLIER_FACTOR = 4;

/* ————————————————————————————————— percentiles ————————————————————————————————— */

/**
 * Nearest-rank percentile.
 *
 *   rank = ceil(p/100 × n), 1-based, clamped to [1, n]
 *
 * @returns the observed sample at that rank, or `null` for an empty window.
 * @throws RangeError for p outside 0–100 — a caller bug, not bad data, so it is
 *         not swallowed the way an empty window is.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new RangeError(`percentile p must be within 0..100, received ${String(p)}`);
  }
  if (!Array.isArray(values) || values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(Math.max(Math.ceil((p / 100) * sorted.length), 1), sorted.length);
  const value = sorted[rank - 1];
  // Unreachable — the rank is clamped to a valid index — but `null` is the
  // honest answer for "no value" and the type system cannot prove the clamp.
  return value === undefined ? null : value;
}

export type Distribution = {
  /** Finite samples the distribution was computed from. */
  samples: number;
  /** Values dropped because they were NaN/Infinity. Never silently ignored. */
  rejected: number;
  minMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
};

/** All-null for an empty input. There is no "0 ms" in this type. */
export function summarise(values: readonly number[]): Distribution {
  const finite: number[] = [];
  let rejected = 0;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) finite.push(v);
    else rejected += 1;
  }
  if (finite.length === 0) {
    return {
      samples: 0,
      rejected,
      minMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
      meanMs: null,
    };
  }
  let total = 0;
  for (const v of finite) total += v;
  return {
    samples: finite.length,
    rejected,
    minMs: Math.min(...finite),
    p50Ms: percentile(finite, 50),
    p95Ms: percentile(finite, 95),
    p99Ms: percentile(finite, 99),
    maxMs: Math.max(...finite),
    meanMs: total / finite.length,
  };
}

/* ————————————————————————————————— verdicts ————————————————————————————————— */

export type SloVerdict =
  | {
      span: SpanName;
      label: string;
      targetP95Ms: number;
      status: "met";
      p95Ms: number;
      headroomMs: number;
    }
  | {
      span: SpanName;
      label: string;
      targetP95Ms: number;
      status: "missed";
      p95Ms: number;
      overrunMs: number;
    }
  | {
      span: SpanName;
      label: string;
      targetP95Ms: number;
      status: "no_data";
      p95Ms: null;
      reason: "no_spans_recorded" | "p95_not_a_number";
    };

/**
 * Judge one span against its budget.
 *
 * `null`/`undefined`/`NaN` p95 yields `no_data` — explicitly NOT a pass. The
 * target is attached to every branch so a consumer can render "— (budget 300 ms)"
 * without a second lookup table.
 */
export function meetsTarget(span: SpanName, p95Ms: number | null | undefined): SloVerdict {
  const label = spanLabel(span);
  const target = targetP95Ms(span);
  if (p95Ms === null || p95Ms === undefined) {
    return {
      span,
      label,
      targetP95Ms: target,
      status: "no_data",
      p95Ms: null,
      reason: "no_spans_recorded",
    };
  }
  if (typeof p95Ms !== "number" || !Number.isFinite(p95Ms)) {
    return {
      span,
      label,
      targetP95Ms: target,
      status: "no_data",
      p95Ms: null,
      reason: "p95_not_a_number",
    };
  }
  if (p95Ms <= target) {
    return { span, label, targetP95Ms: target, status: "met", p95Ms, headroomMs: target - p95Ms };
  }
  return { span, label, targetP95Ms: target, status: "missed", p95Ms, overrunMs: p95Ms - target };
}

/* ————————————————————————————————— windows ————————————————————————————————— */

export type SpanWindowSummary = {
  span: SpanName;
  label: string;
  targetP95Ms: number;
  samples: number;
  rejected: number;
  /** Distinct interventions that contributed at least one sample of this span. */
  distinctInterventions: number;
  minMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
  /** Samples beyond 4× the budget. Visible, because averaging them away hides a stall. */
  outlierSamples: number;
  /** `samples >= P95_SAMPLE_FLOOR`. A p95 below the floor is reported, not trusted. */
  meetsSampleFloor: boolean;
  verdict: SloVerdict;
  /** ms from the newest sample, or null when nothing was recorded. */
  ageMs: number | null;
};

export type WindowOptions = {
  /** Restrict to one span. Omit for all eight. */
  span?: SpanName;
  /** Only samples that STARTED at or after this epoch ms. */
  sinceMs?: number;
  /** Reference time for `ageMs`. Defaults to `Date.now()`. */
  nowMs?: number;
};

/**
 * Percentiles per span over a window. Always returns a row for every span in
 * `SPAN_DEFINITIONS` (in order) unless a single span is requested, so the panel
 * and the artifact show an unmeasured span as `no_data` rather than omitting it.
 */
export function summariseWindow(
  records: readonly SpanRecord[],
  options: WindowOptions = {},
): SpanWindowSummary[] {
  const nowMs = options.nowMs ?? Date.now();
  const wanted = options.span ? [options.span] : [...SPAN_NAMES];

  return wanted.map((span) => {
    const target = targetP95Ms(span);
    const samples = records.filter(
      (r) => r.span === span && (options.sinceMs === undefined || r.startedAtMs >= options.sinceMs),
    );
    const durations = samples.map((r) => r.durationMs);
    const dist = summarise(durations);
    const interventions = new Set(samples.map((r) => r.interventionId));
    const latest = samples.reduce(
      (max, r) => Math.max(max, r.startedAtMs),
      Number.NEGATIVE_INFINITY,
    );
    return {
      span,
      label: spanLabel(span),
      targetP95Ms: target,
      samples: dist.samples,
      rejected: dist.rejected,
      distinctInterventions: interventions.size,
      minMs: dist.minMs,
      p50Ms: dist.p50Ms,
      p95Ms: dist.p95Ms,
      p99Ms: dist.p99Ms,
      maxMs: dist.maxMs,
      meanMs: dist.meanMs,
      outlierSamples: durations.filter((d) => Number.isFinite(d) && d > target * OUTLIER_FACTOR)
        .length,
      meetsSampleFloor: dist.samples >= P95_SAMPLE_FLOOR,
      verdict: meetsTarget(span, dist.p95Ms),
      ageMs: Number.isFinite(latest) ? Math.max(0, nowMs - latest) : null,
    };
  });
}

/** Distinct interventions seen across every span in the window. */
export function countInterventions(records: readonly SpanRecord[]): number {
  return new Set(records.map((r) => r.interventionId)).size;
}

/**
 * Interventions that ran to completion — the ones carrying the terminal
 * end-to-end span. This is the count the 30-intervention gate uses, because a
 * signal that was accepted but never reached a freeze proves the intake path
 * and nothing else.
 */
export function completeInterventionIds(records: readonly SpanRecord[]): string[] {
  return [
    ...new Set(
      records
        .filter(
          (r) => r.span === TERMINAL_SPAN && Number.isFinite(r.durationMs) && r.durationMs >= 0,
        )
        .map((r) => r.interventionId),
    ),
  ];
}

/** The worst measured p95 relative to its own budget (highest overrun first). */
export function worstSpan(summaries: readonly SpanWindowSummary[]): SpanWindowSummary | null {
  let worst: SpanWindowSummary | null = null;
  let worstRatio = -Infinity;
  for (const s of summaries) {
    const p95 = s.p95Ms;
    if (p95 === null) continue;
    const ratio = p95 / s.targetP95Ms;
    if (ratio > worstRatio) {
      worst = s;
      worstRatio = ratio;
    }
  }
  return worst;
}

/**
 * `true` only if EVERY span has a measured p95 and every one met its budget.
 * `null` when at least one span is unmeasured — because "all targets met" over
 * four instrumented spans out of eight is not a claim the artifact may make.
 */
export function allTargetsMet(summaries: readonly SpanWindowSummary[]): boolean | null {
  if (summaries.length === 0) return null;
  if (summaries.some((s) => s.p95Ms === null)) return null;
  return summaries.every((s) => s.verdict.status === "met");
}

/** How many times faster than the industry baseline this p95 is. `null` if unmeasured. */
export function fasterThanBaselineBy(p95Ms: number | null, baselineMs: number): number | null {
  if (
    p95Ms === null ||
    !Number.isFinite(p95Ms) ||
    p95Ms <= 0 ||
    !Number.isFinite(baselineMs) ||
    baselineMs <= 0
  )
    return null;
  return baselineMs / p95Ms;
}

/* ————————————————————————————————— chart geometry ————————————————————————————————— */

/**
 * Log axis for the panel.
 *
 * Linear would be useless: the slowest span's budget is 60 000 ms and the
 * fastest target is 300 ms, and the baseline reference line is 2 280 000 ms. On
 * a linear axis every real measurement collapses into the first 3% of the width.
 * Log decades keep the 38-minute reference line and a 9 ms tool round-trip in
 * the same picture, which is the entire point of the panel.
 */
export const AXIS_MIN_MS = 1;
export const AXIS_MAX_MS = 4_000_000;

export const AXIS_TICKS_MS: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 1, label: "1ms" },
  { ms: 10, label: "10ms" },
  { ms: 100, label: "100ms" },
  { ms: 1_000, label: "1s" },
  { ms: 10_000, label: "10s" },
  { ms: 60_000, label: "1m" },
  { ms: 600_000, label: "10m" },
];

const LOG_MIN = Math.log10(AXIS_MIN_MS);
const LOG_SPAN = Math.log10(AXIS_MAX_MS) - LOG_MIN;

/**
 * Position on the log axis as a 0–100 percentage.
 *
 * @returns `null` for a value that cannot be drawn — including 0 and nullish.
 *   A zero-length bar would render as "perfectly fast", so the panel shows a
 *   "not measured" label in the track instead of an empty bar.
 */
export function logAxisPosition(ms: number | null | undefined): number | null {
  if (ms === null || ms === undefined) return null;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const clamped = Math.min(Math.max(ms, AXIS_MIN_MS), AXIS_MAX_MS);
  return ((Math.log10(clamped) - LOG_MIN) / LOG_SPAN) * 100;
}

/* ————————————————————————————————— wire shape ————————————————————————————————— */

/** The `/api/status/spans` payload. Declared here so route and panel agree. */
export type SloWindowSnapshot = {
  ok: boolean;
  generatedAt: string;
  /** Where the numbers came from, in words a reader can check. */
  source: string;
  windowMinutes: number | null;
  interventionsLimit: number | null;
  interventionsSeen: number;
  interventionsComplete: number;
  requiredInterventions: number;
  meets30InterventionThreshold: boolean;
  industryBaseline: { label: string; ms: number; kind: string; sources: readonly string[] };
  spans: SpanWindowSummary[];
  worst: SpanWindowSummary | null;
  allTargetsMet: boolean | null;
  /** Whether an OTLP collector is configured. Export is never required. */
  exporterConfigured: boolean;
  persistence: { kind: string; path: string; note: string } | null;
  recorder: SpanRecorderDiagnostics | null;
  store: StoreDiagnosticsShape | null;
  error?: string;
};

export type StoreDiagnosticsShape = {
  path: string;
  pending: number;
  persisted: number;
  persistErrors: number;
  lastError: string | null;
};

export { SPAN_TARGETS, SPAN_DEFINITIONS, INDUSTRY_BASELINE };
