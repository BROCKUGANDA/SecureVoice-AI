import "server-only";
/**
 * WP-7 — the evidence artifact and the operator latency block.
 *
 * Two consumers, one computation:
 *
 *   - `latencyBlock()`  → what `/api/status` and `/api/status/spans` publish.
 *   - `buildSloReport()` → what `scripts/emit-slo.ts` writes to
 *     `evidence/latency/slo.json`.
 *
 * ## The rule this file exists to enforce
 *
 * Every number is computed from spans the running platform recorded. There is no
 * transcription path, no fallback constant, no "typical value" seeded into an
 * empty field. A span with no samples serialises as `null` with
 * `value_kind: "not_measured"`, and the gate fails on an under-counted
 * intervention rather than on an absent measurement being quietly treated as a
 * pass. The previous revision of this artifact hardcoded two figures and called
 * the field `measured_p95_ms`; `docs/VERIFICATION.md` records that as the bug
 * this replaces.
 */

import { INDUSTRY_BASELINE, TERMINAL_SPAN, type SpanName, type SpanRecord } from "./spans";
import {
  P95_SAMPLE_FLOOR,
  allTargetsMet,
  completeInterventionIds,
  countInterventions,
  summariseWindow,
  worstSpan,
  type SloWindowSnapshot,
  type SpanWindowSummary,
} from "./slo";
import { MAX_READ_BYTES, readSpanRecords, spanLogDisplayPath, telemetryHealth } from "./store";
import { exporterConfigured } from "./export";

export const EVIDENCE_SCHEMA_VERSION = "2.0";

/** The brief's definition of done. */
export const REQUIRED_INTERVENTIONS = 30;

export const PERSISTENCE_NOTE =
  "File-backed append-only JSONL on local disk (prisma/schema.prisma is owned by another work package, so no table was added). " +
  "It is per-instance, not shared, lost on container restart unless evidence/ is a mounted volume, and has no retention policy. " +
  "Treat these numbers as this instance's measurements, not a fleet aggregate.";

const DISCLAIMER =
  "Every value below is computed from spans recorded by the running platform (src/lib/telemetry/spans.ts -> spans.jsonl). " +
  "Nothing is transcribed, estimated or synthesised. `null` means NOT MEASURED and is not a pass; `value_kind` says which it is.";

/* ————————————————————————————————— rows ————————————————————————————————— */

export type SloSpanRow = {
  name: SpanName;
  label: string;
  target_p95_ms: number;
  samples: number;
  interventions: number;
  meets_sample_floor: boolean;
  outlier_samples: number;
  min_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
  mean_ms: number | null;
  value_kind: "measured" | "not_measured";
  verdict: "met" | "missed" | "no_data";
  headroom_ms: number | null;
};

function toRow(summary: SpanWindowSummary): SloSpanRow {
  const verdict = summary.verdict;
  return {
    name: summary.span,
    label: summary.label,
    target_p95_ms: summary.targetP95Ms,
    samples: summary.samples,
    interventions: summary.distinctInterventions,
    meets_sample_floor: summary.meetsSampleFloor,
    outlier_samples: summary.outlierSamples,
    min_ms: summary.minMs,
    p50_ms: summary.p50Ms,
    p95_ms: summary.p95Ms,
    p99_ms: summary.p99Ms,
    max_ms: summary.maxMs,
    mean_ms: summary.meanMs,
    value_kind: summary.samples > 0 ? "measured" : "not_measured",
    verdict: verdict.status,
    headroom_ms: verdict.status === "met" ? verdict.headroomMs : null,
  };
}

/* ————————————————————————————————— evidence ————————————————————————————————— */

export type SloEvidence = {
  schema_version: string;
  generated_at: string;
  kind: "measured";
  disclaimer: string;
  generated_by: string;
  source: {
    recorder: string;
    log: string;
    window_minutes: number | null;
    records_read: number;
    malformed_lines: number;
    truncated: boolean;
    bytes_read: number;
    log_missing: boolean;
    read_error: string | null;
  };
  persistence: { kind: "file"; path: string; note: string; max_read_bytes: number };
  /** Definition of "an intervention", published so the count can be audited. */
  intervention_definition: {
    unit: string;
    terminal_span: SpanName;
    note: string;
  };
  interventions_seen: number;
  interventions_measured: number;
  required_interventions: number;
  meets_30_intervention_threshold: boolean;
  sample_floor: number;
  industry_baseline: { label: string; ms: number; kind: string; sources: readonly string[] };
  spans: SloSpanRow[];
  spans_not_measured: SpanName[];
  worst: { name: SpanName; label: string; p95_ms: number; target_p95_ms: number; ratio: number } | null;
  all_targets_met: boolean | null;
  gate: {
    meets_30_intervention_threshold: boolean;
    all_measured_targets_met: boolean | null;
    exit_code: 0 | 1;
    reasons: string[];
  };
};

