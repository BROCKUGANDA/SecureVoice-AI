import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "@/lib/config";

/**
 * The tunables are ENVIRONMENT variables, not constants in the source.
 *
 * ── Why this is a gate and not a convention ─────────────────────────────────
 *
 * Every one of these numbers is a decision an operator makes PER DEPLOYMENT:
 * how long the kill switch's state is trusted, how long a blocked dial waits,
 * how many cases the console shows, how fast the console refreshes, how long a
 * colour is given to become healthy, what the canary's splits are. A constant
 * in the source is a decision that needs a code change to change — and the
 * deploy script's constants need a code change ON THE BOX, which is the one
 * place a code change is hardest and during an incident is least possible.
 *
 * So: every tunable is an environment variable with a documented default, and
 * a malformed value takes the default rather than failing. A typo in a
 * deployment variable must not stop a rollback, and a rollback that refuses to
 * run is the worst possible time to discover one.
 *
 * The second half of this file is the drift gate: the source of each tunable
 * must not contain its own default as a literal, because that is exactly how a
 * tunable stops being one.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

type Case = {
  name: string;
  envName: string;
  get: () => number;
  fallback: number;
  /** A value INSIDE the setting's documented range. */
  valid: number;
  /** The setting's documented minimum. */
  min: number;
};

const CASES: Case[] = [
  {
    name: "the kill switch's cache window",
    envName: "PILOT_SWITCH_CACHE_MS",
    get: () => env.pilotSwitchCacheMs,
    fallback: 5_000,
    valid: 4_242,
    min: 0,
  },
  {
    name: "the blocked-dial retry floor",
    envName: "PILOT_BLOCK_RETRY_MIN_MS",
    get: () => env.pilotBlockRetryMinMs,
    fallback: 60_000,
    valid: 61_000,
    min: 1_000,
  },
  {
    name: "the blocked-dial retry ceiling",
    envName: "PILOT_BLOCK_RETRY_MAX_MS",
    get: () => env.pilotBlockRetryMaxMs,
    fallback: 86_400_000,
    valid: 90_000_000,
    min: 60_000,
  },
  {
    name: "the waiting list's bound",
    envName: "PILOT_WAITING_LIST_LIMIT",
    get: () => env.pilotWaitingListLimit,
    fallback: 25,
    valid: 42,
    min: 1,
  },
  {
    name: "the cap reset countdown's floor",
    envName: "PILOT_CAP_RESET_FLOOR_SEC",
    get: () => env.pilotCapResetFloorSec,
    fallback: 60,
    valid: 42,
    min: 1,
  },
  {
    name: "the dial worker's call lease",
    envName: "DIAL_WORKER_CALL_LEASE_MS",
    get: () => env.dialWorkerCallLeaseMs,
    fallback: 900_000,
    valid: 1_200_000,
    min: 60_000,
  },
  {
    name: "the breaker's failure threshold",
    envName: "BREAKER_FAILURE_THRESHOLD",
    get: () => env.breakerFailureThreshold,
    fallback: 5,
    valid: 9,
    min: 1,
  },
  {
    name: "the breaker's half-open probes",
    envName: "BREAKER_HALF_OPEN_PROBES",
    get: () => env.breakerHalfOpenProbes,
    fallback: 1,
    valid: 3,
    min: 1,
  },
];

describe("the pilot tunables read the environment", () => {
  for (const c of CASES) {
    test(`${c.name} is the environment's value`, () => {
      const saved = process.env[c.envName];
      try {
        process.env[c.envName] = String(c.valid);
        expect(c.get(), c.envName).toBe(c.valid);
      } finally {
        if (saved === undefined) delete process.env[c.envName];
        else process.env[c.envName] = saved;
      }
    });

    test(`${c.name} falls back on a malformed value`, () => {
      const saved = process.env[c.envName];
      // "0" is malformed only for a setting whose minimum is above it; for the
      // rest it is a legitimate value and must be taken as one.
      const malformed = ["", "not-a-number", "NaN", "-1"];
      if (c.min > 0) malformed.push("0");
      try {
        for (const bad of malformed) {
          process.env[c.envName] = bad;
          expect(c.get(), `${c.envName}=${bad}`).toBe(c.fallback);
        }
      } finally {
        if (saved === undefined) delete process.env[c.envName];
        else process.env[c.envName] = saved;
      }
    });
  }
});

