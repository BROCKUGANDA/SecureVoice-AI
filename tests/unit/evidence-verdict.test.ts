import { describe, expect, test } from "bun:test";

import { gateVerdict, tallyTests } from "../../scripts/evidence-verdict";

/**
 * The evidence bundle's gate verdict used to be `r.status === 0` and nothing
 * else. `bun test` exits 0 when every test in a file is skipped, and it exits 0
 * for a file that printed no summary at all, so a gate that executed NOTHING
 * was recorded as a pass — which is how the bundle stayed green while the
 * agent-layer tool-call verification reported zero executed runs.
 *
 * These tests pin the shape of the runner output the tally reads, and the rule
 * the verdict enforces: exit 0 is necessary and not sufficient.
 */

describe("tallyTests — reads the runner's own summary lines", () => {
  test("sums every per-file block, not just the first", () => {
    // `bun run test <dir>` spawns one process per file with stdio inherited, so
    // a directory gate prints one summary block per file. The old parser took
    // the FIRST match, so a two-file gate reported the first file's count as if
    // it were the whole suite.
    const output = [
      "a.test.ts:",
      " 2 pass",
      " 0 fail",
      "",
      "b.test.ts:",
      " 5 pass",
      " 1 fail",
      " 3 skip",
      "",
    ].join("\n");
    const t = tallyTests(output);
    expect(t.passed).toBe(7);
    expect(t.failed).toBe(1);
    expect(t.skipped).toBe(3);
    expect(t.executed).toBe(8);
  });

  test("a summary-shaped log line is not a summary", () => {
    const output = "[load] budget check: 12 pass of 12\n 1 pass\n 0 fail\n";
    const t = tallyTests(output);
    expect(t.passed).toBe(1);
  });

  test("no summary at all leaves the counts unknown, not zero", () => {
    const t = tallyTests("No tests found!\n");
    expect(t.passed).toBeNull();
    expect(t.failed).toBeNull();
    expect(t.executed).toBe(0);
  });
});

describe("gateVerdict — exit 0 is not enough", () => {
  test("an all-skipped suite exits 0 and still fails", () => {
    // Measured against bun 1.4.2: `test.skip` for every test prints
    // " 0 pass / N skip / 0 fail" and exits 0.
    const t = tallyTests(" 0 pass\n 6 skip\n 0 fail\n");
    const v = gateVerdict(0, t);
    expect(t.executed).toBe(0);
    expect(v.zeroExecuted).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.why).toContain("6 skipped");
  });

  test("a gate that printed no summary fails even on exit 0", () => {
    const v = gateVerdict(0, tallyTests("done\n"));
    expect(v.ok).toBe(false);
    expect(v.why).toContain("executed nothing");
  });

  test("real executions with exit 0 pass", () => {
    const v = gateVerdict(0, tallyTests(" 4 pass\n 0 fail\n"));
    expect(v.ok).toBe(true);
    expect(v.zeroExecuted).toBe(false);
  });

  test("a non-zero exit still fails, with the code named", () => {
    const v = gateVerdict(3, tallyTests(" 4 pass\n 1 fail\n"));
    expect(v.ok).toBe(false);
    expect(v.why).toBe("exit 3");
  });

  test("failures count as executions — a red suite is not 'zero executed'", () => {
    const v = gateVerdict(1, tallyTests(" 0 pass\n 2 fail\n"));
    expect(v.zeroExecuted).toBe(false);
    expect(v.ok).toBe(false);
  });
});
