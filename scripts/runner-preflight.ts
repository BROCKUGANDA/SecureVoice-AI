#!/usr/bin/env bun
/**
 * Runner disk preflight — fail with a name, not an IOException.
 *
 * Both self-hosted runners share this box's single 96 GB root filesystem, and the
 * GitHub runner writes its own `_diag` log as it works. When the disk fills, the
 * failure is not a build error: the runner process dies inside
 * `System.IO.IOException: No space left on device : '.../_diag/Worker_*.log'`, the job
 * is marked failed with no useful annotation, and the promotion PR stays
 * `mergeStateStatus: BLOCKED` forever while the ladder looks like it is still running.
 * That is how 2026-10-19 lost an hour: production kept serving, CI kept going green on
 * every other job, and the only red line was an I/O error in a runner log nobody reads.
 *
 * So ask the question before the expensive work: enough free space to build, or stop
 * now and say which condition fired.
 *
 * THREE CONDITIONS, not one, because capacity alone missed what happened next:
 *   * free space — the original condition, and the one that strands a promotion;
 *   * inodes — a filesystem can report 30% free and still refuse to create a file,
 *     which is how a build dies on `ENOSPC` while `df` looks healthy;
 *   * write + fsync latency — the box has 4 cores and swap. A disk saturated by
 *     another product's backup writes the tree on it fsyncs slowly, and the build
 *     does not fail with a disk error at all: it fails with buildkit's
 *     `graceful_stop` GOAWAY, or a postgres `timeout exceeded when trying to
 *     connect` — symptoms that point at the code, and are the disk.
 *
 * Usage: bun scripts/runner-preflight.ts [--min-gb 10] [--min-inode-pct 10]
 *        [--max-write-ms 5000] [--df "<df output>"] [--df-inodes "<df -i output>"]
 *        [--write-ms <n>]
 *   The overrides exist so every branch is testable without filling or saturating a
 *   real disk — the same reason `freeGbFromDf` takes a string instead of calling df.
 */
import { writeSync, openSync, closeSync, unlinkSync, fsyncSync } from "node:fs";

const args = process.argv.slice(2);

function flag(name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
}

/** Free space in GB from a POSIX `df -P /` line, across the wrapped-name case. */
export function freeGbFromDf(dfOutput: string): number | null {
  const lines = dfOutput.trim().split("\n").filter(Boolean);
  const data = lines.filter((l) => !/^Filesystem/i.test(l));
  if (data.length === 0) return null;
  // A long device name wraps to its own line; the numbers are on the last line.
  const last = data.at(-1)!;
  const cols = last.trim().split(/\s+/);
  // POSIX `df -P` fields are Filesystem, 1024-blocks, Used, Available, Capacity,
  // Mounted-on — Available is the third from the right, and that holds for a wrapped
  // device name too (the continuation line simply drops the first field). Reading it
  // positionally from the left is how this function first returned null on a healthy
  // disk and turned a preflight into a false outage.
  const avail = cols.length >= 5 ? Number(cols[cols.length - 3]) : Number.NaN;
  if (!Number.isFinite(avail)) return null;
  // `df -P` reports 1024-byte blocks.
  return avail / 1024 / 1024;
}

export function verdict(freeGb: number | null, minGb: number): { ok: boolean; why: string } {
  if (freeGb === null) {
    return {
      ok: false,
      why: "could not read free space from `df -P /` — refusing to assume there is room",
    };
  }
  if (freeGb < minGb) {
    return {
      ok: false,
      why:
        `runner disk full: ${freeGb.toFixed(1)} GB free on the runner's root filesystem, ` +
        `${minGb} GB required. Both self-hosted runners share this disk and the runner dies ` +
        `writing its own _diag log when it fills, which strands the promotion as a red I/O ` +
        `error. Reclaim with ` +
        "`docker buildx prune -af && docker image prune -af --filter until=24h` " +
        "(the 04:15 cron usually has already done this — if it has not, check `journalctl -u cron`).",
    };
  }
  return { ok: true, why: `${freeGb.toFixed(1)} GB free (>= ${minGb} GB required)` };
}

/**
 * Free-inode percentage from a POSIX `df -P -i` line.
 *
 * `IFree` is the field, and — same trap as `Available` above — it is read from the
 * right so a wrapped device name cannot shift it. Returns null when the number is
 * absent or not a number, which includes the common "df -i on a filesystem that does
 * not support inodes reports `-`" case: that is an unknown, and an unknown fails
 * closed here exactly where free space does.
 */
