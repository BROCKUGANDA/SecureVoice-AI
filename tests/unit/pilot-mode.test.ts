/**
 * GATE — `src/lib/pilot/mode.ts`: the pilot vocabulary, the two-half kill
 * switch, the caps, the approval lookup and the dial-time decision.
 *
 * This file covers the parts of pilot mode that do not need the console:
 *
 *   · **The mode ladder is conservative in exactly one direction.** Unset is
 *     `off` (existing deployments are unchanged), a RECOGNISED value is that
 *     value, and garbage is `shadow` — a typo in a variable whose purpose is
 *     to BOUND the platform must not resolve to unbounded.
 *   · **The env kill switch is an allowlist.** `stoppped` — a typo — leaves
 *     dialling ON, but is visible: the raw value and a `recognised` flag are
 *     published on `pilotStatus` rather than being rendered as a bare `false`.
 *   · **The database half fails CLOSED and is cached for five seconds.** An
 *     unreadable switch is treated as ENGAGED, because a control that stops
 *     customer contact must never be silently disarmed by a database blip.
 *   · **Caps are positive integers or they throw.** `"0"`, `"1.5"`, `"abc"` —
 *     each is a configuration fault surfaced as `pilot_invalid_configuration`
 *     at dial time and `pilot_cap_misconfigured` at intake, never a silent
 *     "no cap" or "zero".
 *   · **No pilot block ever produces a customer-facing failure.** Every block
 *     returns a retryable outcome whose delay is clamped to [1 min, 24 h] —
 *     the queue parks the job WITHOUT consuming an attempt, so no block can
 *     dead-letter into the blind-ping SMS.
 *   · **The per-dial approval is attempt-bound and a decline wins.** Approval
 *     for attempt 1 does not authorise attempt 2, and a decline row refuses
 *     every attempt for the case.
 *   · **The cap counters run on the DATABASE's clock and rows.** The query
 *     predicates are the shared one (`pilotOrgIsShared`) so the console and
 *     the worker cannot count two different row sets for one tenant.
 *
 * Env-mutating tests reset every variable they touch in a `finally`; DB rows
 * are deleted in `afterAll` by the prefixes this file owns. The switch row is
 * returned to EMPTY — its shipped state — because a stray engaged switch here
 * would stop dialling on whatever database the next run points at.
 *
 *   bun test tests/unit/pilot-mode.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import {
  DIAL_KILL_SWITCH_ENV,
  DIAL_KILL_SWITCH_NAME,
  PILOT_CONCURRENCY_CAP_ENV,
  PILOT_DAILY_CALL_CAP_ENV,
  PILOT_HUMAN_APPROVAL_ENV,
  PILOT_MODE_ENV,
  PILOT_SIGNAL_KIND_ENV,
  _resetPilotSwitchCacheForTest,
  dialKillSwitchDbState,
  dialKillSwitchEnvEngaged,
  dialKillSwitchEnvRawValue,
  pilotActedToday,
  pilotConcurrencyCap,
  pilotDailyCallCap,
  pilotDialDecision,
  pilotDialApproved,
  pilotInFlightNow,
  pilotMode,
  pilotModeResolution,
  pilotOrgIsShared,
  pilotRequiresHumanApproval,
  pilotSecondsUntilReset,
  pilotSignalKind,
  pilotStatus,
  setDialKillSwitch,
} from "@/lib/pilot/mode";

const TIMEOUT_MS = 120_000;
function slowTest(name: string, fn: () => Promise<void> | void) {
  test(name, fn, TIMEOUT_MS);
}

const PREFIX = "SV-PDM-";
const ORG = `0f0f0f0f-0000-4000-8000-${createHash("sha256")
  .update("PDM-a")
  .digest("hex")
  .slice(0, 12)}`;
const ORG_CONC = `0f0f0f0f-0000-4000-8000-${createHash("sha256")
  .update("PDM-c")
  .digest("hex")
  .slice(0, 12)}`;
const ACTOR = `00000000-0000-4000-8000-${createHash("sha256")
  .update("PDM-actor")
  .digest("hex")
  .slice(0, 12)}`;

/** Every pilot env var this suite touches, so nothing leaks between tests. */
const PILOT_ENV_VARS = [
  PILOT_MODE_ENV,
  DIAL_KILL_SWITCH_ENV,
  PILOT_DAILY_CALL_CAP_ENV,
  PILOT_CONCURRENCY_CAP_ENV,
  PILOT_HUMAN_APPROVAL_ENV,
  PILOT_SIGNAL_KIND_ENV,
];
const savedEnv: Record<string, string | undefined> = {};
for (const name of PILOT_ENV_VARS) savedEnv[name] = process.env[name];

