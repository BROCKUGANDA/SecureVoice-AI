/**
 * UNIT — the pure telemetry computation layer (no database).
 *
 * Scope: `src/lib/telemetry/slo.ts` (percentiles, verdicts, window summaries,
 * chart geometry), `src/lib/telemetry/report.ts` (`buildSloReport`, which is
 * pure with respect to the filesystem — the caller supplies the records), and
 * `src/lib/clock.ts` (the injected-time seam).
 *
 * This is deliberately NOT `tests/telemetry/telemetry.test.ts`. That file owns
 * the recorder, the durable JSONL store, the panel render and the emitter
 * script over a real file. This file owns the ARITHMETIC: given the same
 * numbers in, the published verdict must come out, and every boundary between
 * "measured" and "not measured" must land on the documented side.
 *
 * ## What is asserted, and why these properties matter
 *
 * The artifact this code produces is a bank-facing evidence claim, so the
 * properties worth defending are all of the form "this must not lie, in this
 * direction":
 *
 *   · A p95 is never below its budget by accident. `met` means p95 <= target
 *     EXACTLY, with the headroom published, so a reviewer can recompute it.
 *   · `no_data` is not a pass. An unmeasured window must never be summarised as
 *     a healthy one, which is why `Distribution` has no `0 ms` anywhere and
 *     `allTargetsMet` returns `null` rather than `true` when a span is unmeasured.
 *   · Window membership is INCLUSIVE at the lower bound and EXCLUSIVE in
 *     effect one millisecond earlier. A sample exactly on the edge is counted;
 *     an off-by-one here silently drops or invents an intervention.
 *   · The same underlying data answers differently for a 1-hour window than
 *     for a 7-day window, and the direction of that difference is fixed: a
 *     short window sees the burn, a long window amortises it. If this ever
 *     inverts, the panel starts hiding a live incident behind a week of history.
 *   · No `NaN`/`Infinity` reaches a published field, and no axis coordinate
 *     escapes [0, 100] — a NaN width renders as an unstyled DOM node, and an
 *     over-100 coordinate overflows the chart track.
 *
 * ## KNOWN GAP — the brief's "burn rate" and "error budget" do not exist here
 *
 * The assignment asks for error-rate burn-rate and error-budget maths (an SLO
 * expressed as a fraction of failed requests over a window). No such function
 * exists anywhere in `src/lib/telemetry/`, and no `errorRate`/`burnRate`/
 * `errorBudget` symbol is exported or referenced. The SLO in this codebase is a
 * LATENCY objective: eight spans, each with a fixed p95 budget in milliseconds,
 * and the "budget" is time. The nearest real analogues, which are what the tests
 * below actually assert:
 *
 *   · burn rate           -> the overrun ratio p95 / target, published by
 *                             `worstSpan` and by `report.worst.ratio`.
 *   · budget consumption  -> `outlierSamples` (samples beyond
 *                             OUTLIER_FACTOR x budget) and the ratio of
 *                             over-budget samples to window size.
 *   · "100% with zero errors meets the objective" -> p95 exactly equal to the
 *                             target is `met` with `headroomMs: 0`; one
 *                             millisecond over is `missed`.
 *
 * If an error-rate SLO is ever added, the window/boundary/division-guard tests
 * below are the template it should be measured against.
 *
 * ## Deliberately excluded
 *
 * `loadSloSource`, `emitSloReport` and `latencyBlock` in report.ts, and
 * `readSpanRecords`/`flushSpansNow` in store.ts: all of them read the on-disk
 * span log through the file-backed store. That path is exercised end to end in
 * `tests/telemetry/telemetry.test.ts` and is out of scope here. No function in
 * these three modules needs a database connection, so nothing was skipped for
 * that reason.
 */
import { describe, expect, test } from "bun:test";

import { fixedClock, systemClock, toInstant, FIXED_CLOCK_ID, SYSTEM_CLOCK_ID } from "@/lib/clock";
import {
  AXIS_MAX_MS,
  OUTLIER_FACTOR,
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
  type SpanWindowSummary,
} from "@/lib/telemetry/slo";
import {
  REQUIRED_INTERVENTIONS,
  buildSloReport,
  type SloReportResult,
} from "@/lib/telemetry/report";
import {
  INDUSTRY_BASELINE,
  SPAN_RECORD_VERSION,
  SPAN_DEFINITIONS,
  SPAN_NAMES,
  TERMINAL_SPAN,
  type SpanName,
  type SpanRecord,
} from "@/lib/telemetry/spans";

/** 2026-10-02T12:00:00.000Z. An arbitrary fixed anchor — never the wall clock. */
const BASE = Date.UTC(2026, 9, 2, 12, 0, 0);
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * Build a record directly rather than through `recordSpan`, so this suite
 * never mutates the process-wide span ring and therefore cannot be perturbed
 * by (or perturb) the recorder tests running beside it.
 */
function span(
  name: SpanName,
  startedAtMs: number,
  durationMs: number,
  interventionId: string,
): SpanRecord {
  // A corrupt duration (NaN, negative) is a case some tests deliberately
  // build, so the derived end instant must survive it rather than throw.
  const endedAtMs = startedAtMs + durationMs;
  return {
    v: SPAN_RECORD_VERSION,
    span: name,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    endedAt: new Date(Number.isFinite(endedAtMs) ? endedAtMs : startedAtMs).toISOString(),
    endedAtMs: Number.isFinite(endedAtMs) ? endedAtMs : startedAtMs,
    durationMs,
    traceId: "0".repeat(32),
    spanId: "0".repeat(16),
    interventionId,
    conversationId: null,
    caseRef: null,
    attributes: {},
  };
}

