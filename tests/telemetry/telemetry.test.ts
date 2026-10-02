/**
 * WP-7 — latency instrumentation and the SLO gate.
 *
 * This suite is the gate, not a smoke test. It proves four properties, each of
 * which the previous revision of `evidence/latency/slo.json` violated:
 *
 *   1. **Percentile maths.** Nearest rank, never interpolated; an empty window
 *      returns `null` and NEVER `0` (a 0 ms p95 is the most flattering lie a
 *      dashboard can tell).
 *   2. **The budget table.** All eight targets from the brief, verbatim, and a
 *      verdict at target / just-over-target / unmeasured for every one of them.
 *   3. **Recording cannot fail a request.** Malformed input is counted and
 *      dropped; an unwritable log is reported, not thrown.
 *   4. **The emitter cannot claim success it does not have.** Under 30 real
 *      interventions it writes the real count and exits non-zero — verified both
 *      against the pure gate and against the real script over a real file.
 *
 *   bun test tests/telemetry
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SloChart } from "@/components/slo/SloPanel";

import {
  INDUSTRY_BASELINE,
  SPAN_DEFINITIONS,
  SPAN_NAMES,
  SPAN_TARGETS,
  TERMINAL_SPAN,
  parseSpanRecord,
  recordSpan,
  resetSpans,
  telemetryDiagnostics,
  toOtlpSpans,
  type SpanInput,
  type SpanName,
  type SpanRecord,
} from "@/lib/telemetry/spans";
import {
  P95_SAMPLE_FLOOR,
  allTargetsMet,
  completeInterventionIds,
  countInterventions,
  fasterThanBaselineBy,
  logAxisPosition,
  meetsTarget,
  percentile,
  summarise,
  summariseWindow,
  worstSpan,
} from "@/lib/telemetry/slo";
import { flushSpansNow, readSpanRecords, recordSpanAndPersist, resetStoreState, storeDiagnostics } from "@/lib/telemetry/store";
import { REQUIRED_INTERVENTIONS, buildSloReport } from "@/lib/telemetry/report";

const ROOT = resolve(import.meta.dir, "..", "..");
const EMITTER = join(ROOT, "scripts", "emit-slo.ts");
const BASE = Date.UTC(2026, 9, 2, 12, 0, 0);

/** One record per span, with a duration inside its budget. */
function seed(overrides: Partial<SpanInput> = {}): SpanRecord {
  const record = recordSpan({
    span: TERMINAL_SPAN,
    startedAtMs: BASE,
    durationMs: 1_000,
    interventionId: "SV-F-TEST0001",
    conversationId: "conv-test",
    caseRef: "SV-F-TEST0001",
    ...overrides,
  });
  if (record === null) throw new Error("seed span was rejected — the recorder contract is broken");
  return record;
}

/**
 * A complete intervention: all eight spans.
 *
 * @param fill fraction of each span's own budget. 0.1 is comfortably inside;
 *   2 is deliberately outside (every span misses).
 */
function completeIntervention(id: string, fill = 0.1): SpanRecord[] {
  return SPAN_DEFINITIONS.map((d) => {
    const record = recordSpan({
      span: d.name,
      startedAtMs: BASE,
      durationMs: Math.round(d.targetP95Ms * fill),
      interventionId: id,
      conversationId: `conv-${id}`,
      caseRef: id,
    });
    if (record === null) throw new Error(`seed span ${d.name} rejected`);
    return record;
  });
}

/** The same, through the durable path — what a real deployment calls. */
function persistIntervention(id: string, fill = 0.1): void {
  for (const d of SPAN_DEFINITIONS) {
    const record = recordSpanAndPersist({
      span: d.name,
      startedAtMs: BASE,
      durationMs: Math.round(d.targetP95Ms * fill),
      interventionId: id,
      conversationId: `conv-${id}`,
      caseRef: id,
    });
    if (record === null) throw new Error(`persisted span ${d.name} rejected`);
  }
}

const range = (n: number, from = 1, to = n) => Array.from({ length: n }, (_, i) => from + i);

let tmp: string | null = null;

beforeEach(() => {
  resetSpans();
  resetStoreState();
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  delete process.env.TELEMETRY_SPAN_LOG;
  delete process.env.SLO_EVIDENCE_PATH;
});

/* ═══════════════════════════ 1. percentile maths ═══════════════════════════ */

