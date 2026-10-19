/**
 * The runner disk preflight, including the parse it exists to get right.
 *
 * The gate is only worth having if a full disk turns it red and a healthy one leaves it
 * green — the first draft of `freeGbFromDf` read the wrong `df -P` column and failed a
 * box with 36 GB free, which is the same class of defect as a check that cannot fail:
 * a preflight that always fires is a preflight that will be deleted within a week.
 */
import { describe, expect, test } from "bun:test";

import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  freeGbFromDf,
  inodeFreePctFromDf,
  inodeVerdict,
  measureFdatasyncMs,
  verdict,
  writeVerdict,
} from "../../scripts/runner-preflight.ts";

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

// Real `df -P -i /` from 57.130.80.158, and the shapes a wrapped name and a
// filesystem without inodes produce.
const INODES_HEALTHY =
  "Filesystem        Inodes   IUsed     IFree IUse% Mounted on\n/dev/sda1       12418560 2822265 9596295   23% /";
const INODES_WRAPPED =
  "Filesystem                                                              Inodes IUsed IFree IUse% Mounted on\n" +
  "8f3c1f2a4b5d6e7f0a1b2c3d4e5f6a7b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f-overlay\n" +
  "                                                                            12418560 2822265 9596295   23% /";
const INODES_UNSUPPORTED =
  "Filesystem           Inodes IUsed IFree IUse% Mounted on\nC:/Program Files/Git      -     -     -     - /";

describe("the preflight's inode condition", () => {
  test("IFree is read, not IUsed — the off-by-one this file was written to pin", () => {
    const pct = inodeFreePctFromDf(INODES_HEALTHY);
    expect(pct).not.toBeNull();
    expect(pct).toBeCloseTo((9596295 / 12418560) * 100, 1);
    // 22.7% is what reading one field too far left returns. It is a plausible number,
    // it is above the 10% floor, and it was measured on the box before being caught:
    // the difference between a warning and a false all-clear is an assertion like this.
    expect(pct).not.toBeCloseTo(22.7, 1);
  });

  test("a wrapped device name still parses, from the continuation line", () => {
    expect(inodeFreePctFromDf(INODES_WRAPPED)).toBeCloseTo(77.28, 1);
  });

  test("a filesystem that reports no inodes is unknown, and unknown fails closed", () => {
    expect(inodeFreePctFromDf(INODES_UNSUPPORTED)).toBeNull();
    const call = inodeVerdict(null, 10);
    expect(call.ok).toBe(false);
    expect(call.why).toContain("refusing to assume");
  });

  test("the inode floor is the decision", () => {
    const pct = inodeFreePctFromDf(INODES_HEALTHY)!;
    expect(inodeVerdict(pct, 10).ok).toBe(true);
    expect(inodeVerdict(pct, 90).ok).toBe(false);
    expect(inodeVerdict(2.5, 10).why).toContain("inode exhaustion");
  });
});

describe("the preflight's write condition", () => {
  test("a probe that never ran is a failure, not a skip", () => {
    const call = writeVerdict(null, 5000);
    expect(call.ok).toBe(false);
    expect(call.why).toContain("Not measured, so not a pass");
  });

  test("a slow fsync names saturation rather than capacity", () => {
    const call = writeVerdict(41200, 5000);
    expect(call.ok).toBe(false);
    expect(call.why).toContain("disk I/O saturated");
    // The mis-attribution this exists to prevent: saturation shows up as a timeout,
    // so the message must not let anyone read it as "out of space".
    expect(call.why).toContain("Capacity is not the problem");
  });

  test("a fast fsync passes, and the budget is the decision", () => {
    expect(writeVerdict(4, 5000).ok).toBe(true);
    expect(writeVerdict(4, 1).ok).toBe(false);
  });

  test("the probe really returns null when the directory cannot hold a file", () => {
    // Deterministic across platforms: point it at a path UNDER A FILE, which fails
    // with ENOTDIR/ENOTCAPABLE everywhere, rather than at a made-up absolute path.
    // (Overriding $HOME to an unwritable value was tried first and hung for 60s in
    // bun's own startup before reaching this line, so it tests nothing about the
    // probe — which is the whole branch under test.)
    const tmpFile = join(tmpdir(), `preflight-not-a-dir-${process.pid}`);
    writeFileSync(tmpFile, "x");
    try {
      expect(measureFdatasyncMs(tmpFile)).toBeNull();
      expect(writeVerdict(measureFdatasyncMs(tmpFile), 5000).ok).toBe(false);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  test("the probe measures a real write when the directory is writable", () => {
    const ms = measureFdatasyncMs(tmpdir());
    expect(ms).not.toBeNull();
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(writeVerdict(ms, 5000).ok).toBe(true);
  });
});
