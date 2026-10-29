#!/usr/bin/env bun
/**
 * The evidence bundle's gate verdict: did this gate execute anything, and did
 * it pass?
 *
 * These are two questions, and the bundle used to ask only the second one
 * (`r.status === 0`). `bun test` exits 0 when every test in a file is skipped,
 * and exits 0 for a file that printed no summary at all — so a gate that ran
 * nothing was recorded as a pass. That is how the committed bundle reported
 * 17/19 while the agent-layer tool-call verification sat at zero executed runs:
 * a skipped suite and a passing suite look identical to an exit code.
 *
 * A gate that proves nothing is not a passing gate, so `gateVerdict` fails
 * zero-execution regardless of the exit code. Only pass + fail count as
 * executed: a skipped test is a declared absence, not a result.
 *
 * The input is the runner's own stdout, because the counts are transcribed, not
 * recomputed. `bun run test <dir>` spawns one process per file with stdio
 * inherited, so a directory gate prints one summary block per file; the tally
 * sums all of them. The old parser took the first match, which silently
 * reported the first file's count as the whole suite.
 *
 * Kept in `scripts/` and imported by both `build-evidence.ts` and
 * `tests/unit/evidence-verdict.test.ts` (same arrangement as
 * `runner-preflight.ts`) so every branch below is exercised by a test rather
 * than by running a twenty-minute bundle.
 */

export type TestTally = {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  /** passed + failed — tests that actually produced a result. */
  executed: number;
};

/**
 * Sum the runner's summary lines. Anchored to whole lines on purpose: the load
 * gate logs budget arithmetic like `[load] budget check: 12 pass of 12`, and an
 * unanchored `(\d+) pass` reads that as a test count.
 *
 * A line is `  <n> pass`, `  <n> fail`, `  <n> skip` (bun indents with two
 * spaces and prints one summary per file).
 */
export function tallyTests(output: string): TestTally {
  const total = (word: "pass" | "fail" | "skip"): number | null => {
    const re = new RegExp(`^\\s*(\\d+) ${word}\\s*$`, "gm");
    let seen = false;
    let n = 0;
    for (const m of output.matchAll(re)) {
      seen = true;
      n += Number(m[1]);
    }
    return seen ? n : null;
  };
  const passed = total("pass");
  const failed = total("fail");
  const skipped = total("skip");
  return { passed, failed, skipped, executed: (passed ?? 0) + (failed ?? 0) };
}

export type GateVerdict = {
  ok: boolean;
  zeroExecuted: boolean;
  /** Short reason for the console line and the bundle's gate table. */
  why: string;
};

export function gateVerdict(exitCode: number, tally: TestTally): GateVerdict {
  const zeroExecuted = tally.executed === 0;
  const ok = exitCode === 0 && !zeroExecuted;
  let why: string;
  if (zeroExecuted) {
    why =
      tally.passed === null && tally.failed === null
        ? "the gate produced no test summary — it executed nothing"
        : `${tally.executed} test(s) executed (${tally.skipped ?? 0} skipped) — a gate that runs nothing proves nothing`;
  } else {
    why = exitCode === 0 ? "passed" : `exit ${exitCode}`;
  }
  return { ok, zeroExecuted, why };
}