/** The summary row for one span of a `summariseWindow` result. */
function rowOf(rows: readonly SpanWindowSummary[], name: SpanName): SpanWindowSummary {
  const row = rows.find((r) => r.span === name);
  if (row === undefined) throw new Error(`summariseWindow did not return a row for ${name}`);
  return row;
}

/** A `SpanReadSource` for `buildSloReport` that reads nothing from disk. */
function source(records: readonly SpanRecord[]): {
  records: readonly SpanRecord[];
  recordsRead: number;
  malformedLines: number;
  truncated: boolean;
  bytesRead: number;
  missing: boolean;
  error: string | null;
} {
  return {
    records,
    recordsRead: records.length,
    malformedLines: 0,
    truncated: false,
    bytesRead: 0,
    missing: false,
    error: null,
  };
}

/**
 * N complete interventions: every span measured at `fill` x its own budget.
 * The terminal span is what `completeInterventionIds` requires.
 */
function interventions(count: number, fill = 0.1, idPrefix = "SV-F-UNIT"): SpanRecord[] {
  const out: SpanRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `${idPrefix}${String(i).padStart(4, "0")}`;
    for (const def of SPAN_DEFINITIONS) {
      out.push(span(def.name, BASE, Math.round(def.targetP95Ms * fill), id));
    }
  }
  return out;
}

/* ═══════════════════════════ percentile arithmetic ═══════════════════════════ */

describe("percentiles — nearest rank, recomputed by hand", () => {
  // Over 1..20 the rank is ceil(p/100 x 20), 1-based:
  //   p50 -> 10 -> value 10      p95 -> ceil(19.0) = 19 -> value 19
  //   p99 -> ceil(19.8) = 20    -> value 20
  // p0 has no rank, so the clamp to [1, n] makes it the minimum, NOT null and
  // NOT an out-of-bounds read.
  test("rank is ceil(p/100 x n), 1-based, so p0 is the minimum sample", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile(values, 99)).toBe(20);
    expect(percentile(values, 100)).toBe(20);
  });

  test("an empty window is null at every percentile, never 0", () => {
    for (const p of [0, 50, 95, 99, 100]) expect(percentile([], p)).toBeNull();
    const empty = summarise([]);
    expect(empty.samples).toBe(0);
    expect([empty.minMs, empty.p50Ms, empty.p95Ms, empty.p99Ms, empty.maxMs, empty.meanMs]).toEqual(
      [null, null, null, null, null, null],
    );
  });

  test("the mean is the arithmetic mean and non-finite samples are counted, not averaged", () => {
    // 1..100 sums to 5050 over 100 samples = 50.5 — a mean rounded to an
    // integer would report 51 and quietly misstate every published average.
    const dist = summarise([...Array.from({ length: 100 }, (_, i) => i + 1), Number.NaN, Infinity]);
    expect(dist.samples).toBe(100);
    expect(dist.rejected).toBe(2);
    expect(dist.meanMs).toBe(50.5);
    expect(dist.minMs).toBe(1);
    expect(dist.maxMs).toBe(100);
    expect(dist.p50Ms).toBe(50);
    expect(dist.p95Ms).toBe(95);
    expect(dist.p99Ms).toBe(99);
  });

  test("a p outside 0..100 throws — a caller bug must not be answered with a number", () => {
    expect(() => percentile([1, 2], -0.1)).toThrow(RangeError);
    expect(() => percentile([1, 2], 100.1)).toThrow(RangeError);
    expect(() => percentile([1, 2], Number.NaN)).toThrow(RangeError);
  });
});

/* ═══════════════════════ the verdict: met / missed / no_data ══════════════════ */