describe("percentile maths", () => {
  test("an empty window is null, never zero", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();
    const empty = summarise([]);
    expect(empty.samples).toBe(0);
    expect(empty.p50Ms).toBeNull();
    expect(empty.p95Ms).toBeNull();
    expect(empty.p99Ms).toBeNull();
    expect(empty.meanMs).toBeNull();
    // The specific failure this guards: a caller writing `p95Ms ?? 0` turns
    // "not measured" into "faster than anyone has ever been". The count is
    // legitimately 0; every DURATION is null.
    expect(empty.p95Ms).not.toBe(0);
    expect([empty.minMs, empty.p50Ms, empty.p95Ms, empty.p99Ms, empty.maxMs, empty.meanMs]).toEqual([
      null, null, null, null, null, null,
    ]);
  });

  test("a single sample is every percentile", () => {
    for (const p of [0, 50, 95, 99, 100]) {
      const got = percentile([42], p);
      expect(got).not.toBeNull();
      expect(got as number).toBe(42);
    }
    const one = summarise([42]);
    expect(one).toMatchObject({ samples: 1, minMs: 42, p50Ms: 42, p95Ms: 42, p99Ms: 42, maxMs: 42, meanMs: 42, rejected: 0 });
  });

  test("p50 / p95 / p99 over 100 samples are exact", () => {
    const values = range(100); // 1..100
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
  });

  test("nearest rank is used — the result is always an observed sample", () => {
    const values = [1, 2, 3];
    // rank = ceil(0.50 × 3) = 2 → 2;  NOT 2 (an interpolation would also be 2,
    // so use the 95 case where the two methods disagree: 2.85 vs 3).
    expect(percentile(values, 50)).toBe(2);
    // rank = ceil(0.95 × 3) = 3 → 3. Linear interpolation would give 2.9, a
    // number this system never produced.
    expect(percentile(values, 95)).toBe(3);
    expect(values).toContain(percentile(values, 95) as number);
  });

  test("input order does not matter and the caller's array is not mutated", () => {
    const values = [9, 1, 5, 3];
    const snapshotCopy = [...values];
    // Nearest rank over 4 samples picks the 2nd smallest (3). It is
    // deliberately NOT the interpolated median (5) — see the nearest-rank test.
    expect(percentile(values, 50)).toBe(3);
    expect(percentile([...values].reverse(), 50)).toBe(3);
    expect(values).toEqual(snapshotCopy);
  });

  test("a p outside 0..100 is a caller bug and throws rather than lying", () => {
    expect(() => percentile([1, 2], -1)).toThrow(RangeError);
    expect(() => percentile([1, 2], 101)).toThrow(RangeError);
    expect(() => percentile([1, 2], Number.NaN)).toThrow(RangeError);
  });

  test("non-finite samples are rejected and counted, never silently averaged", () => {
    const dist = summarise([10, Number.NaN, 20, Number.POSITIVE_INFINITY, 30]);
    expect(dist.samples).toBe(3);
    expect(dist.rejected).toBe(2);
    expect(dist.p50Ms).toBe(20);
    expect(dist.p95Ms).toBe(30);
    expect(dist.meanMs).toBe(20);
  });

  test("the sample floor is the brief's 30, and it is enforced per span", () => {
    expect(P95_SAMPLE_FLOOR).toBe(30);
    const few = summariseWindow(Array.from({ length: 29 }, () => seed()));
    const freeze = few.find((s) => s.span === TERMINAL_SPAN);
    expect(freeze?.samples).toBe(29);
    expect(freeze?.meetsSampleFloor).toBe(false);
    expect(freeze?.p95Ms).toBe(1_000); // reported, just not trusted
  });
});

/* ═══════════════════════════ 2. targets and verdicts ═══════════════════════ */

