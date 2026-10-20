/**
 * GATE — `src/lib/pilot/gate.ts`: the intake half of the pilot charter.
 *
 * A signal that becomes a case must pass this gate BEFORE the dial job is
 * created (`src/app/api/v1/interventions/route.ts:674` calls `runPilotGate`
 * after the legal preconditions and before the abuse gate). The properties
 * under test:
 *
 *   · **off mode is a no-op with no cost.** One boolean read, no database.
 *   · **shadow ACCEPTS and marks `shadow: true`** — Phase 0 records the case,
 *     and it is the CALLER's job not to contact anyone (the dial path enforces
 *     that with `pilotDialDecision`).
 *   · **the charter fails closed on an untyped signal.** `signal_kind` is
 *     optional in the bank contract, so the untyped alert is the common case,
 *     and "cannot show it is in scope" must not read as "it is in scope".
 *   · **a malformed cap is a distinct refusal** — `pilot_cap_misconfigured`,
 *     not `pilot_daily_cap_reached`, because the remediation the bank would
 *     apply for "cap reached" (wait for tomorrow) is wrong for a configuration
 *     fault.
 *   · **the exact same counter the dial decision uses.** A daily cap that
 *     counts one way at ingest and another at the dial moment is no cap.
 *   · **live mode does NOT require the human approval at ingest** — the per-
 *     dial approval lives at the dial boundary, and the intake gate creating
 *     a second approval check would be an invisible second way to call.
 *
 * Env mutations are restored; DB rows (dial_job) are cleaned by prefix.
 *
 *   bun test tests/unit/pilot-gate.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { assertPilotAllowsEnqueue, PilotRefusalError, runPilotGate } from "@/lib/pilot/gate";
import {
  DIAL_KILL_SWITCH_NAME,
  PILOT_DAILY_CALL_CAP_ENV,
  PILOT_MODE_ENV,
  PILOT_SIGNAL_KIND_ENV,
} from "@/lib/pilot/mode";

const TIMEOUT_MS = 60_000;
function slowTest(name: string, fn: () => Promise<void> | void) {
  test(name, fn, TIMEOUT_MS);
}

const PREFIX = "SV-PGT-";
const ORG = `10101010-0000-4000-8000-${createHash("sha256")
  .update("PGT-a")
  .digest("hex")
  .slice(0, 12)}`;

const savedEnv: Record<string, string | undefined> = {};
for (const name of [PILOT_MODE_ENV, PILOT_SIGNAL_KIND_ENV, PILOT_DAILY_CALL_CAP_ENV]) {
  savedEnv[name] = process.env[name];
}

beforeAll(async () => {
  await db.platformSwitch.deleteMany({ where: { name: DIAL_KILL_SWITCH_NAME } });
});

afterAll(async () => {
  await db.dialJob.deleteMany({ where: { caseRef: { startsWith: PREFIX } } });
  for (const name of [PILOT_MODE_ENV, PILOT_SIGNAL_KIND_ENV, PILOT_DAILY_CALL_CAP_ENV]) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  await db.$disconnect();
});

describe("runPilotGate — off and shadow", () => {
  slowTest("off mode accepts without reading anything", async () => {
    delete process.env.PILOT_MODE;
    const result = await runPilotGate({ orgId: ORG, signalKind: "anything" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe("off");
  });

  slowTest(
    "shadow accepts with shadow: true so the caller records without touching a customer",
    async () => {
      process.env.PILOT_MODE = "shadow";
      const result = await runPilotGate({ orgId: ORG, signalKind: "anything" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.mode).toBe("shadow");
        expect(result.shadow).toBe(true);
      }
    },
  );
});

describe("runPilotGate — live mode: the charter", () => {
  slowTest("an out-of-scope alert type is refused, not deferred", async () => {
    process.env.PILOT_MODE = "live";
    process.env[PILOT_SIGNAL_KIND_ENV] = "card_transaction_fraud";
    const result = await runPilotGate({
      orgId: ORG,
      signalKind: "claim_payout",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("pilot_signal_kind_out_of_scope");
      expect(result.reason).toContain("claim_payout");
    }
  });

  slowTest("an UNTYPED signal is out of scope — the common case stays bounded", async () => {
    process.env.PILOT_MODE = "live";
    process.env[PILOT_SIGNAL_KIND_ENV] = "card_transaction_fraud";
    const result = await runPilotGate({ orgId: ORG, signalKind: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("pilot_signal_kind_out_of_scope");
  });

  slowTest("no charter restriction means no scope refusal", async () => {
    process.env.PILOT_MODE = "live";
    delete process.env[PILOT_SIGNAL_KIND_ENV];
    const result = await runPilotGate({ orgId: ORG, signalKind: "claim_payout" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.shadow).toBe(false);
  });

  slowTest("a malformed cap is its OWN refusal kind", async () => {
    process.env.PILOT_MODE = "live";
    process.env[PILOT_DAILY_CALL_CAP_ENV] = "twelve";
    const result = await runPilotGate({ orgId: ORG });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("pilot_cap_misconfigured");
      expect(result.reason).not.toContain("contracted"); // not worded as a volume event
    }
  });

  slowTest("the daily cap refuses at ingest using the SAME counter the dial uses", async () => {
    process.env.PILOT_MODE = "live";
    process.env[PILOT_DAILY_CALL_CAP_ENV] = "1";
    // One dial_job row for a DIFFERENT case today → the org has acted on 1
    // intervention, which is the whole cap.
    await db.dialJob.create({
      data: { caseRef: `${PREFIX}CAP1`, caseId: `${PREFIX}cap1`, orgId: ORG, payload: "{}" },
    });
    const result = await runPilotGate({ orgId: ORG });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("pilot_daily_cap_reached");
      expect(result.reason).toContain("1"); // the contracted number is in the wording
    }
  });

  slowTest(
    "under the cap, live mode accepts WITHOUT asking for the per-dial approval",
    async () => {
      process.env.PILOT_MODE = "live";
      delete process.env[PILOT_DAILY_CALL_CAP_ENV];
      const result = await runPilotGate({ orgId: ORG });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.shadow).toBe(false); // approval happens at the dial boundary
    },
  );
});

describe("assertPilotAllowsEnqueue — the throwing choke point", () => {
  slowTest("a refusal THROWS PilotRefusalError with the gate's code", async () => {
    process.env.PILOT_MODE = "live";
    process.env[PILOT_SIGNAL_KIND_ENV] = "card_transaction_fraud";
    let caught: unknown = null;
    try {
      await assertPilotAllowsEnqueue({ orgId: ORG, signalKind: "claim_payout" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PilotRefusalError);
    if (caught instanceof PilotRefusalError) {
      expect(caught.code).toBe("pilot_signal_kind_out_of_scope");
      expect(caught.status).toBe(409);
    }
  });

  slowTest("a pass returns silently", async () => {
    process.env.PILOT_MODE = "off";
    await expect(assertPilotAllowsEnqueue({ orgId: ORG })).resolves.toBeUndefined();
  });
});
