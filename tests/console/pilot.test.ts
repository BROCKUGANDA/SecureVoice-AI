/**
 * GATE — the pilot-mode console surface: status, kill switch, per-dial approvals.
 *
 * `src/lib/pilot/mode.ts` and `src/lib/pilot/gate.ts` already enforce the
 * charter at ingest and at the dial moment. This suite proves the OPERATOR
 * half of the same control: the console routes a person can reach during an
 * incident. The properties under test are the ones an incident looks for:
 *
 *   1. **The switch is a platform lever.** An admin of one bank must get 403
 *      from the kill-switch route even though they are a legitimate operator —
 *      a tenant-flippable global switch is a lockout waiting to happen
 *      (migration header: `prisma/migrations/9zzz...platform_switch`).
 *   2. **Every engage and release is audited.** The 03:00 change is a recorded
 *      change; an engaged switch with no audit row is a finding, not a feature.
 *   3. **The switching half works against the REAL database.** The env half of
 *      the switch is covered by `tests/unit/pilot-mode.test.ts`; this suite
 *      flips the DB row and reads back through `pilotStatus`, the same query a
 *      worker performs within its five-second cache window.
 *   4. **The per-dial approval is tenant-scoped and audited.** A foreign
 *      caseRef gets the SAME 404 a missing one gets (no oracle), an approval
 *      lands an attempt-bound row in the append-only chain that
 *      `pilotDialDecision` then honours, and a decline stops the pending
 *      dial jobs instead of merely writing a note.
 *   5. **Anonymous and non-operator callers are refused everywhere.**
 *
 *   bun test tests/console/pilot.test.ts
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import * as realCredits from "@/lib/credits";

const TIMEOUT_MS = 60_000;
function slowTest(name: string, fn: () => Promise<void> | void) {
  test(name, fn, TIMEOUT_MS);
}

const ORG = `0e0e0e0e-0000-4000-8000-${createHash("sha256")
  .update("pilot-console-a")
  .digest("hex")
  .slice(0, 12)}`;
const OTHER_ORG = `0e0e0e0e-0000-4000-8000-${createHash("sha256")
  .update("pilot-console-b")
  .digest("hex")
  .slice(0, 12)}`;
const OPERATOR_ID = `00000000-0000-4000-8000-${createHash("sha256")
  .update("pilot-console-user")
  .digest("hex")
  .slice(0, 12)}`;

type Session = {
  signedIn: boolean;
  role: "operator" | "demo";
  orgId: string | null;
  userId: string;
};
const session: Session = {
  signedIn: true,
  role: "operator",
  orgId: null,
  userId: OPERATOR_ID,
};

mock.module("@/lib/credits", () => ({
  ...realCredits,
  getProfile: async () =>
    session.signedIn
      ? {
          userId: session.userId,
          email: "pilot@securevoice.ae",
          name: "Pilot Console Gate",
          role: session.role,
          orgId: session.orgId,
          credits: 500,
          walletScope: (session.orgId ? "org" : "user") as "org" | "user",
        }
      : null,
}));

const { GET: getPilot } = await import("@/app/api/console/pilot/route");
const { POST: postKillSwitch } = await import("@/app/api/console/pilot/kill-switch/route");
const { POST: postApproval } = await import("@/app/api/console/pilot/approvals/route");
const {
  DIAL_KILL_SWITCH_NAME,
  _resetPilotSwitchCacheForTest,
  pilotDialApproved,
  pilotApprovalIntent,
} = await import("@/lib/pilot/mode");

function jsonPost(url: string, body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readJson(res: Response) {
  return (await res.json().catch(() => ({}))) as Record<string, never> & {
    error?: string;
    pilot?: {
      mode: string;
      killSwitch: { engaged: boolean; env: boolean; database: boolean; databaseAvailable: boolean };
      dailyCap: number | null;
      /**
       * What this session may actually DO, derived from the same guards the
       * writers use: the kill switch is platform-wide (operator AND no active
       * organisation), the per-dial approval is per-tenant (operator AND an
       * organisation).
       */
      canFlipKillSwitch: boolean;
      canApprove: boolean;
      /** The cases whose next dial is waiting for a HUMAN. */
      waiting: Array<{ caseRef: string; attemptNo: number }>;
      waitingCount: number;
    };
    switch?: { name: string; engaged: boolean; updatedAt: string };
    caseRef?: string;
    decision?: string;
    attemptNo?: number;
    approved?: boolean;
    jobsReleased?: number;
    jobsStopped?: number;
  };
}