export function inodeFreePctFromDf(dfOutput: string): number | null {
  const lines = dfOutput.trim().split("\n").filter(Boolean);
  const data = lines.filter((l) => !/^Filesystem/i.test(l));
  if (data.length === 0) return null;
  const cols = data.at(-1)!.trim().split(/\s+/);
  // Fields: Filesystem, Inodes, IUsed, IFree, IUse%, Mounted-on — anchored from the
  // RIGHT, because a long device name wraps and its continuation line simply omits the
  // first field. Counting from the left is how the first version of this read `IUsed`
  // where it meant `IFree` and reported 22.7% on a box with 77% free: a preflight that
  // reads the wrong column is worse than no preflight, because it decides real deploys.
  if (cols.length < 5) return null;
  const itotal = Number(cols[cols.length - 5]);
  const ifree = Number(cols[cols.length - 3]);
  if (!Number.isFinite(itotal) || !Number.isFinite(ifree) || itotal <= 0) return null;
  return (ifree / itotal) * 100;
}

export function inodeVerdict(pct: number | null, minPct: number): { ok: boolean; why: string } {
  if (pct === null) {
    return {
      ok: false,
      why: "could not read free inodes from `df -P -i` — refusing to assume the filesystem can create files",
    };
  }
  if (pct < minPct) {
    return {
      ok: false,
      why:
        `inode exhaustion: ${pct.toFixed(1)}% of inodes free, ${minPct}% required. ` +
        `A disk with bytes left and no inodes still fails every write with ENOSPC, and a ` +
        `build fails on it in a place that looks like a code error.`,
    };
  }
  return { ok: true, why: `${pct.toFixed(1)}% inodes free (>= ${minPct}% required)` };
}

/**
 * Was a real 4 MiB write-and-fsync inside the budget.
 *
 * `null` means the probe did not complete — full filesystem, read-only mount, or a
 * directory the runner cannot write. That is a failure, not a skip: the whole point of
 * this file is that an unmeasured condition never reads as healthy.
 */
export function writeVerdict(writeMs: number | null, maxMs: number): { ok: boolean; why: string } {
  if (writeMs === null) {
    return {
      ok: false,
      why:
        "could not write and fsync a 4 MiB probe file on the runner's filesystem — full, " +
        "read-only, or the probe directory is not writable. Not measured, so not a pass.",
    };
  }
  if (writeMs > maxMs) {
    return {
      ok: false,
      why:
        `disk I/O saturated: a 4 MiB fdatasync write took ${writeMs}ms, budget ${maxMs}ms. ` +
        `Capacity is not the problem; the device is not keeping up, and a build on it will ` +
        `fail as a timeout or a buildkit GOAWAY rather than as a disk error.`,
    };
  }
  return { ok: true, why: `4 MiB fdatasync in ${writeMs}ms (<= ${maxMs}ms budget)` };
}

/** The probe itself: create, write 4 MiB, fsync, time it, remove it. */
export function measureFdatasyncMs(dir: string): number | null {
  const path = `${dir}/.runner-preflight-probe.${process.pid}`;
  const buf = Buffer.alloc(4 * 1024 * 1024, 0);
  let fd: number | null = null;
  const started = Date.now();
  try {
    fd = openSync(path, "w");
    writeSync(fd, buf, 0, buf.length, null);
    fsyncSync(fd);
    return Date.now() - started;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      /* the probe file is not the measurement */
    }
  }
}

if (import.meta.main) {
  const minGb = Number(flag("--min-gb", "10"));
  const minInodePct = Number(flag("--min-inode-pct", "10"));
  const maxWriteMs = Number(flag("--max-write-ms", "5000"));
  const spawn = (cmd: string[]) => Bun.spawnSync({ cmd, stdout: "pipe" }).stdout.toString();

  const df = args.includes("--df") ? flag("--df", "") : spawn(["df", "-P", "/"]);
  const dfInodes = args.includes("--df-inodes")
    ? flag("--df-inodes", "")
    : spawn(["df", "-P", "-i", "/"]);
  const writeMs = args.includes("--write-ms")
    ? Number(flag("--write-ms", "0"))
    : measureFdatasyncMs(process.env.HOME || process.cwd());

  const checks = [
    verdict(freeGbFromDf(df), minGb),
    inodeVerdict(inodeFreePctFromDf(dfInodes), minInodePct),
    writeVerdict(Number.isFinite(writeMs) ? writeMs : null, maxWriteMs),
  ];
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.why}`);
  if (failed.length) {
    for (const c of failed) console.error(`::error::${c.why}`);
    process.exit(1);
  }
  console.log("runner preflight: capacity, inodes and write latency all inside their floors");
}