export type SloReportOptions = {
  /** Restrict to samples started within this many minutes. `null` = all time. */
  windowMinutes?: number | null;
  /** Restrict to the newest N distinct interventions. */
  interventions?: number | null;
  requiredInterventions?: number;
  nowMs?: number;
};

export type SpanReadSource = {
  records: readonly SpanRecord[];
  recordsRead: number;
  malformedLines: number;
  truncated: boolean;
  bytesRead: number;
  missing: boolean;
  error: string | null;
};

export type SloReportResult = {
  report: SloEvidence;
  /** True only when the gate passes: threshold met AND no measured span missed. */
  ok: boolean;
  exitCode: 0 | 1;
  reasons: string[];
};

/**
 * Build the evidence artifact from recorded spans. Pure with respect to the
 * filesystem (the caller supplies the records), so the gate is testable without
 * a disk and without inventing data.
 */
export function buildSloReport(source: SpanReadSource, options: SloReportOptions = {}): SloReportResult {
  const nowMs = options.nowMs ?? Date.now();
  const required = options.requiredInterventions ?? REQUIRED_INTERVENTIONS;
  const sinceMs =
    options.windowMinutes !== undefined && options.windowMinutes !== null ? nowMs - options.windowMinutes * 60_000 : undefined;

  const records = source.records.filter((r) => (sinceMs === undefined ? true : r.startedAtMs >= sinceMs));

  const summaries = summariseWindow(records, { sinceMs, nowMs });
  const rows = summaries.map(toRow);
  const seen = countInterventions(records);
  const complete = completeInterventionIds(records);
  const meetsThreshold = complete.length >= required;
  const metAllMeasured = allTargetsMet(summaries.filter((s) => s.samples > 0));
  const worst = worstSpan(summaries);
  const worstP95 = worst?.p95Ms ?? null;

  const reasons: string[] = [];
  if (source.missing) {
    reasons.push(`No span log at ${spanLogDisplayPath()} - nothing has ever been recorded by this instance.`);
  } else if (source.error) {
    reasons.push(`Span log unreadable: ${source.error}`);
  }
  if (records.length === 0) {
    reasons.push("Zero spans in the window - every span below is not_measured.");
  }
  if (!meetsThreshold) {
    reasons.push(
      `Only ${complete.length} complete intervention(s) recorded (an intervention counts only when "${TERMINAL_SPAN}" completed); ` +
        `the brief requires ${required} real interventions.`,
    );
  }
  for (const s of summaries) {
    if (s.verdict.status === "missed" && s.p95Ms !== null) {
      reasons.push(`"${s.label}" p95 ${s.p95Ms} ms exceeds its ${s.targetP95Ms} ms budget.`);
    }
  }

  const exitCode: 0 | 1 = reasons.length === 0 ? 0 : 1;

  const report: SloEvidence = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    generated_at: new Date(nowMs).toISOString(),
    kind: "measured",
    disclaimer: DISCLAIMER,
    generated_by: "scripts/emit-slo.ts",
    source: {
      recorder: "src/lib/telemetry/spans.ts (recordSpan)",
      log: spanLogDisplayPath(),
      window_minutes: options.windowMinutes ?? null,
      records_read: source.recordsRead,
      malformed_lines: source.malformedLines,
      truncated: source.truncated,
      bytes_read: source.bytesRead,
      log_missing: source.missing,
      read_error: source.error,
    },
    persistence: { kind: "file", path: spanLogDisplayPath(), note: PERSISTENCE_NOTE, max_read_bytes: MAX_READ_BYTES },
    intervention_definition: {
      unit: "distinct interventionId",
      terminal_span: TERMINAL_SPAN,
      note:
        "An intervention counts toward the gate only when its end-to-end span completed. " +
        "A signal that was received and accepted but never reached a freeze proves the intake path alone.",
    },
    interventions_seen: seen,
    interventions_measured: complete.length,
    required_interventions: required,
    meets_30_intervention_threshold: meetsThreshold,
    sample_floor: P95_SAMPLE_FLOOR,
    industry_baseline: {
      label: INDUSTRY_BASELINE.label,
      ms: INDUSTRY_BASELINE.ms,
      kind: INDUSTRY_BASELINE.kind,
      sources: INDUSTRY_BASELINE.sources,
    },
    spans: rows,
    spans_not_measured: rows.filter((r) => r.value_kind === "not_measured").map((r) => r.name),
    worst:
      worst && worstP95 !== null
        ? { name: worst.span, label: worst.label, p95_ms: worstP95, target_p95_ms: worst.targetP95Ms, ratio: worstP95 / worst.targetP95Ms }
        : null,
    all_targets_met: allTargetsMet(summaries),
    gate: {
      meets_30_intervention_threshold: meetsThreshold,
      all_measured_targets_met: metAllMeasured,
      exit_code: exitCode,
      reasons,
    },
  };

  return { report, ok: exitCode === 0, exitCode, reasons };
}

