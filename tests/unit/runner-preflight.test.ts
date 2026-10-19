/**
 * The runner disk preflight, including the parse it exists to get right.
 *
 * The gate is only worth having if a full disk turns it red and a healthy one leaves it
 * green — the first draft of `freeGbFromDf` read the wrong `df -P` column and failed a
 * box with 36 GB free, which is the same class of defect as a check that cannot fail:
 * a preflight that always fires is a preflight that will be deleted within a week.
 */
import { describe, expect, test } from "bun:test";

import { freeGbFromDf, verdict } from "../../scripts/runner-preflight.ts";

// Real `df -P /` output from the runner box, blocks in 1024-byte units.
const HEALTHY =
  "Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/sda1       99475456 61234560  33187840      65% /";
const WRAPPED =
  "Filesystem                                                               1024-blocks      Used Available Capacity Mounted on\n" +
  "8f3c1f2a4b5d6e7f0a1b2c3d4e5f6a7b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f-overlay\n" +
  "                                                                                     99475456  90000000   4400000      96% /";
const FULL =
  "Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/sda1       99475456 99000000       0     100% /";

describe("the runner disk preflight", () => {
  test("a healthy disk reads the Available column, not Capacity", () => {
    const gb = freeGbFromDf(HEALTHY);
    expect(gb).not.toBeNull();
    expect(gb).toBeCloseTo(33187840 / 1024 / 1024, 1);
    // The trap, named: Capacity is the second-to-last field and looks plausible.
    expect(gb).not.toBeCloseTo(65, 0);
  });

  test("a wrapped device name still parses, from the continuation line", () => {
    const gb = freeGbFromDf(WRAPPED);
    expect(gb).not.toBeNull();
    expect(gb).toBeCloseTo(4400000 / 1024 / 1024, 1);
  });

  test("a full disk is refused with the condition named", () => {
    const call = verdict(freeGbFromDf(FULL), 10);
    expect(call.ok).toBe(false);
    expect(call.why).toContain("runner disk full");
    expect(call.why).toContain("0.0 GB free");
    expect(call.why).toContain("docker buildx prune");
  });

  test("unparseable df fails closed rather than assuming room", () => {
    for (const junk of [
      "",
      "not df at all",
      "Filesystem 1024-blocks Used Available Capacity Mounted on",
    ]) {
      const call = verdict(freeGbFromDf(junk), 10);
      expect(call.ok, junk).toBe(false);
      expect(call.why).toContain("refusing to assume");
    }
  });

  test("the threshold is the decision, not a constant in the message", () => {
    const gb = freeGbFromDf(HEALTHY)!;
    expect(verdict(gb, 10).ok).toBe(true);
    expect(verdict(gb, 40).ok).toBe(false);
  });
});