describe("the latency objective — p95 against its own budget", () => {
  // The objective is "<= target", closed at the boundary. This matters because
  // the panel draws headroom as a bar: a p95 exactly at target must draw an
  // empty bar and a pass, not a zero-width miss.
  test("p95 exactly at the budget METS with zero headroom; one ms over MISSES", () => {
    const table: ReadonlyArray<{ span: SpanName; target: number }> = [
      { span: "signal_received_to_accepted", target: 300 },
      { span: "signal_received_to_ringing", target: 5_000 },
      { span: "signal_received_to_freeze_staged", target: 60_000 },
    ];
    for (const { span: name, target } of table) {
      const exact = meetsTarget(name, target);
      expect(exact.status).toBe("met");
      expect(exact.targetP95Ms).toBe(target);
      if (exact.status === "met") expect(exact.headroomMs).toBe(0);

      const over = meetsTarget(name, target + 1);
      expect(over.status).toBe("missed");
      if (over.status === "missed") expect(over.overrunMs).toBe(1);
    }
  });

  test("headroom and overrun are both non-negative and complementary", () => {
    // target 300: p95 220 leaves 80; p95 355 overruns by 55. Neither field
    // may ever be negative — the panel renders them as signed millisecond
    // labels, and a negative headroom would display as "-80 ms headroom".
    const under = meetsTarget("signal_received_to_accepted", 220);
    const over = meetsTarget("signal_received_to_accepted", 355);
    if (under.status !== "met" || over.status !== "missed") throw new Error("verdict regression");
    expect(under.headroomMs).toBe(80);
    expect(over.overrunMs).toBe(55);
    expect(under.headroomMs + over.overrunMs).toBeLessThan(300);
  });

  test("an unmeasured or unreadable p95 is no_data with a reason, never a pass", () => {
    const absent = meetsTarget("tool_request_to_response", null);
    expect(absent.status).toBe("no_data");
    if (absent.status === "no_data") expect(absent.reason).toBe("no_spans_recorded");
    // NaN reaches this function from a corrupted log line. It must land in
    // the "not a number" bucket rather than comparing false and passing.
    const nan = meetsTarget("tool_request_to_response", Number.NaN);
    expect(nan.status).toBe("no_data");
    if (nan.status === "no_data") expect(nan.reason).toBe("p95_not_a_number");
    expect(meetsTarget("tool_request_to_response", undefined).status).toBe("no_data");
    // The budget is still published on a no_data row so the panel can say
    // "— (budget 300 ms)" without a second lookup table.
    expect(nan.targetP95Ms).toBe(300);
  });
});

/* ═══════════════════════ window membership and budget burn ══════════════════ */

describe("window selection — the lower bound is inclusive", () => {
  // Concrete pair, 60 000 ms apart: one sample exactly ON `sinceMs`, one
  // millisecond before it. The one on the edge must be counted.
  test("a sample started exactly at sinceMs is in; one ms earlier is out", () => {
    const edge = BASE + HOUR_MS;
    const records = [
      span(TERMINAL_SPAN, edge, 10, "SV-F-EDGE"),
      span(TERMINAL_SPAN, edge - 1, 99_000, "SV-F-BEFORE"),
    ];
    const rows = summariseWindow(records, { sinceMs: edge, nowMs: edge });
    const freeze = rowOf(rows, TERMINAL_SPAN);
    expect(freeze.samples).toBe(1);
    expect(freeze.p95Ms).toBe(10);
    // Widening the window by exactly one millisecond admits the slow sample.
    const wider = rowOf(
      summariseWindow(records, { sinceMs: edge - 1, nowMs: edge }),
      TERMINAL_SPAN,
    );
    expect(wider.samples).toBe(2);
    expect(wider.p95Ms).toBe(99_000);
    expect(wider.verdict.status).toBe("missed");
  });

  test("ageMs is measured from the NEWEST sample and clamps at zero for future data", () => {
    const now = BASE + HOUR_MS;
    const rows = summariseWindow([span(TERMINAL_SPAN, now - 5_000, 10, "SV-F-AGE")], {
      nowMs: now,
    });
    expect(rowOf(rows, TERMINAL_SPAN).ageMs).toBe(5_000);
    // A record stamped in the future (clock skew between two hosts) must not
    // publish a negative age — an operator panel rendering "-3000 ms old"
    // would be reporting a measurement the platform cannot have made.
    const future = summariseWindow([span(TERMINAL_SPAN, now + 3_000, 10, "SV-F-FUTURE")], {
      nowMs: now,
    });
    expect(rowOf(future, TERMINAL_SPAN).ageMs).toBe(0);
    // No samples at all is null, not zero age.
    expect(rowOf(summariseWindow([], { nowMs: now }), TERMINAL_SPAN).ageMs).toBeNull();
  });

  test("asking for one span returns one row; asking for all returns all eight", () => {
    const records = [span("tool_request_to_response", BASE, 10, "SV-F-ONE")];
    const one = summariseWindow(records, { span: "tool_request_to_response", nowMs: BASE });
    expect(one).toHaveLength(1);
    expect(one[0]?.span).toBe("tool_request_to_response");
    const all = summariseWindow(records, { nowMs: BASE });
    expect(all.map((r) => r.span)).toEqual([...SPAN_NAMES]);
  });
});