/* ————————————————————————————————— reads ————————————————————————————————— */

export async function loadSloSource(options: SloReportOptions = {}): Promise<SpanReadSource> {
  const read = await readSpanRecords(
    options.interventions && options.interventions > 0 ? { interventions: options.interventions } : {},
  );
  return {
    records: read.records,
    recordsRead: read.records.length,
    malformedLines: read.malformedLines,
    truncated: read.truncated,
    bytesRead: read.bytesRead,
    missing: read.missing,
    error: read.error,
  };
}

/** Read the log and build the artifact. */
export async function emitSloReport(options: SloReportOptions = {}): Promise<SloReportResult> {
  const source = await loadSloSource(options);
  return buildSloReport(source, options);
}

/* ————————————————————————————————— operator block ————————————————————————————————— */

/**
 * The latency block for the status surface. `ok: false` whenever nothing is
 * measured, so a caller can render "no data" instead of an empty-but-healthy
 * looking dashboard.
 *
 * `/api/status/route.ts` can add this with one line:
 *   `latency: await latencyBlock()`
 */
export async function latencyBlock(
  options: { windowMinutes?: number | null; interventions?: number | null } = {},
): Promise<SloWindowSnapshot> {
  const windowMinutes = options.windowMinutes ?? null;
  const interventionsLimit = options.interventions ?? null;
  const nowMs = Date.now();
  const sinceMs = windowMinutes === null ? undefined : nowMs - windowMinutes * 60_000;

  const read = await readSpanRecords(interventionsLimit && interventionsLimit > 0 ? { interventions: interventionsLimit } : {});
  const records = read.records.filter((r) => (sinceMs === undefined ? true : r.startedAtMs >= sinceMs));
  const summaries = summariseWindow(records, { sinceMs, nowMs });
  const complete = completeInterventionIds(records);
  const health = telemetryHealth();

  const snapshot: SloWindowSnapshot = {
    ok: records.length > 0 && read.error === null,
    generatedAt: new Date(nowMs).toISOString(),
    source: read.missing ? "no span log on this instance yet" : `recorded spans from ${spanLogDisplayPath()} (file-backed local log)`,
    windowMinutes,
    interventionsLimit,
    interventionsSeen: countInterventions(records),
    interventionsComplete: complete.length,
    requiredInterventions: REQUIRED_INTERVENTIONS,
    meets30InterventionThreshold: complete.length >= REQUIRED_INTERVENTIONS,
    industryBaseline: {
      label: INDUSTRY_BASELINE.label,
      ms: INDUSTRY_BASELINE.ms,
      kind: INDUSTRY_BASELINE.kind,
      sources: INDUSTRY_BASELINE.sources,
    },
    spans: summaries,
    worst: worstSpan(summaries),
    allTargetsMet: allTargetsMet(summaries),
    exporterConfigured: exporterConfigured(),
    persistence: { kind: "file", path: spanLogDisplayPath(), note: PERSISTENCE_NOTE },
    recorder: health.recorder,
    store: health.store,
  };

  if (read.error) snapshot.error = `span_log_unreadable: ${read.error}`;
  else if (read.malformedLines > 0) snapshot.error = `span_log_has_${read.malformedLines}_unreadable_line(s)`;
  return snapshot;
}