const CASE_REF_OWN = "SV-PCON-000001";
const CASE_REF_FOREIGN = "SV-PCON-000002";
const CASE_REF_MISSING = "SV-PCON-999999";
const CASE_REF_PREFIX = "SV-PCON-";

beforeAll(async () => {
  // The dial switch ships EMPTY by design; make sure prior runs left nothing.
  await db.platformSwitch.deleteMany({ where: { name: DIAL_KILL_SWITCH_NAME } });
  _resetPilotSwitchCacheForTest();
  await db.case.createMany({
    data: [
      { caseRef: CASE_REF_OWN, orgId: ORG, language: "en" },
      { caseRef: CASE_REF_FOREIGN, orgId: OTHER_ORG, language: "en" },
    ],
  });
});

afterAll(async () => {
  // Restore the shipped state: an EMPTY switch table, no pilot test cases, no
  // pilot audit rows. A test that leaves the kill switch ENGAGED would stop
  // every dial on whatever database the next run uses. The switch rows and
  // this suite's own audit rows (matched by this suite's operator id) are
  // removed by hand, because the audit chain is append-only from the app's
  // point of view and the test database is the ONE place rows are allowed to
  // be cleared.
  await db.platformSwitch.deleteMany({ where: { name: DIAL_KILL_SWITCH_NAME } });
  _resetPilotSwitchCacheForTest();
  await db.dialJob.deleteMany({ where: { caseRef: { startsWith: CASE_REF_PREFIX } } });
  await db.case.deleteMany({ where: { caseRef: { startsWith: CASE_REF_PREFIX } } });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { callRef: { startsWith: CASE_REF_PREFIX } },
        {
          callerId: OPERATOR_ID,
          intent: {
            in: [
              "dial_kill_switch_engaged",
              "dial_kill_switch_released",
              "pilot_dial_approved",
              "pilot_dial_declined",
            ],
          },
        },
      ],
    },
  });
  await db.$disconnect();
});