describe("budget consumption scales with the window, not just the error ratio", () => {
  // One dataset, two windows, hand-derived.
  //
  //   950 samples of 100 ms  — healthy, all older than an hour
  //    50 samples of 5 000 ms — the burn, all inside the last hour
  //   tool_request_to_response: budget 300 ms, outlier threshold 300*4 = 1200
  //
  // 1-hour window (nowMs = BASE, sinceMs = BASE - 3 600 000): only the 50
  // slow samples survive. p95 = 5000 > 300 -> missed, overrun 4700 ms.
  //
  // 7-day window (sinceMs = BASE - 604 800 000): all 1000 survive. Sorted, the
  // 950 healthy values occupy ranks 1..950, and rank = ceil(0.95 x 1000) =
  // 950 lands on the LAST healthy value, 100 ms. 100 <= 300 -> met, headroom
  // 200 ms. Same data, opposite verdict: the short window shows the burn, the
  // long window amortises it. That asymmetry is the whole reason both windows
  // are published.
  const HEALTHY_MS = 100;
  const SLOW_MS = 5_000;
  const BUDGET_MS = 300;
  const healthy = Array.from({ length: 950 }, (_, i) =>
    span("tool_request_to_response", BASE - HOUR_MS - (i + 1) * 1_000, HEALTHY_MS, `SV-F-H${i}`),
  );
  const burning = Array.from({ length: 50 }, (_, i) =>
    span("tool_request_to_response", BASE - i * 1_000, SLOW_MS, `SV-F-B${i}`),
  );
  const CORPUS = [...healthy, ...burning];

  test("one hour sees the burn; seven days amortises the same data away", () => {
    // Pin the corpus itself: 1 000 records whose healthy half sits entirely
    // outside the short window and whose burning half sits entirely inside it.
    // Without this the window arithmetic below could pass on an empty corpus.
    expect(CORPUS).toHaveLength(1_000);
    expect(CORPUS.filter((r) => r.startedAtMs >= BASE - HOUR_MS)).toHaveLength(50);
    const hour = rowOf(
      summariseWindow(CORPUS, { sinceMs: BASE - HOUR_MS, nowMs: BASE }),
      "tool_request_to_response",
    );
    expect(hour.samples).toBe(50);
    expect(hour.p95Ms).toBe(SLOW_MS);
    expect(hour.verdict.status).toBe("missed");
    if (hour.verdict.status === "missed") expect(hour.verdict.overrunMs).toBe(SLOW_MS - BUDGET_MS);
    expect(hour.targetP95Ms).toBe(BUDGET_MS);
    // 50 of 50 samples in the short window are past budget.
    expect(hour.outlierSamples).toBe(50);

    const week = rowOf(
      summariseWindow(CORPUS, { sinceMs: BASE - 7 * 24 * HOUR_MS, nowMs: BASE }),
      "tool_request_to_response",
    );
    expect(week.samples).toBe(1_000);
    expect(week.p95Ms).toBe(HEALTHY_MS);
    expect(week.verdict.status).toBe("met");
    if (week.verdict.status === "met") expect(week.verdict.headroomMs).toBe(BUDGET_MS - HEALTHY_MS);
    // The burn is still VISIBLE in the long window — it is not averaged
    // away, it is counted: 50 of 1000 samples, i.e. 5%.
    expect(week.outlierSamples).toBe(50);
    expect(week.outlierSamples / week.samples).toBe(0.05);
    expect(week.outlierSamples / hour.samples).toBe(1);
  });

  test("an outlier is strictly beyond 4x the budget — exactly 4x is not one", () => {
    expect(OUTLIER_FACTOR).toBe(4);
    const atThreshold = summariseWindow(
      [span("tool_request_to_response", BASE, BUDGET_MS * OUTLIER_FACTOR, "SV-F-AT")],
      { nowMs: BASE },
    );
    expect(rowOf(atThreshold, "tool_request_to_response").outlierSamples).toBe(0);
    const past = summariseWindow(
      [span("tool_request_to_response", BASE, BUDGET_MS * OUTLIER_FACTOR + 1, "SV-F-PAST")],
      { nowMs: BASE },
    );
    expect(rowOf(past, "tool_request_to_response").outlierSamples).toBe(1);
  });
});

describe("the trust floor — a p95 is reported before it is believed", () => {
  test("29 samples report a p95 but do not meet the floor; 30 do", () => {
    const mk = (n: number): SpanRecord[] =>
      Array.from({ length: n }, (_, i) => span(TERMINAL_SPAN, BASE, 1_000, `SV-F-N${i}`));
    expect(P95_SAMPLE_FLOOR).toBe(30);
    const short = rowOf(summariseWindow(mk(29), { nowMs: BASE }), TERMINAL_SPAN);
    expect(short.samples).toBe(29);
    expect(short.p95Ms).toBe(1_000);
    expect(short.meetsSampleFloor).toBe(false);
    const enough = rowOf(summariseWindow(mk(30), { nowMs: BASE }), TERMINAL_SPAN);
    expect(enough.meetsSampleFloor).toBe(true);
    expect(enough.p95Ms).toBe(short.p95Ms);
  });

  test("the trust floor is a per-span property, not a global sample count", () => {
    // 30 samples concentrated on one span cannot lend their count to a span
    // that was never measured — otherwise an unmeasured span inherits a
    // trustworthy p95 from its neighbour.
    const records = Array.from({ length: 30 }, (_, i) =>
      span("tool_request_to_response", BASE, 10, `SV-F-C${i}`),
    );
    const rows = summariseWindow(records, { nowMs: BASE });
    expect(rowOf(rows, "tool_request_to_response").meetsSampleFloor).toBe(true);
    expect(rowOf(rows, "signal_received_to_freeze_staged").meetsSampleFloor).toBe(false);
    expect(rowOf(rows, "signal_received_to_freeze_staged").p95Ms).toBeNull();
  });
});

/* ═══════════════════ zero traffic, 100% failure, division guards ════════════ */