async function clearPilotState(): Promise<void> {
  await db.platformSwitch.deleteMany({ where: { name: DIAL_KILL_SWITCH_NAME } });
  _resetPilotSwitchCacheForTest();
  for (const name of PILOT_ENV_VARS) delete process.env[name];
}

/**
 * Direct audit row, bypassing the hash chain. The chain append is sealed —
 * `chainHash` links — but the test database is the one place rows are allowed
 * to be planted and pruned, and a UNIQUE literal keeps collisions away.
 */
async function plantApproval(caseRef: string, orgId: string | null, intent: string) {
  await db.auditLog.create({
    data: {
      callRef: caseRef,
      action: "pilot",
      intent,
      orgId,
      chainHash: `PDM-${intent}-${caseRef}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      callerId: ACTOR,
    },
  });
}

beforeAll(async () => {
  await clearPilotState();
});

afterAll(async () => {
  await clearPilotState();
  await db.dialJob.deleteMany({ where: { caseRef: { startsWith: PREFIX } } });
  await db.case.deleteMany({ where: { caseRef: { startsWith: PREFIX } } });
  await db.auditLog.deleteMany({
    where: { OR: [{ callRef: { startsWith: PREFIX } }, { callerId: ACTOR, action: "pilot" }] },
  });
  for (const name of PILOT_ENV_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  await db.$disconnect();
});

describe("pilotMode — the conservative ladder", () => {
  slowTest("unset resolves to off — existing deployments are unchanged", () => {
    delete process.env.PILOT_MODE;
    const resolution = pilotModeResolution();
    expect(resolution.mode).toBe("off");
    expect(resolution.recognised).toBe(true);
  });

  slowTest("recognised values pass through, case-insensitively trimmed", () => {
    for (const [raw, want] of [
      ["live", "live"],
      ["  SHADOW ", "shadow"],
      ["off ", "off"],
    ] as const) {
      process.env.PILOT_MODE = raw;
      expect(pilotMode()).toBe(want);
    }
  });

  slowTest("a typo is shadow, not off — a bounding variable must not set the platform free", () => {
    process.env.PILOT_MODE = "lve";
    const resolution = pilotModeResolution();
    expect(resolution.mode).toBe("shadow");
    expect(resolution.recognised).toBe(false);
    expect(resolution.raw).toBe("lve");
  });
});

describe("the env kill switch — allowlist semantics", () => {
  slowTest("unset and empty are disengaged", () => {
    delete process.env.DIAL_KILL_SWITCH;
    expect(dialKillSwitchEnvEngaged()).toBe(false);
    process.env.DIAL_KILL_SWITCH = "   ";
    expect(dialKillSwitchEnvEngaged()).toBe(false);
  });

  slowTest("the recognised spellings engage", () => {
    for (const value of ["1", "true", "on", "yes", "STOP", "halt"]) {
      process.env[DIAL_KILL_SWITCH_ENV] = value;
      expect(dialKillSwitchEnvEngaged(), value).toBe(true);
    }
  });

  slowTest("a typo does NOT engage — but the raw value is published, not hidden", () => {
    process.env[DIAL_KILL_SWITCH_ENV] = "stoppped";
    expect(dialKillSwitchEnvEngaged()).toBe(false);
    expect(dialKillSwitchEnvRawValue()).toBe("stoppped");
  });

  slowTest("false/0/blank stay unrecognised-but-false without a warning", () => {
    for (const value of ["false", "0", "no"]) {
      process.env[DIAL_KILL_SWITCH_ENV] = value;
      expect(dialKillSwitchEnvEngaged(), value).toBe(false);
    }
  });

  slowTest(
    "the env half engages the dial-time decision before anything else is consulted",
    async () => {
      process.env[DIAL_KILL_SWITCH_ENV] = "1";
      _resetPilotSwitchCacheForTest();
      const decision = await pilotDialDecision({ orgId: null, caseRef: `${PREFIX}KILL-1` });
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe("dial_kill_switch");
        expect(decision.retryAfterMs).toBe(60_000);
      }
    },
  );
});

describe("the database kill switch — fail closed, cached", () => {
  slowTest("an empty switch table reads disengaged and available", async () => {
    _resetPilotSwitchCacheForTest();
    const state = await dialKillSwitchDbState();
    expect(state.engaged).toBe(false);
    expect(state.available).toBe(true);
  });

  slowTest("engaging through the writer flips the decision within the same tick", async () => {
    await setDialKillSwitch({ engaged: true, actor: ACTOR, reason: "mode test" });
    const state = await dialKillSwitchDbState();
    expect(state.engaged).toBe(true);
    expect(state.available).toBe(true);
    // The writer's own cache drop means the FIRST read after a flip is not
    // stale — a cached previous state here would let a release look engaged
    // (or an engage look released) for five seconds with no evidence either way.
    const decision = await pilotDialDecision({ orgId: null, caseRef: `${PREFIX}KILL-2` });
    expect(decision.allowed).toBe(false);
  });

  slowTest("the five-second cache holds between reads and drops on reset", async () => {
    await setDialKillSwitch({ engaged: true, actor: ACTOR });
    const first = await dialKillSwitchDbState();
    expect(first.engaged).toBe(true);
    // Mutate underneath WITHOUT going through the writer: the cache now
    // contradicts the database, and the cached read wins inside its window.
    await db.platformSwitch.update({
      where: { name: DIAL_KILL_SWITCH_NAME },
      data: { engaged: false },
    });
    const cached = await dialKillSwitchDbState();
    // Inside the cache window the previous read stands.
    expect(cached.engaged).toBe(true);
    _resetPilotSwitchCacheForTest();
    const fresh = await dialKillSwitchDbState();
    // After the reset the read is current again.
    expect(fresh.engaged).toBe(false);
  });
});

describe("the caps — positive integers or nothing", () => {
  slowTest("unset and empty mean no cap, not zero", () => {
    delete process.env[PILOT_DAILY_CALL_CAP_ENV];
    expect(pilotDailyCallCap()).toBeNull();
    process.env[PILOT_DAILY_CALL_CAP_ENV] = "  ";
    expect(pilotDailyCallCap()).toBeNull();
  });

  slowTest("a valid value parses", () => {
    process.env[PILOT_DAILY_CALL_CAP_ENV] = "12";
    expect(pilotDailyCallCap()).toBe(12);
    process.env[PILOT_CONCURRENCY_CAP_ENV] = "2";
    expect(pilotConcurrencyCap()).toBe(2);
  });

  slowTest("zero, fractions and words THROW — a broken cap is a fault, not a default", () => {
    for (const value of ["0", "-3", "1.5", "abc"]) {
      process.env[PILOT_DAILY_CALL_CAP_ENV] = value;
      expect(() => pilotDailyCallCap(), value).toThrow(RangeError);
    }
  });
});

describe("charter scope and approval defaults", () => {
  slowTest("an unset signal kind means no restriction", () => {
    delete process.env[PILOT_SIGNAL_KIND_ENV];
    expect(pilotSignalKind()).toBeNull();
    process.env[PILOT_SIGNAL_KIND_ENV] = "card_transaction_fraud";
    expect(pilotSignalKind()).toBe("card_transaction_fraud");
  });

  slowTest("human approval defaults ON in live mode, and only there", () => {
    delete process.env.PILOT_MODE;
    expect(pilotRequiresHumanApproval()).toBe(false); // off mode: no pilot at all
    process.env.PILOT_MODE = "live";
    delete process.env[PILOT_HUMAN_APPROVAL_ENV];
    expect(pilotRequiresHumanApproval()).toBe(true);
    process.env[PILOT_HUMAN_APPROVAL_ENV] = "0";
    expect(pilotRequiresHumanApproval()).toBe(false); // explicit, warned override
  });

  slowTest("the shared namespace folds null and 'default' into ONE counter predicate", () => {
    expect(pilotOrgIsShared(null)).toBe(true);
    expect(pilotOrgIsShared("default")).toBe(true);
    expect(pilotOrgIsShared(ORG)).toBe(false);
  });
});

describe("the counters — database rows, database clock", () => {
  slowTest("actedToday counts DISTINCT cases acted on today, honouring the exclusion", async () => {
    // One case = ONE case id; a retry is the same case id at attempt 2 (the
    // @@unique([caseId, attemptNo]) pair), which is exactly why the counter
    // counts DISTINCT case_id rather than rows.
    const caseA = `${PREFIX}CAP-A`;
    const caseB = `${PREFIX}CAP-B`;
    await db.dialJob.createMany({
      data: [
        { caseRef: caseA, caseId: `${PREFIX}cap-a-1`, orgId: ORG, payload: "{}" },
        { caseRef: caseA, caseId: `${PREFIX}cap-a-1`, orgId: ORG, payload: "{}", attemptNo: 2 },
        { caseRef: caseB, caseId: `${PREFIX}cap-b-1`, orgId: ORG, payload: "{}" },
      ],
    });
    const acted = await pilotActedToday(ORG, { excludeCaseId: `${PREFIX}cap-b-1` });
    expect(acted).toBe(1);
    const withoutExclusion = await pilotActedToday(ORG);
    expect(withoutExclusion).toBe(2);
  });

  slowTest("an org-less counter shares the default namespace instead of splitting it", async () => {
    const caseN = `${PREFIX}CAP-N`;
    await db.dialJob.create({
      data: { caseRef: caseN, caseId: `${PREFIX}cap-n-1`, orgId: null, payload: "{}" },
    });
    expect(await pilotActedToday(null)).toBeGreaterThanOrEqual(1);
  });

  slowTest("inFlight counts CLAIMED rows for the org", async () => {
    await db.dialJob.create({
      data: {
        caseRef: `${PREFIX}CONC-1`,
        caseId: `${PREFIX}conc-1`,
        orgId: ORG_CONC,
        payload: "{}",
        state: "CLAIMED",
        claimedBy: "worker-probe",
      },
    });
    expect(await pilotInFlightNow(ORG_CONC)).toBe(1);
    expect(await pilotInFlightNow(ORG)).toBe(0);
  });

  slowTest("secondsUntilReset is at least a minute on any database", async () => {
    expect(await pilotSecondsUntilReset()).toBeGreaterThanOrEqual(60);
  });
});

describe("pilotDialDecision — the dial-time charter", () => {
  // Every decision test starts from a NEUTRAL live deployment: no charter
  // restriction, no caps, approval explicitly OFF unless a test asserts on it.
  // Without this the tests would inherit each other's env ('malformed cap'
  // leaving a broken cap for the approval tests, a charter kind blocking the
  // cap tests…) and fail on pollution instead of on the property under test.
  beforeEach(async () => {
    delete process.env[PILOT_SIGNAL_KIND_ENV];
    delete process.env[PILOT_DAILY_CALL_CAP_ENV];
    delete process.env[PILOT_CONCURRENCY_CAP_ENV];
    delete process.env[PILOT_SIGNAL_KIND_ENV];
    delete process.env[DIAL_KILL_SWITCH_ENV];
    process.env.PILOT_MODE = "live";
    process.env[PILOT_HUMAN_APPROVAL_ENV] = "0"; // neutral: no per-dial approval
    await db.platformSwitch.deleteMany({ where: { name: DIAL_KILL_SWITCH_NAME } });
    await db.dialJob.deleteMany({
      where: { OR: [{ orgId: ORG }, { orgId: ORG_CONC }] },
    });
    _resetPilotSwitchCacheForTest();
  });

  slowTest("off mode allows the dial and costs only the kill-switch read", async () => {
    delete process.env.PILOT_MODE;
    const decision = await pilotDialDecision({ orgId: ORG, caseRef: `${PREFIX}OFF-1` });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.checked).toEqual(["kill_switch"]);
  });

  slowTest("shadow refuses the dial without reading any counter", async () => {
    process.env.PILOT_MODE = "shadow";
    _resetPilotSwitchCacheForTest();
    const decision = await pilotDialDecision({ orgId: ORG, caseRef: `${PREFIX}SH-1` });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("pilot_shadow_mode");
      expect(decision.retryAfterMs).toBe(300_000); // 5 min, the shadow recheck
    }
  });

  slowTest("an untyped signal is OUT OF SCOPE when the charter names a type", async () => {
    process.env[PILOT_SIGNAL_KIND_ENV] = "card_transaction_fraud";
    _resetPilotSwitchCacheForTest();
    const decision = await pilotDialDecision({ orgId: ORG, caseRef: `${PREFIX}SCOPE-1` });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("pilot_signal_kind_out_of_scope");
      expect(decision.retryAfterMs).toBe(3_600_000); // an out-of-scope dial is not retried this hour
    }
  });

  slowTest("a matching signal kind passes the charter and reaches the caps", async () => {
    process.env[PILOT_SIGNAL_KIND_ENV] = "card_transaction_fraud";
    expect(
      (
        await pilotDialDecision({
          orgId: ORG,
          caseRef: `${PREFIX}SCOPE-2`,
          signalKind: "card_transaction_fraud",
        })
      ).allowed,
    ).toBe(true);
  });

  slowTest("the daily cap blocks when OTHER cases already spent it", async () => {
    process.env[PILOT_DAILY_CALL_CAP_ENV] = "1";
    await db.dialJob.create({
      data: {
        caseRef: `${PREFIX}CAP-OTHER`,
        caseId: `${PREFIX}cap-other-1`,
        orgId: ORG,
        payload: "{}",
      },
    });
    const decision = await pilotDialDecision({
      orgId: ORG,
      caseRef: `${PREFIX}CAP-NEXT`,
      caseId: `${PREFIX}cap-next-1`,
      signalKind: "card_transaction_fraud",
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("pilot_daily_cap");
      expect(decision.retryAfterMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      expect(decision.retryAfterMs).toBeGreaterThanOrEqual(60_000);
    }
  });

  slowTest("the decision case never spends the cap on ITSELF (exclusion predicate)", async () => {
    process.env[PILOT_DAILY_CALL_CAP_ENV] = "1";
    await db.dialJob.create({
      data: {
        caseRef: `${PREFIX}CAP-SELF`,
        caseId: `${PREFIX}cap-self-1`,
        orgId: ORG,
        payload: "{}",
      },
    });
    process.env[PILOT_HUMAN_APPROVAL_ENV] = "0"; // isolate the cap from approval
    const decision = await pilotDialDecision({
      orgId: ORG,
      caseRef: `${PREFIX}CAP-SELF`,
      caseId: `${PREFIX}cap-self-1`,
      signalKind: "card_transaction_fraud",
    });
    expect(decision.allowed).toBe(true);
  });

  slowTest("the concurrency cap blocks when a call is already in flight", async () => {
    process.env[PILOT_CONCURRENCY_CAP_ENV] = "1";
    await db.dialJob.create({
      data: {
        caseRef: `${PREFIX}CONC-B`,
        caseId: `${PREFIX}conc-b-1`,
        orgId: ORG_CONC,
        payload: "{}",
        state: "CLAIMED",
        claimedBy: "worker-probe",
      },
    });
    const decision = await pilotDialDecision({
      orgId: ORG_CONC,
      caseRef: `${PREFIX}CONC-C`,
      caseId: `${PREFIX}conc-c-1`,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("pilot_concurrency_cap");
  });

  slowTest("a malformed cap refuses the dial outright — never silently unlimited", async () => {
    process.env[PILOT_DAILY_CALL_CAP_ENV] = "1.5";
    const decision = await pilotDialDecision({ orgId: ORG, caseRef: `${PREFIX}BADCAP-1` });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("pilot_invalid_configuration");
  });

  slowTest("live mode requires a per-attempt human approval by default", async () => {
    delete process.env[PILOT_HUMAN_APPROVAL_ENV]; // back to the live-mode default: ON
    _resetPilotSwitchCacheForTest();
    const caseRef = `${PREFIX}APP-1`;
    const decision = await pilotDialDecision({
      orgId: ORG,
      caseRef,
      caseId: `${PREFIX}app-1`,
      attemptNo: 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("pilot_human_approval_required");
  });

  slowTest("an approval for attempt 1 authorises attempt 1 and not attempt 2", async () => {
    delete process.env[PILOT_HUMAN_APPROVAL_ENV];
    const caseRef = `${PREFIX}APP-2`;
    await plantApproval(caseRef, ORG, "pilot_dial_approved:1");
    const first = await pilotDialDecision({
      orgId: ORG,
      caseRef,
      caseId: `${PREFIX}app-2`,
      attemptNo: 1,
    });
    expect(first.allowed).toBe(true);
    const second = await pilotDialDecision({
      orgId: ORG,
      caseRef,
      caseId: `${PREFIX}app-2`,
      attemptNo: 2,
    });
    expect(second.allowed).toBe(false);
    if (!second.allowed) expect(second.reason).toBe("pilot_human_approval_required");
  });

  slowTest("a decline wins over any earlier approval — every attempt is refused", async () => {
    delete process.env[PILOT_HUMAN_APPROVAL_ENV];
    const caseRef = `${PREFIX}APP-3`;
    await plantApproval(caseRef, ORG, "pilot_dial_approved:1");
    await plantApproval(caseRef, ORG, "pilot_dial_declined");
    const decision = await pilotDialDecision({
      orgId: ORG,
      caseRef,
      caseId: `${PREFIX}app-3`,
      attemptNo: 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("pilot_human_approval_required");
    expect(await pilotDialApproved(caseRef, 1, ORG)).toBe(false);
  });

  slowTest(
    "the status surface reports the whole pilot state without inventing numbers",
    async () => {
      process.env[PILOT_DAILY_CALL_CAP_ENV] = "500";
      _resetPilotSwitchCacheForTest();
      const status = await pilotStatus(ORG);
      expect(status.mode).toBe("live");
      expect(status.dailyCap).toBe(500);
      expect(status.capError).toBeNull();
      expect(status.killSwitch.databaseAvailable).toBe(true);
      expect(status.actedToday).not.toBeNull();
      expect(status.secondsUntilReset).toBeGreaterThanOrEqual(60);
    },
  );
});
