/**
 * AA-1.3 — timezone-independence gate.
 *
 * The class of bug this exists to catch: a case opened at 23:40 EAT lands in the
 * wrong billing period, or a UTC-authored cutoff fires at the wrong local hour.
 * Both are invisible from one timezone and catastrophic in another, and the
 * operators are in Nairobi while the deploy box is UTC — so the mismatch is not
 * hypothetical, it is the default configuration.
 *
 * ── Why this spawns a child process instead of setting process.env.TZ ────────
 *
 * `TZ` is read by the C runtime at PROCESS START. Assigning `process.env.TZ`
 * inside a running Bun process is unreliable — the already-initialised local-time
 * cache means the change may not take effect, which would make this gate assert
 * nothing while appearing to pass. So each hostile zone is exercised in a real
 * child process with `TZ` set before exec, and the child's verdict is checked.
 *
 * The child is the SAME module under test, imported fresh. If a result differs
 * between zones, the difference is real and the gate fails with both values.
 *
 * ── Zones chosen to break things ────────────────────────────────────────────
 *
 *   Pacific/Kiritimati  UTC+14, the largest offset in the world. A UTC day
 *                       boundary here is 14 hours ahead of local midnight, so any
 *                       local-time day arithmetic is maximally wrong.
 *   Pacific/Niue        UTC-11, 25 hours behind Kiritimati. Together the two
 *                       bracket the full 24-hour span, so a day bucket computed
 *                       in local time cannot accidentally agree in both.
 *   UTC                 the reference every correct implementation reduces to.
 *
 *   bun test tests/timezone
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CHILD = join(HERE, "tz-probe.ts");
// `src/lib/billing/breaker.ts` opens with `import "server-only"`, a Next bundler
// marker that throws outside the RSC bundle. tests/preload.ts no-ops that one
// specifier — the same convention every other DB-touching suite in this repo
// already relies on (and bunfig.toml wires globally for `bun test`; the child
// here is `bun run`, which does not read bunfig's [test] section, so it is passed
// explicitly rather than left to chance).
const PRELOAD = join(HERE, "..", "preload.ts");

/** Zones that must all produce identical results for UTC-correct code. */
const HOSTILE_ZONES = ["UTC", "Pacific/Kiritimati", "Pacific/Niue"] as const;

/** Run the probe in a child process with TZ set before exec. */
function probeIn(tz: string): { ok: boolean; payload?: TzReading; error?: string } {
  const res = spawnSync(process.execPath, ["run", "--preload", PRELOAD, CHILD], {
    // `TZ` in the child's environment is the whole point of the exercise.
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "").slice(0, 400) };
  }
  try {
    return { ok: true, payload: JSON.parse(res.stdout.trim()) as TzReading };
  } catch {
    return { ok: false, error: `probe did not emit JSON: ${(res.stdout || "").slice(0, 200)}` };
  }
}

/** One child's reading. Everything except `local*` must agree across zones. */
type TzReading = {
  tz: string | null;
  probeInstant: number;
  isoTimestamp: string;
  quotaKey: string;
  dailyWindowStartMs: number;
  dailyWindowEndMs: number;
  hourlyWindowStartMs: number;
  hourlyWindowEndMs: number;
  localHour: number;
  localDayOfMonth: number;
  localOffsetMinutes: number;
};