describe("boundary and division guards", () => {
  test("zero requests in the window yields eight no_data rows and a null claim", () => {
    const rows = summariseWindow([], { nowMs: BASE });
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.samples).toBe(0);
      expect(row.p95Ms).toBeNull();
      expect(row.verdict.status).toBe("no_data");
      expect(row.ageMs).toBeNull();
      expect(row.meanMs).toBeNull();
      expect(row.outlierSamples).toBe(0);
    }
    // "All targets met" is UNKNOWN, not true: eight spans, none measured.
    expect(allTargetsMet(rows)).toBeNull();
    expect(worstSpan(rows)).toBeNull();
    expect(allTargetsMet([])).toBeNull();
  });

  test("100% failure is a uniform miss at exactly the overrun ratio", () => {
    // Every sample 3x its own budget: the ratio is 3 for every span, so the
    // worst span is whichever comes first in definition order — which
    // pins that the ranking is by ratio and stable, not by absolute ms.
    const records = interventions(4, 3, "SV-F-FAIL");
    const rows = summariseWindow(records, { nowMs: BASE });
    for (const row of rows) {
      expect(row.verdict.status).toBe("missed");
      expect(row.p95Ms).toBe(row.targetP95Ms * 3);
      if (row.verdict.status === "missed") expect(row.verdict.overrunMs).toBe(row.targetP95Ms * 2);
    }
    expect(allTargetsMet(rows)).toBe(false);
    const worst = worstSpan(rows);
    expect(worst?.span).toBe(SPAN_NAMES[0]);
    expect(worst?.p95Ms).toBe((worst?.targetP95Ms ?? 0) * 3);
  });

  test("worstSpan ranks by ratio, so the slowest span in ms is not the worst", () => {
    // freeze: 90 000 ms over a 60 000 ms budget -> ratio 1.5 (still a miss)
    // tool:    1 200 ms over a    300 ms budget -> ratio 4   (worse)
    const rows = summariseWindow(
      [
        span(TERMINAL_SPAN, BASE, 90_000, "SV-F-W1"),
        span("tool_request_to_response", BASE, 1_200, "SV-F-W2"),
      ],
      { nowMs: BASE },
    );
    const worst = worstSpan(rows);
    expect(worst?.span).toBe("tool_request_to_response");
    expect((worst?.p95Ms ?? 0) / (worst?.targetP95Ms ?? 1)).toBe(4);
    // A measured span always outranks an unmeasured one, which has no ratio.
    const withGaps = summariseWindow(
      [...[span(TERMINAL_SPAN, BASE, 90_000, "SV-F-G1")], ...interventions(1, 0.1, "SV-F-G2")],
      { nowMs: BASE },
    );
    expect(worstSpan(withGaps)?.span).toBe(TERMINAL_SPAN);
  });

  test("no Infinity or NaN escapes a division guard", () => {
    // fasterThanBaselineBy divides baseline / p95: p95 of 0 is the only way
    // that produces Infinity, so 0 (and negatives, and a bad baseline) must
    // be refused rather than published as "infinitely faster than industry".
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fasterThanBaselineBy(bad, INDUSTRY_BASELINE.ms)).toBeNull();
    }
    expect(fasterThanBaselineBy(null, INDUSTRY_BASELINE.ms)).toBeNull();
    for (const badBaseline of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fasterThanBaselineBy(100, badBaseline)).toBeNull();
    }
    // The real figure: 2 280 000 / 60 000 = 38 exactly.
    expect(fasterThanBaselineBy(60_000, INDUSTRY_BASELINE.ms)).toBe(38);
  });

  test("log-axis coordinates stay inside 0..100 and refuse undrawable values", () => {
    expect(logAxisPosition(AXIS_MAX_MS)).toBe(100);
    expect(logAxisPosition(1)).toBe(0);
    // Out of range in both directions is clamped, not dropped: a measurement
    // still exists, it just has nowhere else to sit on this axis.
    expect(logAxisPosition(AXIS_MAX_MS * 1_000)).toBe(100);
    expect(logAxisPosition(0.5)).toBe(0);
    // Undrawable: zero would render a full-width "perfectly fast" bar.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(logAxisPosition(bad)).toBeNull();
    }
    // log10(1000) = 3 over a log span of log10(4e6) - log10(1) = 6.602…
    expect(logAxisPosition(1_000)).toBeCloseTo((3 / Math.log10(4_000_000)) * 100, 6);
    expect(logAxisPosition(100)).toBeCloseTo((2 / Math.log10(4_000_000)) * 100, 6);
    const everyTickIsBounded = [1, 10, 100, 1_000, 10_000, 60_000, 600_000].map(
      (ms) => logAxisPosition(ms) ?? Number.NaN,
    );
    expect(everyTickIsBounded.every((p) => Number.isFinite(p) && p >= 0 && p <= 100)).toBe(true);
  });
});

/* ═════════════════════ intervention counting semantics ══════════════════════ */

describe("an intervention counts only when it reached a freeze", () => {
  test("a terminal span with a finite, non-negative duration makes it complete", () => {
    const records = [
      span("signal_received_to_accepted", BASE, 10, "SV-F-C1"),
      span(TERMINAL_SPAN, BASE, 0, "SV-F-C1"),
      span(TERMINAL_SPAN, BASE, 10, "SV-F-C2"),
      span(TERMINAL_SPAN, BASE, -5, "SV-F-C3"),
      span(TERMINAL_SPAN, BASE, Number.NaN, "SV-F-C4"),
    ];
    // Seen: FOUR distinct ids from five records — SV-F-C1 appears twice
    // (once as an intake span, once as its freeze), and C3/C4 count as seen
    // even though neither completed. Counting records instead of ids would
    // report five interventions and inflate the gate by 25%.
    expect(records).toHaveLength(5);
    expect(countInterventions(records)).toBe(4);
    // Complete: the zero-duration freeze counts; a negative or NaN duration
    // is a corrupt record and must not be laundered into a pass.
    expect(completeInterventionIds(records).sort()).toEqual(["SV-F-C1", "SV-F-C2"]);
  });

  test("duplicates across an intervention's eight spans collapse to one id", () => {
    const records = interventions(3, 0.1, "SV-F-DUP");
    expect(records).toHaveLength(24);
    expect(countInterventions(records)).toBe(3);
    expect(completeInterventionIds(records)).toHaveLength(3);
  });
});

