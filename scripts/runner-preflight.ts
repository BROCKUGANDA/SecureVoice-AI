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
 * Usage: bun scripts/runner-preflight.mjs [--min-gb 10] [--df "<df output>"]
 *   --df exists so the gate can be tested without filling a disk.
 */
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

if (import.meta.main) {
  const minGb = Number(flag("--min-gb", "10"));
  const provided = args.includes("--df") ? flag("--df", "") : "";
  const df =
    provided || Bun.spawnSync({ cmd: ["df", "-P", "/"], stdout: "pipe" }).stdout.toString();
  const call = verdict(freeGbFromDf(df), minGb);
  if (!call.ok) {
    console.error(`::error::${call.why}`);
    process.exit(1);
  }
  console.log(`runner disk preflight: ${call.why}`);
}