describe("the tunables are not constants in the source", () => {
  /**
   * A tunable whose default is written in the file that USES it is one edit
   * away from being a constant again, and the edit is invisible: nothing
   * fails, the number just stops being changeable without a deploy.
   *
   * The check is deliberately narrow — the default's own literal, in the file
   * that owns the setting — because a broad "no numbers in this file" rule
   * would flag every protocol constant, every timeout that is genuinely a
   * constant, and every test fixture.
   */
  const FORBIDDEN: Array<{ file: string; literal: string; why: string }> = [
    {
      file: "src/lib/pilot/mode.ts",
      literal: "5_000",
      why: "PILOT_SWITCH_CACHE_MS is the switch's cache window",
    },
    {
      file: "src/lib/pilot/mode.ts",
      literal: "60_000",
      why: "PILOT_BLOCK_RETRY_MIN_MS is the blocked-dial retry floor",
    },
    {
      file: "src/app/api/console/pilot/route.ts",
      literal: "= 25",
      why: "PILOT_WAITING_LIST_LIMIT is the waiting list's bound",
    },
    {
      file: "src/views/PilotPanel.tsx",
      literal: "15_000",
      why: "NEXT_PUBLIC_PILOT_POLL_INTERVAL_MS is the panel's refresh",
    },
    {
      file: "src/worker/dial.ts",
      literal: "failureThreshold: 5",
      why: "BREAKER_FAILURE_THRESHOLD is the breaker's threshold",
    },
    {
      file: "src/worker/dial.ts",
      literal: "halfOpenProbes: 1",
      why: "BREAKER_HALF_OPEN_PROBES is the breaker's probe count",
    },
  ];

  for (const f of FORBIDDEN) {
    test(`${f.file} does not hardcode ${f.literal} — ${f.why}`, () => {
      const src = read(f.file);
      expect(src.includes(f.literal), `${f.file} hardcodes ${f.literal}`).toBe(false);
    });
  }

  /**
   * The other half of the same risk, and the half that actually bit.
   *
   * A FORBIDDEN literal catches a value that was put BACK into the source. It
   * does not catch a FILE that was reverted wholesale — the file goes back to
   * a version that hardcodes the value under a different spelling, or to a
   * version that predates the setting entirely, and the literal check either
   * misses it or fires on the wrong thing.
   *
   * That is not hypothetical. The promotion ladder merges branches by taking
   * one side's CONTENT, and a merge that takes the other side's older copy of
   * a file silently reverts whatever that file had. It happened: two files of
   * the pilot surface went back to their pre-config versions on `dev`, and the
   * only thing that noticed was this suite.
   *
   * So the gate is POSITIVE as well: the file that OWNS a setting must still
   * READ it. A revert removes the reference, the reference is what is
   * asserted, and the branch goes red instead of quietly shipping the old
   * behaviour.
   */
  const REQUIRED: Array<{ file: string; reference: string; why: string }> = [
    {
      file: "src/lib/pilot/mode.ts",
      reference: "env.pilotSwitchCacheMs",
      why: "the kill switch's cache window",
    },
    {
      file: "src/lib/pilot/mode.ts",
      reference: "env.pilotBlockRetryMinMs",
      why: "the blocked-dial retry floor",
    },
    {
      file: "src/lib/pilot/mode.ts",
      reference: "env.pilotBlockRetryMaxMs",
      why: "the blocked-dial retry ceiling",
    },
    {
      file: "src/lib/pilot/mode.ts",
      reference: "env.pilotShadowRetryMs",
      why: "the shadow-mode wait",
    },
    {
      file: "src/lib/pilot/mode.ts",
      reference: "env.pilotCharterRetryMs",
      why: "the charter-refusal wait",
    },
    {
      file: "src/app/api/console/pilot/route.ts",
      reference: "env.pilotWaitingListLimit",
      why: "the waiting list's bound",
    },
    {
      file: "src/views/PilotPanel.tsx",
      reference: "PILOT_POLL_INTERVAL_MS",
      why: "the panel's refresh",
    },
    {
      file: "src/worker/dial.ts",
      reference: "env.dialWorkerCallLeaseMs",
      why: "the dial worker's call lease",
    },
    {
      file: "src/worker/dial.ts",
      reference: "env.breakerFailureThreshold",
      why: "the breaker's threshold",
    },
    {
      file: "src/worker/dial.ts",
      reference: "env.breakerHalfOpenProbes",
      why: "the breaker's probe count",
    },
  ];

  for (const r of REQUIRED) {
    test(`${r.file} still READS ${r.reference} — ${r.why}`, () => {
      const src = read(r.file);
      expect(
        src.includes(r.reference),
        `${r.file} no longer reads ${r.reference}: the file was reverted to a version that does not have the setting`,
      ).toBe(true);
    });
  }

  test("the config module declares every setting the pilot reads", () => {
    const src = read("src/lib/config.ts");
    for (const name of [
      "PILOT_SWITCH_CACHE_MS",
      "PILOT_BLOCK_RETRY_MIN_MS",
      "PILOT_BLOCK_RETRY_MAX_MS",
      "PILOT_SHADOW_RETRY_MS",
      "PILOT_CHARTER_RETRY_MS",
      "PILOT_WAITING_LIST_LIMIT",
      "PILOT_CAP_RESET_FLOOR_SEC",
      "DIAL_WORKER_CALL_LEASE_MS",
      "BREAKER_FAILURE_THRESHOLD",
      "BREAKER_HALF_OPEN_PROBES",
    ]) {
      expect(src.includes(`"${name}"`), `src/lib/config.ts no longer declares ${name}`).toBe(true);
    }
  });

  test("the deploy script declares its tunables by NAME", () => {
    // The deploy script runs ON the production box, so a constant in it is a
    // decision that needs a code change on the box. The names are the contract
    // with the operator, and a name that disappears is a knob that stops
    // working.
    const src = read("scripts/deploy.mjs");
    for (const name of [
      "CANARY_SLOTS",
      "CANARY_START_PERCENT",
      "CANARY_MID_PERCENT",
      "CANARY_SOAK_SECONDS",
      "CANARY_PROBE_INTERVAL_SECONDS",
      "COLOUR_HEALTH_TIMEOUT_MS",
      "COLOUR_POLL_INTERVAL_MS",
      "COLOUR_CONTAINER_GRACE_MS",
      "APP_PORT",
      "PROBE_ORIGIN",
      "PROBE_PATH",
      "HEALTH_PATH",
      "PROBE_TIMEOUT_SEC",
    ]) {
      expect(src.includes(name), `scripts/deploy.mjs no longer declares ${name}`).toBe(true);
    }
  });

  test("the canary workflow reads its ladder from repository variables", () => {
    const src = read(".github/workflows/canary.yml");
    for (const name of [
      "CANARY_START_PERCENT",
      "CANARY_MID_PERCENT",
      "CANARY_SOAK_SECONDS",
      "CANARY_PROBE_ATTEMPTS",
      "CANARY_PROBE_BACKOFF_SEC",
      "CANARY_PROBE_PATH",
      "CANARY_PROBE_TIMEOUT_SEC",
    ]) {
      expect(src.includes(`vars.${name}`), `canary.yml does not read vars.${name}`).toBe(true);
    }
  });
});