describe("span targets", () => {
  test("the budget table is the brief's table, verbatim", () => {
    const expected: Record<SpanName, number> = {
      signal_received_to_accepted: 300,
      signal_accepted_to_provider_accepted: 1_500,
      signal_received_to_ringing: 5_000,
      answered_to_first_agent_word: 1_200,
      caller_stop_to_agent_audio: 1_500,
      tool_request_to_response: 300,
      fraud_confirmed_to_webhook_delivered: 2_000,
      signal_received_to_freeze_staged: 60_000,
    };
    expect(Object.keys(SPAN_TARGETS).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, target] of Object.entries(expected)) {
      expect(SPAN_TARGETS[name as SpanName]).toBe(target);
    }
    expect(SPAN_DEFINITIONS).toHaveLength(8);
    expect(SPAN_NAMES).toHaveLength(8);
  });

  test("every span judges met / missed / no_data with the target attached", () => {
    for (const span of SPAN_NAMES) {
      const target = SPAN_TARGETS[span];

      const exact = meetsTarget(span, target);
      expect(exact.status).toBe("met");
      expect(exact.targetP95Ms).toBe(target);
      if (exact.status === "met") expect(exact.headroomMs).toBe(0);

      const over = meetsTarget(span, target + 1);
      expect(over.status).toBe("missed");
      expect(over.targetP95Ms).toBe(target);
      if (over.status === "missed") expect(over.overrunMs).toBe(1);

      const missing = meetsTarget(span, null);
      expect(missing.status).toBe("no_data");
      expect(missing.targetP95Ms).toBe(target);
      expect(missing.p95Ms).toBeNull();
      if (missing.status === "no_data") expect(missing.reason).toBe("no_spans_recorded");
    }
  });

  test("a NaN p95 is no_data, not a pass and not a crash", () => {
    const verdict = meetsTarget("signal_received_to_accepted", Number.NaN);
    expect(verdict.status).toBe("no_data");
    if (verdict.status === "no_data") expect(verdict.reason).toBe("p95_not_a_number");
  });

  test("the industry baseline is 38 minutes and is labelled as literature", () => {
    expect(INDUSTRY_BASELINE.ms).toBe(2_280_000);
    expect(INDUSTRY_BASELINE.kind).toBe("literature");
    expect(INDUSTRY_BASELINE.sources.length).toBeGreaterThan(0);
    expect(fasterThanBaselineBy(60_000, INDUSTRY_BASELINE.ms)).toBeCloseTo(38, 5);
    // No measurement → no speedup claim.
    expect(fasterThanBaselineBy(null, INDUSTRY_BASELINE.ms)).toBeNull();
    expect(fasterThanBaselineBy(0, INDUSTRY_BASELINE.ms)).toBeNull();
  });

  test("the log axis holds both a 9 ms tool round-trip and the 38-minute line", () => {
    const tool = logAxisPosition(9);
    const freeze = logAxisPosition(60_000);
    const baseline = logAxisPosition(INDUSTRY_BASELINE.ms);
    expect(tool).not.toBeNull();
    expect(freeze).not.toBeNull();
    expect(baseline).not.toBeNull();
    // The whole reason the axis is log: on a linear axis to 2 280 000 ms, a
    // 9 ms tool call would sit at 0.0004% of the width.
    expect(tool as number).toBeGreaterThan(10);
    expect(freeze as number).toBeGreaterThan(tool as number);
    expect(baseline as number).toBeGreaterThan(freeze as number);
    expect(baseline as number).toBeLessThanOrEqual(100);
    // A zero/absent measurement must not produce a drawable position.
    expect(logAxisPosition(0)).toBeNull();
    expect(logAxisPosition(null)).toBeNull();
    expect(logAxisPosition(undefined)).toBeNull();
  });
});

/* ═══════════════════════════ 3. recording never throws ═════════════════════ */

