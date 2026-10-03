/**
 * Load-artifact consistency gate.
 *
 * `docs/CAPACITY.md` §7 presents itself as a transcription of
 * `evidence/load/results.json` — the artifact a judge will open and diff the
 * prose against. Nothing checked that transcription, so §7 shipped figures that
 * matched no run the artifact had ever recorded: "1,118 dialled, 82 shed", and
 * "0 errors, 0 dead-lettered" against an artifact whose own `result` was
 * `not-run` with hundreds of errors and dead jobs.
 *
 * A document that flatters itself about its own measurements is the one failure
 * mode a capacity model cannot survive, so the prose is checked against the
 * artifact here rather than trusted.
 *
 * The gate deliberately compares the figures that are INVARIANT across runs of
 * this gate — zero errors, zero dead-lettered, zero lost, zero double-claimed,
 * every case accounted for exactly, the vendor ceiling actually reached. Those
 * are the claims §7 leads with and the ones a contradicting artifact falsifies.
 *
 * It does NOT try to pin the dialled/shed split or the latency percentiles:
 * successive runs of `tests/load/load.test.ts` on the same code produced 632,
 * 715, 681, 299 and 92 sheds out of 1,200, because which case loses the race for
 * a voice slot is wall-clock contention rather than a property of the design. A
 * gate that demanded those match would fail on every re-record and would be
 * ignored, which is how a real gate stops being one. Instead §7 is required to
 * SAY that they move, and the split it quotes is required to be a real observed
 * value from a recorded run rather than an invented flattering one.
 *
 * No network, no database.
 *
 *   bun test tests/docs/load-artifact-consistency.test.ts
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const capacity = read("docs/CAPACITY.md");

// The artifact is external input, so it is parsed once at this boundary with the
// project's validator. A shape change fails here by name rather than silently
// turning one assertion into `undefined !== 5`.
const Accounting = z.object({
  casesIn: z.number(),
  casesFound: z.number(),
  dialled: z.number(),
  shedWithAuditRow: z.number(),
  shedWithoutAuditRow: z.number(),
  unaccountedInFlight: z.number(),
  unaccountedRefs: z.array(z.string()),
  queueRows: z.number(),
  chainSample: z.object({ checked: z.number(), ok: z.number(), broken: z.array(z.string()) }),
});

const Scenario = z.object({
  cases_in: z.number(),
  offered_concurrency: z.number(),
  dialled: z.number(),
  shed: z.number(),
  errors: z.number(),
  shed_rate: z.number(),
  queue: z.object({
    jobs_done: z.number(),
    jobs_dead: z.number(),
    jobs_retried: z.number(),
    jobs_lost_before_settlement: z.number(),
  }),
  gauge: z.object({ bands_seen: z.array(z.string()) }),
  vendor: z.object({ max_concurrent_sessions_observed: z.number(), gate_timeouts: z.number() }),
});

const LoadArtifact = z.object({
  result: z.string(),
  integrity: z.object({ determinism: z.object({ seededFrom: z.string() }) }),
  summary: z.object({
    steady_error_rate: z.number(),
    burst_error_rate: z.number(),
    cases_accounted_exactly: z.boolean(),
    burst_vendor_max_concurrent: z.number(),
  }),
  scenarios: z.object({ steady: Scenario, burst: Scenario }),
  accounting: z.object({ steady: Accounting, burst: Accounting }),
});

const artifact = LoadArtifact.parse(JSON.parse(read("evidence/load/results.json")));

/** The text of §7, so a match elsewhere in the document cannot satisfy a check. */
function section7(): string {
  const start = capacity.indexOf("## 7. What Layer A measured");
  expect(start).toBeGreaterThan(-1);
  const end = capacity.indexOf("\n## 8.", start);
  expect(end).toBeGreaterThan(start);
  return capacity.slice(start, end);
}

const s7 = section7();

/** Every integer literal in a string, comma-grouped or not. */
const numbersIn = (text: string) =>
  [...text.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, "")));