describe("GET /api/console/pilot — status", () => {
  slowTest("anonymous session gets 401", async () => {
    session.signedIn = false;
    try {
      const res = await getPilot();
      expect(res.status).toBe(401);
    } finally {
      session.signedIn = true;
    }
  });

  slowTest(
    "a demo badge reads the status too — status is informational, levers are guarded",
    async () => {
      const before = session.role;
      session.role = "demo";
      try {
        const res = await getPilot();
        expect(res.status).toBe(200);
        const body = await readJson(res);
        expect(body.pilot).toBeTruthy();
      } finally {
        session.role = before;
      }
    },
  );

  slowTest("a signed-in specialist reads the pilot status without an org predicate", async () => {
    session.orgId = ORG;
    try {
      const res = await getPilot();
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.pilot).toBeTruthy();
      expect(body.pilot!.mode).toBe("off"); // unset PILOT_MODE is "off"
      expect(body.pilot!.killSwitch.engaged).toBe(false);
      expect(body.pilot!.killSwitch.databaseAvailable).toBe(true);
      // The kill switch is PLATFORM-wide, so a tenant-scoped operator must be
      // told they cannot flip it — the console shows the button only when the
      // caller may, and a control that answers 403 teaches people the console
      // is lying.
      expect(body.pilot!.canFlipKillSwitch).toBe(false);
    } finally {
      session.orgId = null;
    }
  });

  slowTest("an org-less session MAY flip the platform kill switch", async () => {
    session.orgId = null;
    try {
      const res = await getPilot();
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.pilot!.canFlipKillSwitch).toBe(true);
    } finally {
      session.orgId = null;
    }
  });

  slowTest("the status lists the cases waiting for a human decision", async () => {
    // Phase 1's defining rule is "a human approves every dial", so the queue of
    // cases waiting for that approval IS the pilot's work item. A case is
    // waiting when it has a PENDING dial job and no approval row for the
    // attempt that job is on.
    session.orgId = ORG;
    const caseRef = `PILOT-WAIT-${Date.now().toString(36).toUpperCase()}`;
    await db.$executeRawUnsafe(
      `INSERT INTO "dial_job" (id, case_id, case_ref, org_id, attempt_no, retries, state, priority, payload, available_at, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 1, 0, 'PENDING', 0, '{}', now(), now(), now())`,
      caseRef,
      caseRef,
      ORG,
    );
    try {
      const res = await getPilot();
      const body = await readJson(res);
      const waiting = body.pilot!.waiting ?? [];
      expect(
        waiting.some((w: { caseRef: string }) => w.caseRef === caseRef),
        `the waiting case is not listed: ${JSON.stringify(waiting)}`,
      ).toBe(true);
      expect(body.pilot!.waitingCount).toBeGreaterThan(0);
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM "dial_job" WHERE "case_ref" = $1`, caseRef);
      session.orgId = null;
    }
  });

  slowTest("an APPROVED case is NOT on the waiting list", async () => {
    // The negative half of the assertion above, and the half that matters
    // most: a list that never shrinks is a console that cannot be believed.
    //
    // The approval intent has to be EXACTLY what the writer produces —
    // `pilot_dial_approved:1` — because the reader matches on it. A reader
    // that looked for a different spelling matched nothing, listed the whole
    // PENDING backlog as "waiting", and could never clear the list.
    session.orgId = ORG;
    const caseRef = `PILOT-DONE-${Date.now().toString(36).toUpperCase()}`;
    await db.$executeRawUnsafe(
      `INSERT INTO "dial_job" (id, case_id, case_ref, org_id, attempt_no, retries, state, priority, payload, available_at, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 1, 0, 'PENDING', 0, '{}', now(), now(), now())`,
      caseRef,
      caseRef,
      ORG,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "AuditLog" (id, "callRef", action, intent, "callerId", "chainHash", "orgId", "createdAt")
       VALUES (gen_random_uuid()::text, $1, 'pilot', $2, 'test', $3, $4, now())`,
      caseRef,
      pilotApprovalIntent(1),
      `probe-${caseRef}`,
      ORG,
    );
    try {
      const res = await getPilot();
      const body = await readJson(res);
      const waiting = body.pilot!.waiting ?? [];
      expect(
        waiting.some((w: { caseRef: string }) => w.caseRef === caseRef),
        `an approved case is still on the waiting list: ${JSON.stringify(waiting)}`,
      ).toBe(false);
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "callRef" = $1`, caseRef);
      await db.$executeRawUnsafe(`DELETE FROM "dial_job" WHERE "case_ref" = $1`, caseRef);
      session.orgId = null;
    }
  });

  slowTest("a case parked by the CAP is not on a human's desk", async () => {
    // The cap is a SYSTEM's decision, not a person's. Listing a job the cap is
    // holding as "waiting for a decision" invites an operator to approve
    // something the volume ceiling has already refused.
    session.orgId = ORG;
    const caseRef = `PILOT-CAPPED-${Date.now().toString(36).toUpperCase()}`;
    await db.$executeRawUnsafe(
      `INSERT INTO "dial_job" (id, case_id, case_ref, org_id, attempt_no, retries, state, priority, payload, available_at, created_at, updated_at, "last_error")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 1, 0, 'PENDING', 0, '{}', now(), now(), now(), $4)`,
      caseRef,
      caseRef,
      ORG,
      "pilot_blocked:pilot_daily_cap",
    );
    try {
      const res = await getPilot();
      const body = await readJson(res);
      const waiting = body.pilot!.waiting ?? [];
      expect(
        waiting.some((w: { caseRef: string }) => w.caseRef === caseRef),
        `a cap-parked case is on the waiting list: ${JSON.stringify(waiting)}`,
      ).toBe(false);
    } finally {
      await db.$executeRawUnsafe(`DELETE FROM "dial_job" WHERE "case_ref" = $1`, caseRef);
      session.orgId = null;
    }
  });
});

describe("POST /api/console/pilot/kill-switch — the incident lever", () => {
  slowTest("anonymous gets 401", async () => {
    session.signedIn = false;
    try {
      const res = await postKillSwitch(
        jsonPost("/api/console/pilot/kill-switch", { engaged: true }),
      );
      expect(res.status).toBe(401);
    } finally {
      session.signedIn = true;
    }
  });

  slowTest("a tenant operator is refused — the switch is platform-wide", async () => {
    session.orgId = ORG;
    try {
      const res = await postKillSwitch(
        jsonPost("/api/console/pilot/kill-switch", { engaged: true }),
      );
      expect(res.status).toBe(403);
      const body = await readJson(res);
      expect(String(body.error ?? "")).toContain("Platform operator");
      const engaged = await db.platformSwitch.findUnique({
        where: { name: DIAL_KILL_SWITCH_NAME },
      });
      expect(engaged, "a refused call must not touch the switch row").toBeNull();
    } finally {
      session.orgId = null;
    }
  });

  slowTest("engage → release round-trips through the real database and is audited", async () => {
    const engage = await postKillSwitch(
      jsonPost("/api/console/pilot/kill-switch", { engaged: true, reason: "console gate drill" }),
    );
    expect(engage.status).toBe(200);
    const engagedBody = await readJson(engage);
    expect(engagedBody.switch?.engaged).toBe(true);
    expect(engagedBody.switch?.name).toBe(DIAL_KILL_SWITCH_NAME);

    _resetPilotSwitchCacheForTest();
    const status = await readJson(await getPilot());
    expect(status.pilot?.killSwitch.engaged).toBe(true);
    expect(status.pilot?.killSwitch.database).toBe(true);

    const auditRow = await db.auditLog.findFirst({
      where: { intent: "dial_kill_switch_engaged", action: "pilot", callerId: OPERATOR_ID },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).toBeTruthy();

    const release = await postKillSwitch(
      jsonPost("/api/console/pilot/kill-switch", {
        engaged: false,
        reason: "console gate drill ended",
      }),
    );
    expect(release.status).toBe(200);
    _resetPilotSwitchCacheForTest();
    const after = await readJson(await getPilot());
    expect(after.pilot?.killSwitch.engaged).toBe(false);

    const releasedRow = await db.auditLog.findFirst({
      where: { intent: "dial_kill_switch_released", action: "pilot", callerId: OPERATOR_ID },
      orderBy: { createdAt: "desc" },
    });
    expect(releasedRow).toBeTruthy();
  });

  slowTest("a malformed body is 422 and leaves the switch unengaged", async () => {
    const res = await postKillSwitch(
      jsonPost("/api/console/pilot/kill-switch", { engaged: "yes" }),
    );
    expect(res.status).toBe(422);
    _resetPilotSwitchCacheForTest();
    const status = await readJson(await getPilot());
    expect(status.pilot?.killSwitch.engaged).toBe(false);
  });
});

describe("POST /api/console/pilot/approvals — the per-dial human decision", () => {
  slowTest("a platform operator without an org is 400 — approvals are org work", async () => {
    const res = await postApproval(
      jsonPost("/api/console/pilot/approvals", { caseRef: CASE_REF_OWN, decision: "approve" }),
    );
    expect(res.status).toBe(400);
  });

  slowTest("outside live mode the route refuses with 409 — no silent parking", async () => {
    session.orgId = ORG;
    delete process.env.PILOT_MODE;
    try {
      const res = await postApproval(
        jsonPost("/api/console/pilot/approvals", { caseRef: CASE_REF_OWN, decision: "approve" }),
      );
      expect(res.status).toBe(409);
    } finally {
      session.orgId = null;
    }
  });

  slowTest("a foreign case gets the same 404 a missing one gets — no oracle", async () => {
    session.orgId = ORG;
    process.env.PILOT_MODE = "live";
    try {
      const foreign = await postApproval(
        jsonPost("/api/console/pilot/approvals", {
          caseRef: CASE_REF_FOREIGN,
          decision: "approve",
        }),
      );
      expect(foreign.status).toBe(404);
      const missing = await postApproval(
        jsonPost("/api/console/pilot/approvals", {
          caseRef: CASE_REF_MISSING,
          decision: "approve",
        }),
      );
      expect(missing.status).toBe(404);
      const leaked = await db.auditLog.findFirst({
        where: {
          callRef: { in: [CASE_REF_FOREIGN, CASE_REF_MISSING] },
          intent: { startsWith: "pilot_dial" },
        },
      });
      expect(leaked, "a refused decision must not write an audit row").toBeNull();
    } finally {
      delete process.env.PILOT_MODE;
      session.orgId = null;
    }
  });

  slowTest("approve records an attempt-bound decision the dial gate will honour", async () => {
    session.orgId = ORG;
    process.env.PILOT_MODE = "live";
    try {
      const res = await postApproval(
        jsonPost("/api/console/pilot/approvals", {
          caseRef: CASE_REF_OWN,
          decision: "approve",
          note: "fraud desk cleared 14:05",
        }),
      );
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.approved).toBe(true);
      // No dial jobs exist for this case, so the queue's answer is attempt 1.
      expect(body.attemptNo).toBe(1);
      // The exact predicate `pilotDialDecision` uses for this attempt.
      expect(await pilotDialApproved(CASE_REF_OWN, 1, ORG)).toBe(true);
    } finally {
      delete process.env.PILOT_MODE;
      session.orgId = null;
    }
  });

  slowTest("decline dead-letters the pending dial and is recorded", async () => {
    session.orgId = ORG;
    process.env.PILOT_MODE = "live";
    try {
      // A PENDING job in the queue, so the decline has something to stop.
      await db.dialJob.create({
        data: {
          caseRef: CASE_REF_OWN,
          caseId: "00000000-0000-4000-8000-pconjob00001",
          orgId: ORG,
          payload: JSON.stringify({ probe: true }),
        },
      });

      const res = await postApproval(
        jsonPost("/api/console/pilot/approvals", { caseRef: CASE_REF_OWN, decision: "decline" }),
      );
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.approved).toBe(false);
      expect(body.jobsStopped).toBe(1);
      expect(body.attemptNo).toBe(1);

      const job = await db.dialJob.findFirst({ where: { caseRef: CASE_REF_OWN } });
      expect(job?.state).toBe("DEAD");
      expect(job?.lastError).toContain("pilot_dial_declined");

      const declined = await db.auditLog.findFirst({
        where: { callRef: CASE_REF_OWN, intent: "pilot_dial_declined" },
      });
      expect(declined).toBeTruthy();
    } finally {
      delete process.env.PILOT_MODE;
      session.orgId = null;
    }
  });

  slowTest("a malformed decision is 422", async () => {
    session.orgId = ORG;
    process.env.PILOT_MODE = "live";
    try {
      const res = await postApproval(
        jsonPost("/api/console/pilot/approvals", { caseRef: CASE_REF_OWN, decision: "maybe" }),
      );
      expect(res.status).toBe(422);
    } finally {
      delete process.env.PILOT_MODE;
      session.orgId = null;
    }
  });
});