describe("the hostile-zone harness works at all", () => {
  test("every zone runs and emits a reading", () => {
    for (const tz of HOSTILE_ZONES) {
      const r = probeIn(tz);
      expect(r.ok, `probe failed under TZ=${tz}: ${r.error}`).toBe(true);
      expect(r.payload).toBeDefined();
    }
  });

  test("the zone genuinely changed — otherwise every assertion below is vacuous", () => {
    // THE load-bearing check. If TZ never took effect in the child, every
    // "identical across zones" assertion below would pass while proving nothing.
    const offsets = HOSTILE_ZONES.map((tz) => probeIn(tz).payload?.localOffsetMinutes);
    expect(new Set(offsets).size, `offsets did not vary by zone: ${offsets.join(",")}`).toBe(
      HOSTILE_ZONES.length,
    );
    // Kiritimati is UTC+14 and Niue is UTC-11: 25 hours apart, so a day bucket
    // computed in local time cannot coincidentally agree in both.
    const kiritimati = probeIn("Pacific/Kiritimati").payload!.localOffsetMinutes;
    const niue = probeIn("Pacific/Niue").payload!.localOffsetMinutes;
    expect(kiritimati - niue, "the two extreme zones are not actually 25h apart").toBe(25 * 60);
  });
});

describe("stored time is timezone-independent", () => {
  const readings = HOSTILE_ZONES.map((tz) => ({ tz, reading: probeIn(tz).payload! }));

  test("the instant is the same in every zone", () => {
    const instants = new Set(readings.map((r) => r.reading.probeInstant));
    expect(instants.size, `probe instants diverged: ${[...instants].join(",")}`).toBe(1);
  });

  test("the audit timestamp string is identical in every zone", () => {
    // `new Date().toISOString()` is what the audit chain writes. A local-time
    // formatter here would change the stored value per zone, and the chain hash
    // would then depend on where the writer happened to be deployed.
    const stamps = new Set(readings.map((r) => r.reading.isoTimestamp));
    expect(
      [...stamps],
      "the audit timestamp differs by timezone — something is storing wall-clock time",
    ).toEqual(["2026-03-14T23:40:00.000Z"]);
  });

  test("the daily quota key is identical in every zone", () => {
    // src/lib/tts-quota.ts builds its day bucket from `toISOString().slice(0,10)`.
    // If that ever became a local-date format, a user would get a fresh quota at
    // their own midnight rather than at the UTC boundary, and two operators
    // would disagree about how much of the day's budget is left.
    const keys = new Set(readings.map((r) => r.reading.quotaKey));
    expect([...keys], "the daily quota key differs by timezone").toEqual(["2026-03-14"]);
  });

  test("budget window boundaries are identical in every zone", () => {
    for (const field of [
      "dailyWindowStartMs",
      "dailyWindowEndMs",
      "hourlyWindowStartMs",
      "hourlyWindowEndMs",
    ] as const) {
      const values = new Set(readings.map((r) => r.reading[field]));
      expect(values.size, `${field} differs by timezone: ${[...values].join(",")}`).toBe(1);
    }
  });

  test("the daily window is a UTC day, half-open [start, end), exactly 24h", () => {
    // The instant under test is 23:40 UTC, so a correct UTC day runs
    // 2026-03-14T00:00:00Z to 2026-03-15T00:00:00Z and CONTAINS the instant.
    const r = readings[0]!.reading;
    expect(r.dailyWindowStartMs).toBe(Date.UTC(2026, 2, 14, 0, 0, 0));
    expect(r.dailyWindowEndMs).toBe(Date.UTC(2026, 2, 15, 0, 0, 0));
    expect(r.dailyWindowEndMs - r.dailyWindowStartMs).toBe(86_400_000);
    // Half-open: the start is inside, the end is NOT. An inclusive end would make
    // an event at exactly midnight belong to two consecutive days.
    expect(r.probeInstant).toBeGreaterThanOrEqual(r.dailyWindowStartMs);
    expect(r.probeInstant).toBeLessThan(r.dailyWindowEndMs);
  });

  test("the hourly window contains the instant and is exactly one hour", () => {
    const r = readings[0]!.reading;
    expect(r.hourlyWindowEndMs - r.hourlyWindowStartMs).toBe(3_600_000);
    expect(r.probeInstant).toBeGreaterThanOrEqual(r.hourlyWindowStartMs);
    expect(r.probeInstant).toBeLessThan(r.hourlyWindowEndMs);
  });
});
