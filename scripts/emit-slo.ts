#!/usr/bin/env bun
/**
 * WP-7 — emit evidence/latency/slo.json from REAL recorded spans.
 *
 *   bun --preload ./tests/preload.ts scripts/emit-slo.ts
 *   bun --preload ./tests/preload.ts scripts/emit-slo.ts --window=1440 --min=30
 *
 * The `--preload` is required for the same reason `bun run outbox:work` carries
 * it: the telemetry modules import the `server-only` bundler marker, which
 * throws outside an RSC bundle. `tests/preload.ts` no-ops that marker.
 *
 * What it guarantees, and why each guarantee costs something:
 *
 *   1. **No fabrication, ever.** Every figure is computed from spans the running
 *      platform recorded in `evidence/latency/spans.jsonl`. There is no
 *      transcription table, no seeded default, no "typical" fallback. A span with
 *      no samples is written as `null` / `not_measured`.
 *   2. **Under 30 real interventions, it exits NON-ZERO.** It still writes the
 *      artifact — an artifact that says "this gate failed, here is the real
 *      count" is more useful than no artifact — and it prints the count. A gate
 *      that passes on 0 samples is the exact defect this replaces.
 *   3. **An intervention means the whole chain ran.** Only a completed
 *      `signal_received_to_freeze_staged` span counts. A signal that was received
 *      and accepted but never reached a freeze proves the intake path alone.
 *   4. **Unmeasured spans do not fake a verdict.** They set `all_targets_met` to
 *      `null` and are listed in `spans_not_measured`. They do not block the exit
 *      code — the 30-intervention threshold is the brief's gate, and inventing a
 *      stricter one here would be a rule nobody asked for.
 *
 * Exit codes: 0 = gate passed, 1 = gate failed (with the reasons on stdout).
 *
 * Environment
 *   TELEMETRY_SPAN_LOG   span log to read (default evidence/latency/spans.jsonl)
 *   SLO_EVIDENCE_PATH    where to write     (default evidence/latency/slo.json)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { flushSpansNow } from "../src/lib/telemetry/store";
import { buildSloReport, loadSloSource, REQUIRED_INTERVENTIONS } from "../src/lib/telemetry/report";
import { SPAN_DEFINITIONS } from "../src/lib/telemetry/spans";

const ROOT = resolve(import.meta.dir, "..");

function flag(name: string, fallback: number | null): number | null {
  const prefixed = process.argv.find((a) => a.startsWith(`--${name}=`));
  const bare = process.argv.includes(`--${name}`);
  if (!prefixed && !bare) return fallback;
  if (bare && !prefixed) return null; // `--window` with no value means "all time"
  const raw = (prefixed as string).split("=").slice(1).join("=");
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`✗ --${name} must be a positive number, received "${raw}"`);
    process.exit(1);
  }
  return value;
}

const windowMinutes = flag("window", null);
const interventions = flag("interventions", null);
const minInterventions = flag("min", REQUIRED_INTERVENTIONS) ?? REQUIRED_INTERVENTIONS;

const outPath = resolve(
  process.env.SLO_EVIDENCE_PATH ?? join(ROOT, "evidence", "latency", "slo.json"),
);

// Anything the recorder queued in this process is made durable BEFORE reading,
// so a script that recorded a span and immediately emitted cannot under-report.
await flushSpansNow();

const source = await loadSloSource({ windowMinutes, interventions });
const { report, ok, exitCode, reasons } = buildSloReport(source, {
  windowMinutes,
  interventions,
  requiredInterventions: minInterventions,
});

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

/* ————— stdout is the gate's own explanation ————— */

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padStart = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

console.log(`[slo] ${outPath}`);
console.log(
  `[slo] log: ${report.source.log}  (${source.recordsRead} record(s)${source.truncated ? ", tail-truncated" : ""}${source.malformedLines > 0 ? `, ${source.malformedLines} unreadable line(s)` : ""}${source.missing ? ", file missing" : ""})`,
);
console.log(
  `[slo] interventions: ${report.interventions_measured} complete (terminal span "${report.intervention_definition.terminal_span}") ` +
    `of ${minInterventions} required · ${report.interventions_seen} seen with at least one span`,
);
console.log("");
console.log(
  `  ${pad("span", 46)}${padStart("p50", 11)}${padStart("p95", 11)}${padStart("budget", 11)}  verdict`,
);
for (const row of report.spans) {
  const ms = (v: number | null) =>
    v === null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
  console.log(
    `  ${pad(row.label, 46)}${padStart(ms(row.p50_ms), 11)}${padStart(ms(row.p95_ms), 11)}${padStart(ms(row.target_p95_ms), 11)}  ${row.verdict} (${row.value_kind}, n=${row.samples})`,
  );
}
console.log("");
console.log(
  `[slo] baseline: ${report.industry_baseline.label} (${report.industry_baseline.kind}) — ${report.industry_baseline.sources[0]}`,
);

const notMeasured = report.spans_not_measured.filter(
  (n) => !SPAN_DEFINITIONS.some((d) => d.name === n),
);
if (notMeasured.length > 0) {
  console.error(`[slo] WARNING unknown span names in the artifact: ${notMeasured.join(", ")}`);
}
if (report.spans_not_measured.length > 0) {
  console.log(
    `[slo] not measured (${report.spans_not_measured.length}/${report.spans.length}): ${report.spans_not_measured.join(", ")}`,
  );
  console.log(
    "[slo] these are NOT passes. `all_targets_met` is null while any span is unmeasured.",
  );
}

if (reasons.length === 0) {
  console.log("");
  console.log(
    `[slo] PASS — ${report.interventions_measured} real interventions, every measured span inside budget.`,
  );
  process.exit(0);
}

console.error("");
console.error(`[slo] FAIL — the evidence does not meet the definition of done:`);
for (const reason of reasons) console.error(`[slo]   • ${reason}`);
console.error(`[slo] wrote the artifact anyway: ${outPath}`);
console.error(
  `[slo] required: ${minInterventions} real interventions (currently ${report.interventions_measured}).`,
);
process.exit(exitCode);