/* ═══════════════════════ buildSloReport — the evidence gate ═════════════════ */

describe("buildSloReport", () => {
  const clean = source(interventions(REQUIRED_INTERVENTIONS));

  test("a passing run publishes no reasons and exit code 0", () => {
    const { report, ok, exitCode, reasons } = buildSloReport(clean, { nowMs: BASE });
    expect(REQUIRED_INTERVENTIONS).toBe(30);
    expect(report.interventions_seen).toBe(30);
    expect(report.interventions_measured).toBe(30);
    expect(report.meets_30_intervention_threshold).toBe(true);
    expect(reasons).toEqual([]);
    expect(exitCode).toBe(0);
    expect(ok).toBe(true);
    expect(report.spans).toHaveLength(8);
    expect(report.spans_not_measured).toEqual([]);
    expect(report.all_targets_met).toBe(true);
    expect(report.gate.all_measured_targets_met).toBe(true);
    // No fabricated zero anywhere in the artifact.
    expect(JSON.stringify(report)).not.toContain('"p95_ms":0');
  });

  test("generated_at comes from the injected nowMs, not the wall clock", () => {
    // The clock seam: the artifact's timestamp is a function of its input,
    // so a re-run of the gate over the same records is byte-reproducible.
    const at = buildSloReport(clean, { nowMs: BASE });
    expect(at.report.generated_at).toBe("2026-10-02T12:00:00.000Z");
    const later = buildSloReport(clean, { nowMs: BASE + HOUR_MS });
    expect(later.report.generated_at).toBe("2026-10-02T13:00:00.000Z");
    // Everything except the timestamp is identical between the two runs.
    expect({ ...later.report, generated_at: "" }).toEqual({ ...at.report, generated_at: "" });
  });

  test("a missing log and an unreadable log are different, named failures", () => {
    const missing = buildSloReport({ ...source([]), missing: true }, { nowMs: BASE });
    expect(missing.exitCode).toBe(1);
    expect(missing.reasons.join(" ")).toContain("nothing has ever been recorded");

    const unreadable = buildSloReport(
      { ...source([]), missing: false, error: "EACCES: permission denied" },
      { nowMs: BASE },
    );
    expect(unreadable.report.source.log_missing).toBe(false);
    expect(unreadable.report.source.read_error).toBe("EACCES: permission denied");
    expect(unreadable.reasons.join(" ")).toContain("unreadable");
    // Both still publish the honest empty rows rather than omitting them.
    expect(unreadable.report.spans).toHaveLength(8);
    expect(unreadable.report.spans.every((r) => r.value_kind === "not_measured")).toBe(true);
  });

  test("an empty but present log is reported as zero spans, distinct from a missing log", () => {
    const empty = buildSloReport(source([]), { nowMs: BASE });
    expect(empty.report.source.log_missing).toBe(false);
    expect(empty.reasons.join(" ")).toContain("Zero spans in the window");
    expect(empty.exitCode).toBe(1);
    expect(empty.report.worst).toBeNull();
  });

  test("windowMinutes moves the lower bound and is echoed into the artifact", () => {
    const old = span("tool_request_to_response", BASE - 2 * HOUR_MS, 10, "SV-F-OLD");
    const recent = span("tool_request_to_response", BASE - 2 * MINUTE_MS, 10, "SV-F-NEW");
    const both = source([old, recent]);

    const week = buildSloReport(both, { windowMinutes: 7 * 24 * 60, nowMs: BASE });
    expect(week.report.source.window_minutes).toBe(10_080);
    expect(week.report.spans.find((r) => r.name === "tool_request_to_response")?.samples).toBe(2);

    const hour = buildSloReport(both, { windowMinutes: 60, nowMs: BASE });
    expect(hour.report.spans.find((r) => r.name === "tool_request_to_response")?.samples).toBe(1);

    // windowMinutes: null means "all time", and says so in the artifact.
    const all = buildSloReport(both, { windowMinutes: null, nowMs: BASE });
    expect(all.report.source.window_minutes).toBeNull();
    expect(all.report.spans.find((r) => r.name === "tool_request_to_response")?.samples).toBe(2);
  });

  test("requiredInterventions is honoured, and a shortfall names the requirement", () => {
    const two = source(interventions(2, 0.1, "SV-F-REQ"));
    expect(buildSloReport(two, { requiredInterventions: 2, nowMs: BASE }).exitCode).toBe(0);
    const short: SloReportResult = buildSloReport(two, { requiredInterventions: 30, nowMs: BASE });
    expect(short.report.required_interventions).toBe(REQUIRED_INTERVENTIONS);
    expect(short.exitCode).toBe(1);
    expect(short.report.meets_30_intervention_threshold).toBe(false);
    expect(short.reasons.join(" ")).toContain("requires 30 real interventions");
  });

  test("a measured miss fails the gate and names the span with its numbers", () => {
    // 30 complete interventions whose TOOL span is 2x its budget while every
    // other span stays fast. Because all 30 tool samples are slow, the p95
    // itself moves; the gate must fail on that one row and name no other.
    const records = SPAN_DEFINITIONS.flatMap((d) =>
      Array.from({ length: 30 }, (_, i) =>
        span(
          d.name,
          BASE,
          Math.round(d.targetP95Ms * (d.name === "tool_request_to_response" ? 2 : 0.1)),
          `SV-F-MIX${i}`,
        ),
      ),
    );
    const { report, exitCode, reasons } = buildSloReport(source(records), { nowMs: BASE });
    expect(report.meets_30_intervention_threshold).toBe(true);
    expect(report.all_targets_met).toBe(false);
    expect(exitCode).toBe(1);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("600 ms exceeds its 300 ms budget");
  });

  test("a partially instrumented run claims all_targets_met = null but a measured-only gate verdict", () => {
    // Only the tool span has samples. The top-level field is null because
    // seven spans are unmeasured; the gate field is true because the one
    // measured span met its budget. Collapsing either into a boolean would
    // overstate the evidence in opposite directions.
    const records = Array.from({ length: 30 }, (_, i) =>
      span("tool_request_to_response", BASE, 100, `SV-F-P${i}`),
    );
    const { report, exitCode } = buildSloReport(source(records), { nowMs: BASE });
    expect(report.interventions_measured).toBe(0);
    expect(report.all_targets_met).toBeNull();
    expect(report.gate.all_measured_targets_met).toBe(true);
    expect(report.spans_not_measured).toHaveLength(7);
    expect(exitCode).toBe(1); // only because no intervention completed
  });

  test("the worst row publishes a ratio that recomputes to its own numbers", () => {
    const records = [
      ...Array.from({ length: 30 }, (_, i) =>
        span("tool_request_to_response", BASE, 1_200, `SV-F-R${i}`),
      ),
      ...Array.from({ length: 30 }, (_, i) => span(TERMINAL_SPAN, BASE, 30_000, `SV-F-R${i}`)),
    ];
    const { report } = buildSloReport(source(records), { nowMs: BASE });
    const worst = report.worst;
    if (worst === null) throw new Error("a measured window must publish a worst row");
    expect(worst.name).toBe("tool_request_to_response");
    expect(worst.p95_ms).toBe(1_200);
    expect(worst.target_p95_ms).toBe(300);
    expect(worst.ratio).toBe(4);
    expect(worst.ratio).toBe(worst.p95_ms / worst.target_p95_ms);
    // A miss publishes null headroom rather than a negative number.
    const tool = report.spans.find((r) => r.name === "tool_request_to_response");
    expect(tool?.verdict).toBe("missed");
    expect(tool?.headroom_ms).toBeNull();
    // The terminal span met its budget (30 000 of 60 000) and publishes the
    // headroom a reviewer can subtract for themselves.
    const terminal = report.spans.find((r) => r.name === TERMINAL_SPAN);
    expect(terminal?.headroom_ms).toBe(30_000);
  });

  test("provenance counters from the reader are carried through untouched", () => {
    const read = {
      ...source(interventions(30)),
      recordsRead: 41,
      malformedLines: 3,
      truncated: true,
      bytesRead: 8_388_608,
    };
    const { report } = buildSloReport(read, { nowMs: BASE });
    expect(report.source.records_read).toBe(41);
    expect(report.source.malformed_lines).toBe(3);
    expect(report.source.truncated).toBe(true);
    expect(report.source.bytes_read).toBe(8_388_608);
    expect(report.persistence.max_read_bytes).toBe(8 * 1024 * 1024);
  });

  test("outliers and the sample floor reach the row a reviewer reads", () => {
    const records = [
      ...Array.from({ length: 30 }, (_, i) =>
        span("tool_request_to_response", BASE, 100, `SV-F-F${i}`),
      ),
      span("tool_request_to_response", BASE, 5_000, "SV-F-FOUTLIER"),
    ];
    const { report } = buildSloReport(source(records), { nowMs: BASE });
    const tool = report.spans.find((r) => r.name === "tool_request_to_response");
    // n=31: nearest rank 95 -> ceil(29.45) = 30 -> still a healthy 100 ms.
    expect(tool?.samples).toBe(31);
    expect(tool?.p95_ms).toBe(100);
    expect(tool?.outlier_samples).toBe(1);
    expect(tool?.meets_sample_floor).toBe(true);
    expect(tool?.interventions).toBe(31);
    // The outlier is visible in the artifact even though the p95 hides it.
    expect(tool?.max_ms).toBe(5_000);
  });
});