/** Strips markdown emphasis and collapses whitespace from a table cell. */
const normalizeCell = (s: string) => s.replace(/[*`]/g, "").replace(/\s+/g, " ").trim();

/** Splits a markdown table row into trimmed cells, or null if it is not one. */
function cellsOf(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const body = t.endsWith("|") ? t.slice(1, -1) : t.slice(1);
  return body.split("|").map((c) => c.trim());
}

/**
 * The §7 table row whose first cell is `label`, returned as its cells.
 *
 * This parses the row instead of matching the literal string `| label |`, and
 * that is a correction rather than a convenience. Prettier aligns markdown
 * tables, padding each cell out to the column width, so `| Dialled |` becomes
 * `| Dialled                    |` in the committed document. A `startsWith`
 * match then reports the row as MISSING — and because this is a consistency
 * gate whose job is to prove the prose was not quietly reworded, the honest
 * reading is the opposite one: a formatting pass must not be able to
 * masquerade as evidence that a claim was deleted.
 *
 * Emphasis is normalized too, because the label may be written `Errors` or
 * `**Errors**` depending on whether the author bolded the invariant, and that
 * is presentation, not content.
 */
function row(label: string): string[] {
  const want = normalizeCell(label);
  for (const line of s7.split(/\r?\n/)) {
    const cells = cellsOf(line);
    if (cells && cells.length > 1 && normalizeCell(cells[0]) === want) return cells;
  }
  throw new Error(`docs/CAPACITY.md §7 has no table row labelled "${label}"`);
}

/** The value cells of a §7 row, joined back into one searchable string. */
const rowValues = (label: string) => row(label).slice(1).join(" | ");

test("load: §7 describes a run that actually completed", () => {
  // The headline failure: prose quoting "0 errors, 0 dead-lettered" over an
  // artifact that recorded `not-run`.
  expect(artifact.result).toBe("recorded");
  expect(s7).toMatch(/`result` is \*\*`recorded`\*\*/);
});

test("load: the accounting invariants §7 leads with hold in the artifact", () => {
  expect(artifact.summary.cases_accounted_exactly).toBe(true);
  for (const scenario of [artifact.scenarios.steady, artifact.scenarios.burst]) {
    expect(scenario.errors).toBe(0);
    expect(scenario.queue.jobs_dead).toBe(0);
    expect(scenario.queue.jobs_lost_before_settlement).toBe(0);
    expect(scenario.vendor.gate_timeouts).toBe(0);
  }
  expect(artifact.summary.steady_error_rate).toBe(0);
  expect(artifact.summary.burst_error_rate).toBe(0);

  for (const accounting of [artifact.accounting.steady, artifact.accounting.burst]) {
    expect(accounting.unaccountedInFlight).toBe(0);
    expect(accounting.unaccountedRefs).toEqual([]);
    expect(accounting.shedWithoutAuditRow).toBe(0);
    expect(accounting.casesFound).toBe(accounting.casesIn);
    expect(accounting.dialled + accounting.shedWithAuditRow).toBe(accounting.casesIn);
    expect(accounting.chainSample.broken).toEqual([]);
    expect(accounting.chainSample.ok).toBe(accounting.chainSample.checked);
  }
});

test("load: §7 states those invariants, so the reader is not left to assume them", () => {
  // Each of these is a claim §7 makes in prose or table form. If one is dropped
  // the gate does not silently pass on a thinner document. Matched through the
  // cell parser so that Prettier's table alignment cannot be mistaken for a
  // removed claim: `row` throws when the label is absent, which is the point.
  expect(rowValues("`summary.cases_accounted_exactly`")).toContain("true");
  expect(rowValues("Jobs dead-lettered / lost / double-claimed")).toMatch(
    /\b0\s*\/\s*0\s*\/\s*0\b/,
  );
  expect(rowValues("Audit chains verified from genesis")).toMatch(/25\s*\/\s*25/);
  expect(rowValues("Errors, both scenarios")).toMatch(/\b0\b/);
});

test("load: §7's quoted dead-letter and error figures are the artifact's", () => {
  // The specific row that shipped the false claim. All four cells, in order.
  expect(numbersIn(rowValues("Jobs done / dead-lettered / lost / double-claimed"))).toEqual([
    artifact.scenarios.burst.queue.jobs_done,
    artifact.scenarios.burst.queue.jobs_dead,
    artifact.scenarios.burst.queue.jobs_lost_before_settlement,
    0,
  ]);
  expect(numbersIn(rowValues("Errors"))).toContain(artifact.scenarios.burst.errors);
});

test("load: §7's accounting block states the artifact's own invariants", () => {
  const { burst } = artifact.accounting;
  // The block reports the sum rather than one run's split, so the counts it
  // must carry are the ones that hold on every run.
  const block = s7.slice(s7.indexOf("**Accounting — the assertion that matters"));
  expect(block, "§7 has no accounting block").not.toBe("");
  for (const value of [burst.casesIn, burst.queueRows, burst.chainSample.checked]) {
    expect(numbersIn(block), `§7's accounting block never states ${value}`).toContain(value);
  }
  for (const label of [
    "cases in",
    "dialled",
    "shed WITH an audit row",
    "unaccounted",
    "queue rows",
    "audit chains verified",
    "vendor calls placed",
  ]) {
    expect(block, `§7's accounting block has no "${label}" line`).toContain(label);
  }
  // The artifact's own accounting must satisfy the claim the block makes.
  expect(burst.dialled + burst.shedWithAuditRow).toBe(burst.casesIn);
  expect(burst.unaccountedInFlight).toBe(0);
});