describe("the recorder", () => {
  test("a valid span produces a fully correlated record", () => {
    const record = seed({ durationMs: 1_234.5, attributes: { channel: "card", risk: 0.94, live: true } });
    expect(record.span).toBe(TERMINAL_SPAN);
    expect(record.durationMs).toBe(1_234.5);
    expect(record.startedAt).toBe(new Date(BASE).toISOString());
    expect(record.endedAtMs).toBe(BASE + 1_234.5);
    expect(record.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(record.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(record.caseRef).toBe("SV-F-TEST0001");
    expect(record.conversationId).toBe("conv-test");
    expect(record.attributes).toEqual({ channel: "card", risk: 0.94, live: true });
  });

  test("every span of one intervention shares a trace id", () => {
    const records = completeIntervention("SV-F-SHARED");
    expect(new Set(records.map((r) => r.traceId)).size).toBe(1);
    expect(new Set(records.map((r) => r.spanId)).size).toBe(SPAN_DEFINITIONS.length);
  });

  test("malformed input is counted and dropped — never recorded, never thrown", () => {
    const cases: Array<[string, SpanInput]> = [
      ["unknown span", { span: "not_a_span", startedAtMs: BASE, durationMs: 1 }],
      ["negative duration", { span: TERMINAL_SPAN, startedAtMs: BASE, endedAtMs: BASE - 5 }],
      ["end before start", { span: TERMINAL_SPAN, startedAtMs: BASE, durationMs: -1 }],
      ["NaN start", { span: TERMINAL_SPAN, startedAtMs: Number.NaN, durationMs: 1 }],
      ["NaN duration", { span: TERMINAL_SPAN, startedAtMs: BASE, durationMs: Number.NaN }],
      ["infinite duration", { span: TERMINAL_SPAN, startedAtMs: BASE, durationMs: Number.POSITIVE_INFINITY }],
      // 1e15 is still a representable epoch (+033658). MAX_VALUE is not, and
      // `toISOString()` throws on it — the recorder must not.
      ["epoch out of range", { span: TERMINAL_SPAN, startedAtMs: Number.MAX_VALUE, durationMs: 1 }],
    ];
    for (const [label, input] of cases) {
      let thrown: unknown = null;
      let result: SpanRecord | null = null;
      try {
        result = recordSpan(input);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `${label} must not throw`).toBeNull();
      expect(result, `${label} must be rejected`).toBeNull();
    }
    const diag = telemetryDiagnostics();
    expect(diag.recorded).toBe(0);
    expect(diag.droppedInvalid).toBe(cases.length);
    expect(diag.lastRejection).toBeTruthy();
  });

  test("a corrupt log line is skipped, not coerced", () => {
    expect(parseSpanRecord("not json")).toBeNull();
    expect(parseSpanRecord(null)).toBeNull();
    expect(parseSpanRecord({ span: "nope", durationMs: 1, startedAtMs: BASE })).toBeNull();
    expect(parseSpanRecord({ span: TERMINAL_SPAN, durationMs: -1, startedAtMs: BASE })).toBeNull();
    expect(parseSpanRecord({ span: TERMINAL_SPAN, durationMs: Number.NaN, startedAtMs: BASE })).toBeNull();
    const good = parseSpanRecord({ span: TERMINAL_SPAN, durationMs: 7, startedAtMs: BASE, interventionId: "i-1" });
    expect(good?.durationMs).toBe(7);
    expect(good?.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("a span survives the JSONL round trip byte-for-byte on its numbers", async () => {
    tmp = mkdtempSync(join(tmpdir(), "sv-telemetry-"));
    const logPath = join(tmp, "spans.jsonl");
    process.env.TELEMETRY_SPAN_LOG = logPath;

    const written = recordSpanAndPersist({ span: "tool_request_to_response", startedAtMs: BASE, durationMs: 9.25, interventionId: "SV-F-ROUNDTRIP" });
    expect(written).not.toBeNull();
    await flushSpansNow();

    const read = await readSpanRecords();
    expect(read.error).toBeNull();
    expect(read.missing).toBe(false);
    expect(read.records).toHaveLength(1);
    expect(read.records[0]?.durationMs).toBe(9.25);
    expect(read.records[0]?.span).toBe("tool_request_to_response");
    expect(read.records[0]?.interventionId).toBe("SV-F-ROUNDTRIP");
    expect(read.records[0]?.startedAt).toBe(written?.startedAt);
  });

  test("an unwritable log is reported, never thrown at the caller", async () => {
    tmp = mkdtempSync(join(tmpdir(), "sv-telemetry-"));
    // Point the log AT a directory: mkdir succeeds, append fails with EISDIR.
    process.env.TELEMETRY_SPAN_LOG = tmp;

    const record = recordSpanAndPersist({ span: TERMINAL_SPAN, startedAtMs: BASE, durationMs: 5, interventionId: "SV-F-EISDIR" });
    expect(record).not.toBeNull(); // the in-memory ring still has it
    await flushSpansNow();

    const diag = storeDiagnostics();
    expect(diag.persistErrors).toBeGreaterThan(0);
    expect(diag.lastError).toBeTruthy();

    const read = await readSpanRecords();
    expect(read.error).toBe("not_a_file");
    expect(read.records).toHaveLength(0);
  });

  test("a missing log reads as missing, not as zero measurements", async () => {
    tmp = mkdtempSync(join(tmpdir(), "sv-telemetry-"));
    process.env.TELEMETRY_SPAN_LOG = join(tmp, "never-written.jsonl");
    const read = await readSpanRecords();
    expect(read.missing).toBe(true);
    expect(read.error).toBeNull();
    expect(read.records).toEqual([]);
  });

  test("the OTLP shape is produced with no dependency and no collector", () => {
    const payload = toOtlpSpans(completeIntervention("SV-F-OTLP"));
    const group = payload.resourceSpans[0];
    expect(group?.scopeSpans[0]?.spans).toHaveLength(SPAN_DEFINITIONS.length);
    const first = group?.scopeSpans[0]?.spans[0];
    expect(first?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first?.spanId).toMatch(/^[0-9a-f]{16}$/);
    // Unix nanos as a decimal string — the OTLP/JSON encoding for 64-bit ints.
    expect(typeof first?.startTimeUnixNano).toBe("string");
    expect(BigInt(first?.startTimeUnixNano ?? "0")).toBe(BigInt(BASE) * 1_000_000n);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});

/* ═══════════════════════════ window summaries ══════════════════════════════ */

describe("window summaries", () => {
  test("an empty window yields one no_data row per span — none omitted, none zeroed", () => {
    const rows = summariseWindow([]);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.samples).toBe(0);
      expect(row.p50Ms).toBeNull();
      expect(row.p95Ms).toBeNull();
      expect(row.verdict.status).toBe("no_data");
      expect(row.meetsSampleFloor).toBe(false);
      expect(row.ageMs).toBeNull();
    }
    expect(allTargetsMet(rows)).toBeNull();
    expect(worstSpan(rows)).toBeNull();
  });

  test("one measured span does not make the other seven look measured", () => {
    const rows = summariseWindow(completeIntervention("SV-F-ONE"));
    for (const row of rows) {
      expect(row.samples).toBe(1);
      expect(row.verdict.status).toBe("met");
    }
    expect(countInterventions(completeIntervention("SV-F-ONE"))).toBe(1);
  });

  test("only the terminal span makes an intervention 'complete'", () => {
    const partial = SPAN_DEFINITIONS.filter((d) => d.name !== TERMINAL_SPAN).map((d) =>
      recordSpan({ span: d.name, startedAtMs: BASE, durationMs: 10, interventionId: "SV-F-PARTIAL" }),
    ) as SpanRecord[];
    expect(countInterventions(partial)).toBe(1);
    expect(completeInterventionIds(partial)).toHaveLength(0);

    const full = completeIntervention("SV-F-FULL");
    expect(completeInterventionIds(full)).toEqual(["SV-F-FULL"]);
  });

  test("the window excludes samples older than the requested range", () => {
    const recent = recordSpan({ span: TERMINAL_SPAN, startedAtMs: BASE + 60_000, durationMs: 10, interventionId: "i-recent" });
    const old = recordSpan({ span: TERMINAL_SPAN, startedAtMs: BASE, durationMs: 99_000, interventionId: "i-old" });
    expect(recent).not.toBeNull();
    expect(old).not.toBeNull();
    const rows = summariseWindow([recent as SpanRecord, old as SpanRecord], { sinceMs: BASE + 60_000, nowMs: BASE + 60_000 });
    const freeze = rows.find((r) => r.span === TERMINAL_SPAN);
    expect(freeze?.samples).toBe(1);
    expect(freeze?.p95Ms).toBe(10);
  });

  test("allTargetsMet is true, false, or null — and null means 'cannot claim'", () => {
    const met = summariseWindow(completeIntervention("SV-F-MET"));
    expect(allTargetsMet(met)).toBe(true);

    // Every span at 2× its own budget: a real miss, not a rounding artefact.
    const slow = summariseWindow(completeIntervention("SV-F-SLOW", 2));
    expect(allTargetsMet(slow)).toBe(false);
    expect(slow.every((r) => r.verdict.status === "missed")).toBe(true);
    expect(slow.every((r) => r.p95Ms === r.targetP95Ms * 2)).toBe(true);
    expect(worstSpan(slow)?.verdict.status).toBe("missed");

    // Worst is by OVERRUN RATIO, not absolute milliseconds: the freeze span is
    // the slowest span and still the healthiest one, because its budget is
    // 200× the tool budget. Ranking by raw ms would flag the wrong row.
    const ranked = summariseWindow([
      recordSpan({ span: TERMINAL_SPAN, startedAtMs: BASE, durationMs: 90_000, interventionId: "r-1" }) as SpanRecord,
      recordSpan({ span: "tool_request_to_response", startedAtMs: BASE, durationMs: 1_200, interventionId: "r-2" }) as SpanRecord,
    ]);
    expect(worstSpan(ranked)?.span).toBe("tool_request_to_response");
    expect(worstSpan(ranked)?.p95Ms).toBe(1_200);

    // Half instrumented: honest answer is "unknown", not "true".
    const half = SPAN_DEFINITIONS.slice(0, 4).map((d) =>
      recordSpan({ span: d.name, startedAtMs: BASE, durationMs: 1, interventionId: "SV-F-HALF" }),
    ) as SpanRecord[];
    expect(allTargetsMet(summariseWindow(half))).toBeNull();
  });
});

/* ═══════════════════════════ 4. the emitter gate ═══════════════════════════ */

describe("the SLO evidence gate", () => {
  const emptySource = {
    records: [] as SpanRecord[],
    recordsRead: 0,
    malformedLines: 0,
    truncated: false,
    bytesRead: 0,
    missing: true,
    error: null,
  };

  test("zero recorded interventions is a FAIL with a real count, not a silent 0", () => {
    const { report, ok, exitCode, reasons } = buildSloReport(emptySource);
    expect(ok).toBe(false);
    expect(exitCode).toBe(1);
    expect(report.meets_30_intervention_threshold).toBe(false);
    expect(report.interventions_measured).toBe(0);
    expect(report.required_interventions).toBe(REQUIRED_INTERVENTIONS);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join(" ")).toContain(String(REQUIRED_INTERVENTIONS));
    // Every span row exists and is honestly empty.
    expect(report.spans).toHaveLength(8);
    for (const row of report.spans) {
      expect(row.value_kind).toBe("not_measured");
      expect(row.p95_ms).toBeNull();
      expect(row.verdict).toBe("no_data");
      expect(row.target_p95_ms).toBeGreaterThan(0);
    }
    expect(report.spans_not_measured).toHaveLength(8);
    expect(report.all_targets_met).toBeNull();
    expect(report.worst).toBeNull();
  });

  test("29 interventions fails and 30 passes — the threshold is real", () => {
    const under = buildSloReport(
      { ...emptySource, missing: false, records: Array.from({ length: 29 }, (_, i) => completeIntervention(`SV-F-${i}`)).flat() },
    );
    expect(under.report.interventions_measured).toBe(29);
    expect(under.report.meets_30_intervention_threshold).toBe(false);
    expect(under.exitCode).toBe(1);

    const at = buildSloReport(
      { ...emptySource, missing: false, records: Array.from({ length: 30 }, (_, i) => completeIntervention(`SV-F-${i}`)).flat() },
    );
    expect(at.report.interventions_measured).toBe(30);
    expect(at.report.meets_30_intervention_threshold).toBe(true);
    expect(at.exitCode).toBe(0);
    expect(at.ok).toBe(true);
    expect(at.reasons).toEqual([]);
  });

  test("interventions that never reached a freeze do not count", () => {
    const neverFinished = SPAN_DEFINITIONS.filter((d) => d.name !== TERMINAL_SPAN).map((d) =>
      recordSpan({ span: d.name, startedAtMs: BASE, durationMs: 5, interventionId: `SV-F-OPEN-${d.name}` }),
    ) as SpanRecord[];
    const { report, exitCode } = buildSloReport({ ...emptySource, missing: false, records: neverFinished });
    expect(report.interventions_seen).toBe(7);
    expect(report.interventions_measured).toBe(0);
    expect(report.meets_30_intervention_threshold).toBe(false);
    expect(exitCode).toBe(1);
  });

  test("a measured span over budget fails the gate and names the span", () => {
    // Thirty interventions that each take twice their budget on every span.
    // (Appending ONE slow sample to thirty fast ones would NOT fail: at n=31
    // the 95th percentile is still a fast sample, and pretending otherwise
    // would be a test that flatters the maths.)
    const records = Array.from({ length: 30 }, (_, i) => completeIntervention(`SV-F-${i}`, 2)).flat();
    const { report, exitCode, reasons } = buildSloReport({ ...emptySource, missing: false, records });
    expect(report.meets_30_intervention_threshold).toBe(true);
    expect(report.all_targets_met).toBe(false);
    expect(exitCode).toBe(1);
    expect(reasons.join(" ")).toContain("tool request");
    const tool = report.spans.find((s) => s.name === "tool_request_to_response");
    expect(tool?.verdict).toBe("missed");
    expect(tool?.p95_ms).toBe(600);
    expect(tool?.target_p95_ms).toBe(300);
    expect(tool?.value_kind).toBe("measured");
  });

  test("published percentiles equal the maths, computed from the same records", () => {
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const records = durations.map((ms, i) =>
      recordSpan({ span: TERMINAL_SPAN, startedAtMs: BASE + i, durationMs: ms, interventionId: `SV-F-${i}` }) as SpanRecord,
    );
    const { report } = buildSloReport({ ...emptySource, missing: false, records });
    const row = report.spans.find((s) => s.name === TERMINAL_SPAN);
    // Nearest rank over n=10: p50 → ceil(5) = 5th → 50; p95 → ceil(9.5) = 10th → 100.
    expect(row?.p50_ms).toBe(percentile(durations, 50));
    expect(row?.p50_ms).toBe(50);
    expect(row?.p95_ms).toBe(percentile(durations, 95));
    expect(row?.p95_ms).toBe(100);
    expect(row?.p99_ms).toBe(100);
    expect(row?.mean_ms).toBe(55);
    expect(row?.min_ms).toBe(10);
    expect(row?.max_ms).toBe(100);
    expect(row?.samples).toBe(10);
  });

  test("the artifact publishes its provenance and its own limits", () => {
    const { report } = buildSloReport(emptySource);
    expect(report.kind).toBe("measured");
    expect(report.disclaimer).toContain("NOT MEASURED");
    expect(report.persistence.kind).toBe("file");
    expect(report.persistence.note).toContain("per-instance");
    expect(report.industry_baseline.ms).toBe(2_280_000);
    expect(report.intervention_definition.terminal_span).toBe(TERMINAL_SPAN);
    expect(report.generated_by).toBe("scripts/emit-slo.ts");
    // No number in the artifact may be a stand-in for a missing measurement.
    expect(JSON.stringify(report)).not.toContain('"p95_ms":0');
  });
});

/* ═══════════════════════ the panel renders honestly ══════════════════════ */

describe("SloPanel", () => {
  // Rendered with react-dom/server rather than a DOM: the interesting behaviour
  // is what the markup DOES NOT contain, and that is easier to assert on a
  // string than through a testing library the repo does not have.
  const render = (props: Parameters<typeof SloChart>[0]) => renderToStaticMarkup(createElement(SloChart, props));
  const baselinePct = logAxisPosition(INDUSTRY_BASELINE.ms);

  test("with no data it names the budget and draws no bar at all", () => {
    const html = render({ spans: summariseWindow([]), baselinePct, hasData: false, snapshot: null });
    // One "not measured" per row, plus one per aria-label.
    expect(html.split("not measured").length - 1).toBeGreaterThanOrEqual(8);
    expect(html).toContain("No spans recorded in this window");
    expect(html).toContain("budget</span>"); // the banner says every row is a budget
    // The failure this guards: an empty measurement drawn as an instant one.
    expect(html).not.toMatch(/width:\s*0%/);
    expect(html).not.toMatch(/>\s*0 ms/); // no rendered p50/p95 pair
    expect(html).toContain("— / —"); // the value slot says "nothing", not "0"
    // The reference line is still drawn, because the baseline is a fact about
    // the industry whether or not we have measured anything.
    expect(html).toContain("border-dashed");
    expect(baselinePct).toBeGreaterThan(90);
  });

  test("with data it shows p50 and p95 and the verdict", () => {
    const html = render({ spans: summariseWindow(completeIntervention("SV-F-PANEL")), baselinePct, hasData: true, snapshot: null });
    expect(html).not.toContain("not measured");
    expect(html).toContain("met"); // verdict pills
    // 10% of the 300 ms budget → p50/p95 both 30 ms on the intake row.
    expect(html).toContain("30 ms");
    // n=1 per span is below the p95 sample floor, and the row says so.
    expect(html).toContain("n=1");
  });

  test("the rendered p95 positions agree with the axis maths", () => {
    const html = render({ spans: summariseWindow(completeIntervention("SV-F-POS")), baselinePct, hasData: true, snapshot: null });
    // Every drawn bar width must be the axis position of a real measurement.
    for (const row of summariseWindow(completeIntervention("SV-F-POS2"))) {
      const pct = logAxisPosition(row.p95Ms);
      expect(pct).not.toBeNull();
      expect(html).toContain(`width:${pct}%`);
    }
  });
});

/* ═══════════════════════ the real script, over a real file ════════════════ */

describe("scripts/emit-slo.ts (end to end)", () => {
  async function runEmitter(logPath: string, outPath: string, extra: string[] = []) {
    const proc = Bun.spawn(["bun", "--preload", join(ROOT, "tests", "preload.ts"), EMITTER, ...extra], {
      cwd: ROOT,
      env: { ...process.env, TELEMETRY_SPAN_LOG: logPath, SLO_EVIDENCE_PATH: outPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr, json: JSON.parse(await readFile(outPath, "utf8")) as Record<string, unknown> };
  }

  test("with no spans it exits NON-ZERO and writes the real count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sv-emit-"));
    const logPath = join(dir, "spans.jsonl");
    const outPath = join(dir, "slo.json");
    await writeFile(logPath, "", "utf8"); // an empty, existing log

    const run = await runEmitter(logPath, outPath);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("FAIL");
    expect(run.stderr).toContain(String(REQUIRED_INTERVENTIONS));
    expect(run.json.meets_30_intervention_threshold).toBe(false);
    expect(run.json.interventions_measured).toBe(0);
    expect(run.json.kind).toBe("measured");

    rmSync(dir, { recursive: true, force: true });
  });

  test("with fewer than 30 real interventions it exits NON-ZERO and says how many", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sv-emit-"));
    const logPath = join(dir, "spans.jsonl");
    const outPath = join(dir, "slo.json");

    // Seven complete interventions recorded through the REAL recorder and the
    // REAL store — the same call a request path makes, not a hand-written file.
    tmp = dir;
    process.env.TELEMETRY_SPAN_LOG = logPath;
    for (let i = 0; i < 7; i++) persistIntervention(`SV-F-REAL${i}`);
    await flushSpansNow();
    expect(storeDiagnostics().persistErrors).toBe(0);

    const run = await runEmitter(logPath, outPath);
    expect(run.code).not.toBe(0);
    expect(run.json.interventions_measured).toBe(7);
    expect(run.json.meets_30_intervention_threshold).toBe(false);
    expect(run.stdout).toContain("7 complete");

    rmSync(dir, { recursive: true, force: true });
  });

  test("with 30 real interventions recorded end to end it exits 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sv-emit-"));
    const logPath = join(dir, "spans.jsonl");
    const outPath = join(dir, "slo.json");

    tmp = dir;
    process.env.TELEMETRY_SPAN_LOG = logPath;
    for (let i = 0; i < 30; i++) persistIntervention(`SV-F-PASS${i}`);
    await flushSpansNow();

    const written = await readSpanRecords();
    expect(written.records).toHaveLength(30 * SPAN_DEFINITIONS.length);

    const run = await runEmitter(logPath, outPath);
    expect(run.stderr).not.toContain("FAIL");
    expect(run.code).toBe(0);
    expect(run.json.interventions_measured).toBe(30);
    expect(run.json.meets_30_intervention_threshold).toBe(true);
    expect(run.json.all_targets_met).toBe(true);
    expect(run.stdout).toContain("PASS");

    rmSync(dir, { recursive: true, force: true });
  });

  test("an emitted artifact is a function of the log alone — no seeded constants", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sv-emit-"));
    const logPath = join(dir, "spans.jsonl");
    const first = join(dir, "a.json");
    const second = join(dir, "b.json");

    tmp = dir;
    process.env.TELEMETRY_SPAN_LOG = logPath;
    for (let i = 0; i < 30; i++) persistIntervention(`SV-F-DET${i}`, 0.1);
    await flushSpansNow();

    await runEmitter(logPath, first);
    await runEmitter(logPath, second);

    const a = await readFile(first, "utf8");
    const b = await readFile(second, "utf8");
    // Same log → same numbers. Only the generation timestamp may differ.
    const strip = (s: string) => s.replace(/"generated_at": "[^"]+"/, '"generated_at": "-"');
    expect(strip(a)).toBe(strip(b));

    rmSync(dir, { recursive: true, force: true });
  });

  test("the committed evidence artifact may not claim the threshold it did not reach", async () => {
    // Whatever schema the committed artifact uses, an under-count must not be
    // published as a pass. This is the regression the previous revision failed.
    const committed = JSON.parse(await readFile(join(ROOT, "evidence", "latency", "slo.json"), "utf8")) as {
      interventions_measured?: number;
      meets_30_intervention_threshold?: boolean;
    };
    const measured = committed.interventions_measured ?? 0;
    if (measured < REQUIRED_INTERVENTIONS) {
      expect(committed.meets_30_intervention_threshold ?? false).toBe(false);
    }
    // And the generator agrees with the committed artifact about being short.
    const dir = await mkdtemp(join(tmpdir(), "sv-emit-"));
    const fresh = await runEmitter(join(dir, "does-not-exist.jsonl"), join(dir, "slo.json"));
    expect(fresh.code).not.toBe(0);
    expect(fresh.json.meets_30_intervention_threshold).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
