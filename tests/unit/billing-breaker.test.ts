/**
 * UNIT — the spend circuit breaker's pure layer (src/lib/billing/breaker.ts).
 *
 * This module decides whether the platform may spend a third party's money, so
 * its failure direction is the whole point. The properties below are the ones
 * where the wrong answer is unbounded spend:
 *
 *   · THE KILL SWITCH IS READ PER CALL, NOT CACHED. It is the incident lever: a
 *     metered provider charging for something we did not ask for must stop the
 *     platform's spending within one request. Caching it at module scope would
 *     require a redeploy to stop the bleeding.
 *   · A MALFORMED CAP THROWS at the boundary rather than silently becoming
 *     "unlimited". A cap that parses to 0 or NaN is the difference between
 *     "spend nothing" and "spend anything".
 *   · Money is INTEGER minor units. A float is refused at the boundary — never
 *     rounded into money, because rounding 0.5 fils into a bill is a real
 *     financial bug that no reconciliation catches.
 *   · The hourly window is UTC-ALIGNED and the daily window is UTC-MIDNIGHT. A
 *     local-midnight day moves the reset boundary twice a year, which is how two
 *     operators end up looking at different numbers for the same org.
 *   · `maySpend` is true for `allow` AND `warn` — a warn is a page, not a stop.
 *
 * The DB-backed decision functions (`assertWithinBudget`, `breakerStatus`) are
 * integration territory and are not exercised here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ALERT_THRESHOLDS,
  BUDGET_WINDOWS,
  DAILY_LIMIT_ENV,
  HARD_STOP_PERCENT,
  HOURLY_LIMIT_ENV,
  KILL_SWITCH_ENV,
  budgetFor,
  clearOrgBudget,
  killSwitchEngaged,
  maySpend,
  setOrgBudget,
  windowBounds,
} from "@/lib/billing/breaker";

const ENV_KEYS = [KILL_SWITCH_ENV, HOURLY_LIMIT_ENV, DAILY_LIMIT_ENV] as const;
const saved: Record<string, string | undefined> = {};
let orgSeq = 0;
const uniqueOrg = () => `org-billing-${process.pid}-${orgSeq++}`;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("kill switch — the incident lever", () => {
  test("is off when unset", () => {
    expect(killSwitchEngaged()).toBe(false);
  });

  test("recognises every documented true spelling", () => {
    for (const v of ["1", "true", "on", "yes", "stop", "halt"]) {
      process.env[KILL_SWITCH_ENV] = v;
      expect({ v, engaged: killSwitchEngaged() }).toEqual({ v, engaged: true });
    }
  });

  test("any other value leaves it off — an unknown word is not a stop", () => {
    for (const v of ["0", "false", "off", "no", "", "maybe", "enabled"]) {
      process.env[KILL_SWITCH_ENV] = v;
      expect({ v, engaged: killSwitchEngaged() }).toEqual({ v, engaged: false });
    }
  });

  test("it is read per call, so flipping it takes effect immediately", () => {
    // The reason this is not a module constant: an incident must not need a
    // redeploy to stop spending.
    expect(killSwitchEngaged()).toBe(false);
    process.env[KILL_SWITCH_ENV] = "stop";
    expect(killSwitchEngaged()).toBe(true);
    delete process.env[KILL_SWITCH_ENV];
    expect(killSwitchEngaged()).toBe(false);
  });
});

describe("budget registry", () => {
  test("falls back to the documented defaults when nothing is configured", () => {
    // Asserted through budgetFor because the default constants are module-local
    // by design; the observable contract is "what an unconfigured org gets".
    expect(budgetFor(uniqueOrg())).toEqual({
      hourlyMinor: 1_000_000,
      dailyMinor: 10_000_000,
    });
  });

  test("the defaults are 10,000.00 and 100,000.00 AED", () => {
    const { hourlyMinor, dailyMinor } = budgetFor(uniqueOrg());
    expect({ hourlyAed: hourlyMinor / 100, dailyAed: dailyMinor / 100 }).toEqual({
      hourlyAed: 10_000,
      dailyAed: 100_000,
    });
  });

  test("the environment overrides the defaults", () => {
    process.env[HOURLY_LIMIT_ENV] = "5000";
    process.env[DAILY_LIMIT_ENV] = "60000";
    expect(budgetFor(uniqueOrg())).toEqual({ hourlyMinor: 5000, dailyMinor: 60_000 });
  });

  test("a per-org override wins over the environment", () => {
    process.env[HOURLY_LIMIT_ENV] = "5000";
    const org = uniqueOrg();
    setOrgBudget(org, { hourlyMinor: 1234 });
    expect(budgetFor(org).hourlyMinor).toBe(1234);
  });

  test("a partial override keeps the other window's value", () => {
    const org = uniqueOrg();
    setOrgBudget(org, { hourlyMinor: 1000 });
    setOrgBudget(org, { dailyMinor: 2000 });
    expect(budgetFor(org)).toEqual({
      hourlyMinor: 1000,
      dailyMinor: 2000,
    });
  });

  test("clearing an override restores the environment default", () => {
    process.env[HOURLY_LIMIT_ENV] = "5000";
    const org = uniqueOrg();
    setOrgBudget(org, { hourlyMinor: 1234 });
    clearOrgBudget(org);
    expect(budgetFor(org).hourlyMinor).toBe(5000);
  });

  test("overrides are per-org — one org's cap never affects another's", () => {
    const a = uniqueOrg();
    const b = uniqueOrg();
    setOrgBudget(a, { hourlyMinor: 1 });
    setOrgBudget(b, { hourlyMinor: 2 });
    expect({ a: budgetFor(a).hourlyMinor, b: budgetFor(b).hourlyMinor }).toEqual({
      a: 1,
      b: 2,
    });
  });

  test("a limit of ZERO is accepted — it means spend nothing, not unlimited", () => {
    const org = uniqueOrg();
    setOrgBudget(org, { hourlyMinor: 0, dailyMinor: 0 });
    expect(budgetFor(org)).toEqual({ hourlyMinor: 0, dailyMinor: 0 });
  });

  test("a float limit is refused at the boundary", () => {
    // Rounding a float into money is a real financial bug, so it throws rather
    // than silently rounding.
    expect(() => setOrgBudget(uniqueOrg(), { hourlyMinor: 100.5 })).toThrow(TypeError);
  });

  test("a negative limit is refused", () => {
    expect(() => setOrgBudget(uniqueOrg(), { hourlyMinor: -1 })).toThrow(RangeError);
  });

  test("NaN and Infinity limits are refused", () => {
    expect(() => setOrgBudget(uniqueOrg(), { hourlyMinor: Number.NaN })).toThrow();
    expect(() => setOrgBudget(uniqueOrg(), { dailyMinor: Number.POSITIVE_INFINITY })).toThrow();
  });

  test("an unsafe integer limit is refused", () => {
    expect(() => setOrgBudget(uniqueOrg(), { hourlyMinor: Number.MAX_SAFE_INTEGER + 2 })).toThrow();
  });

  test("the thrown error names the offending field", () => {
    const org = uniqueOrg();
    expect(() => setOrgBudget(org, { hourlyMinor: 1.5 })).toThrow(new RegExp(org));
  });

  test("a malformed environment cap throws rather than becoming unlimited", () => {
    // The failure this guards: a typo in the env var silently authorising
    // unbounded spend.
    for (const bad of ["abc", "-1", "1.5", "NaN", "1e999"]) {
      process.env[HOURLY_LIMIT_ENV] = bad;
      expect(() => budgetFor(uniqueOrg())).toThrow();
    }
  });

  test("an empty environment cap falls back to the default", () => {
    process.env[HOURLY_LIMIT_ENV] = "   ";
    // Blank is treated as unset, so the org still gets the documented default
    // rather than a zero cap that would refuse all spend.
    expect(budgetFor(uniqueOrg()).hourlyMinor).toBe(1_000_000);
  });
});

describe("window bounds", () => {
  test("the hourly window snaps to the UTC hour", () => {
    const now = new Date("2026-10-03T04:37:12.500Z");
    const { start, end } = windowBounds("hourly", now);
    expect(start.toISOString()).toBe("2026-10-03T04:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-03T05:00:00.000Z");
  });

  test("the daily window snaps to UTC midnight, not local midnight", () => {
    // A local-midnight day moves the reset boundary twice a year and makes two
    // operators disagree about the same number.
    const now = new Date("2026-10-03T23:59:59.999Z");
    const { start, end } = windowBounds("daily", now);
    expect(start.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });

  test("the window spans exactly its period", () => {
    const now = new Date("2026-10-03T04:37:12.500Z");
    for (const w of BUDGET_WINDOWS) {
      const { start, end } = windowBounds(w, now);
      expect({ w, ms: end.getTime() - start.getTime() }).toEqual({
        w,
        ms: w === "hourly" ? 3_600_000 : 86_400_000,
      });
    }
  });

  test("every instant inside a window maps to that same window", () => {
    const base = new Date("2026-10-03T04:00:00.000Z").getTime();
    const starts = new Set<string>();
    for (let offset = 0; offset < 3_600_000; offset += 600_000) {
      starts.add(windowBounds("hourly", new Date(base + offset)).start.toISOString());
    }
    expect(starts.size).toBe(1);
  });

  test("a window boundary belongs to the new window, not the old", () => {
    const boundary = new Date("2026-10-03T05:00:00.000Z");
    expect(windowBounds("hourly", boundary).start.toISOString()).toBe("2026-10-03T05:00:00.000Z");
  });

  test("the daily window does not shift across a DST transition in any zone", () => {
    // Because it is UTC-anchored, the start stays exactly midnight UTC on both
    // sides of any local DST change.
    const before = new Date("2026-03-28T12:00:00.000Z");
    const after = new Date("2026-03-29T12:00:00.000Z");
    for (const d of [before, after]) {
      expect(windowBounds("daily", d).start.toISOString().slice(11)).toBe("00:00:00.000Z");
    }
  });

  test("the returned Dates are new objects, not a shared mutable reference", () => {
    const now = new Date("2026-10-03T04:37:12.500Z");
    const a = windowBounds("hourly", now);
    const b = windowBounds("hourly", now);
    expect(a.start).not.toBe(b.start);
    expect(a.start.getTime()).toBe(b.start.getTime());
  });
});

describe("maySpend", () => {
  const windows: never[] = [];

  test("allow is spendable", () => {
    expect(
      maySpend({ decision: "allow", percent: 10, threshold: null, window: null, windows }),
    ).toBe(true);
  });

  test("warn is spendable — a warning is a page, not a stop", () => {
    // Refusing on warn would shed load at 60% of the cap, which is not what the
    // threshold ladder is for.
    expect(
      maySpend({ decision: "warn", percent: 61, threshold: 60, window: "hourly", windows }),
    ).toBe(true);
  });

  test("stop is not spendable, whatever the reason", () => {
    for (const reason of [
      "kill_switch",
      "hard_stop",
      "zero_limit",
      "invalid_units",
      "invalid_budget",
      "metering_unavailable",
    ] as const) {
      expect(maySpend({ decision: "stop", reason, percent: 999, window: null, windows })).toBe(
        false,
      );
    }
  });

  test("a metering outage does NOT authorise spend", () => {
    // The single most important assertion in this file: a broken ledger must
    // never become an authorisation to spend without limit.
    expect(
      maySpend({
        decision: "stop",
        reason: "metering_unavailable",
        percent: 999,
        window: null,
        windows,
      }),
    ).toBe(false);
  });
});

describe("threshold ladder", () => {
  test("alerts at 60, 80 and 95 percent", () => {
    expect(ALERT_THRESHOLDS).toEqual([60, 80, 95]);
  });

  test("the ladder is strictly ascending", () => {
    for (let i = 1; i < ALERT_THRESHOLDS.length; i += 1) {
      expect(ALERT_THRESHOLDS[i]!).toBeGreaterThan(ALERT_THRESHOLDS[i - 1]!);
    }
  });

  test("every alert threshold is below the hard stop", () => {
    // An alert at or above the stop would never be seen, because the stop is
    // evaluated first.
    for (const t of ALERT_THRESHOLDS) {
      expect(t).toBeLessThan(HARD_STOP_PERCENT);
    }
  });

  test("the hard stop is exactly 100 percent", () => {
    expect(HARD_STOP_PERCENT).toBe(100);
  });

  test("both budget windows are declared", () => {
    expect(BUDGET_WINDOWS).toEqual(["hourly", "daily"]);
  });
});