test("load: the vendor ceiling was reached, not inferred", () => {
  expect(artifact.summary.burst_vendor_max_concurrent).toBe(40);
  expect(artifact.scenarios.burst.vendor.max_concurrent_sessions_observed).toBe(40);
  expect(rowValues("Max concurrent sessions the vendor double ever saw")).toContain("40 of 40");
});

test("load: §7 says the shed split moves between runs instead of pinning it", () => {
  // §7 must not present a volatile per-run figure as if it were a property of
  // the design. It has to disclose the variance, or a reader will size a
  // campaign on one run's dialled/shed split.
  expect(s7).toMatch(/does move between runs/i);
  expect(s7.replace(/\s+/g, " ")).toMatch(
    /successive runs of this gate on the same code produced/i,
  );
  expect(s7).toMatch(/wall-clock contention/i);
});

test("load: §7's quoted split ranges are internally consistent with the artifact", () => {
  const { burst } = artifact.accounting;
  // §7 reports ranges rather than one run, so each bound must bracket a value
  // the design can actually produce: the dialled range and the shed range must
  // sum to the campaign, and the current run must fall inside both. This is the
  // check that catches a flattering invention such as "1,118 dialled, 82 shed".
  const range = (label: string) => {
    // Read the range out of the row's VALUE cells, not the whole line, so the
    // label itself can never contribute a number to the comparison.
    const m = rowValues(label).match(/([\d,]+)[^\d|]+([\d,]+)/);
    expect(m, `§7's "${label}" row states no observed range`).not.toBeNull();
    // Both groups are required (non-optional) captures, so a match always fills them.
    return [Number(m![1]!.replace(/,/g, "")), Number(m![2]!.replace(/,/g, ""))] as const;
  };
  const [minDialled, maxDialled] = range("Dialled");
  const [minShed, maxShed] = range("Shed with an audit row");

  expect(minShed + maxDialled, "the widest split must cover the whole campaign").toBe(
    artifact.scenarios.burst.cases_in,
  );
  expect(minDialled + minShed).toBeLessThanOrEqual(artifact.scenarios.burst.cases_in);
  expect(maxDialled + maxShed).toBeGreaterThanOrEqual(artifact.scenarios.burst.cases_in);

  // The run the artifact currently holds must lie inside the ranges §7 reports.
  expect(
    burst.dialled >= minDialled && burst.dialled <= maxDialled,
    `the artifact's ${burst.dialled} dialled is outside §7's reported range ${minDialled}–${maxDialled}`,
  ).toBe(true);
  expect(
    burst.shedWithAuditRow >= minShed && burst.shedWithAuditRow <= maxShed,
    `the artifact's ${burst.shedWithAuditRow} shed is outside §7's reported range ${minShed}–${maxShed}`,
  ).toBe(true);

  // The accounting block asserts the sum holds, so state it as an invariant.
  expect(burst.dialled + burst.shedWithAuditRow).toBe(artifact.scenarios.burst.cases_in);
  expect(s7).toMatch(/= dialled\s+\+ shed WITH an audit row = 1,200/);
});

test("load: §5 states the shed invariant, not one run's shed count", () => {
  // §5 used to quote a single run's shed total, which goes stale on every
  // re-record. The invariant it must state is that none lacked an audit row.
  const m = capacity.match(/Measured in Layer A: (every shed carried an[\s\S]{0,80}?)\./);
  expect(m, "docs/CAPACITY.md §5 no longer states the Layer A shed invariant").not.toBeNull();
  expect(m![1]).toMatch(/zero/i);
  expect(m![1]).toMatch(/audit row/i);
});

test("load: §7 points at the gate that keeps it honest", () => {
  expect(s7).toContain("tests/docs/load-artifact-consistency.test.ts");
});