/* ═════════════════════════ the clock seam (src/lib/clock.ts) ════════════════ */

describe("the clock seam", () => {
  // Why this file is load-bearing: every evidence artifact in the repo is a
  // promise that a reader can re-run the gate and get the same bytes. A
  // single implicit Date.now() inside a timestamped decision breaks that
  // promise silently — the artifact still looks right, it is just no longer
  // reproducible, and the reader cannot tell which fields moved.
  test("reading a fixed clock twice returns the same instant", () => {
    const clock = fixedClock(new Date(BASE));
    const first = clock.now();
    const second = clock.now();
    expect(first.getTime()).toBe(BASE);
    expect(second.getTime()).toBe(BASE);
    // A fresh Date per call: a caller that mutates the result must not move
    // time for everybody else, so the two objects are distinct instances.
    expect(first).not.toBe(second);
    first.setUTCFullYear(1999);
    expect(clock.now().getTime()).toBe(BASE);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  test("step and set move deterministically and return the new instant", () => {
    const clock = fixedClock(new Date(BASE));
    expect(clock.step(1_000).getTime()).toBe(BASE + 1_000);
    expect(clock.step(500).getTime()).toBe(BASE + 1_500);
    expect(clock.now().getTime()).toBe(BASE + 1_500);
    // Sub-millisecond deltas are truncated, not rounded: two clocks stepped
    // by 1.4 ms and 1.6 ms must agree to the same millisecond.
    const a = fixedClock(new Date(BASE));
    const b = fixedClock(new Date(BASE));
    a.step(1.4);
    b.step(1.6);
    expect(a.now().getTime()).toBe(BASE + 1);
    expect(b.now().getTime()).toBe(BASE + 1);
    // An absolute jump overwrites the accumulated offset entirely.
    expect(clock.set("2026-10-02T13:00:00.000Z").getTime()).toBe(BASE + HOUR_MS);
    expect(clock.now().getTime()).toBe(BASE + HOUR_MS);
    // Replaying an out-of-order event is expressible: backwards steps are
    // allowed on purpose, so a single clock can serve a replay.
    expect(clock.step(-HOUR_MS).getTime()).toBe(BASE);
  });

  test("origin is the construction instant and is immune to later steps", () => {
    const clock = fixedClock(new Date(BASE));
    clock.step(HOUR_MS);
    clock.set("2030-01-01T00:00:00.000Z");
    expect(clock.origin.getTime()).toBe(BASE);
    expect(clock.now().getTime()).toBe(Date.parse("2030-01-01T00:00:00.000Z"));
    // origin hands back a copy too.
    clock.origin.setUTCFullYear(1999);
    expect(clock.origin.getUTCFullYear()).toBe(2026);
  });

  test("with no argument the fake is frozen at the documented epoch, not at the wall clock", () => {
    // The default exists so a mis-wired harness FAILS LOUDLY in the artifact
    // instead of quietly tracking real time. Compared against a wall-clock
    // read in the same tick, the two must not be the same instant.
    const clock = fixedClock();
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    const wall = systemClock().now().getTime();
    expect(Math.abs(clock.now().getTime() - wall)).toBeGreaterThan(HOUR_MS);
  });

  test("a non-finite step is refused rather than silently producing an Invalid Date", () => {
    // NaN would otherwise poison `current`, and every later read with it —
    // one bad delta would become a permanently corrupt clock.
    const clock = fixedClock(new Date(BASE));
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => clock.step(bad)).toThrow(TypeError);
    }
    expect(clock.now().getTime()).toBe(BASE);
  });

  test("toInstant rejects what Date would silently call Invalid", () => {
    expect(toInstant("2026-10-02T12:00:00.000Z").getTime()).toBe(BASE);
    expect(toInstant(new Date(BASE)).getTime()).toBe(BASE);
    // An invalid string or Date must fail at the boundary, not become an
    // `Invalid Date` that serialises to null in the artifact's JSON.
    expect(() => toInstant("not-a-date")).toThrow(TypeError);
    expect(() => toInstant(new Date(Number.NaN))).toThrow(TypeError);
    // The name reaches the message so a failing gate points at its own call site.
    expect(() => toInstant("not-a-date", "clock.at")).toThrow(/clock\.at/);
    expect(() => fixedClock("not-a-date")).toThrow(/fixedClock\.at/);
    expect(() => fixedClock(new Date(BASE)).set("not-a-date")).toThrow(/fixedClock\.set/);
    // The input Date is copied, so a caller cannot mutate the clock later.
    const input = new Date(BASE);
    const out = toInstant(input);
    input.setUTCFullYear(1999);
    expect(out.getTime()).toBe(BASE);
  });

  test("each clock declares its adapter id and mode, and the two disagree", () => {
    // The port registry uses `mode` to refuse a fake in production, so a
    // clock that claimed "real" while standing still would defeat that check.
    const sys = systemClock();
    const fake = fixedClock(new Date(BASE));
    expect(sys.adapterId).toBe(SYSTEM_CLOCK_ID);
    expect(sys.mode).toBe("real");
    expect(fake.adapterId).toBe(FIXED_CLOCK_ID);
    expect(fake.mode).toBe("fake");
    expect(sys.adapterId).not.toBe(fake.adapterId);
  });

  test("the system clock advances across real time and never moves backwards", () => {
    // The only property the production clock can honestly promise: it reads
    // the wall clock. Exactness is not testable and is not promised.
    const sys = systemClock();
    const before = sys.now().getTime();
    const spin = Date.now();
    while (Date.now() - spin < 5) {
      // burn ~5 ms of wall clock
    }
    const after = sys.now().getTime();
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(Math.abs(after - Date.now())).toBeLessThan(MINUTE_MS);
    expect(sys.now()).not.toBe(sys.now());
  });
});
