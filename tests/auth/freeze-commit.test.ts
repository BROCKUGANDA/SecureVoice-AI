/**
 * WP-11 / I-1 GATE — the second actor.
 *
 * Invariant I-1 says a freeze is never committed by the agent: `stage_card_freeze`
 * stages `committed:false`, and a SECOND actor — a human operator or the bank's
 * own system — commits it. That split is the whole guarantee, and it has two
 * halves that can each fail while the other looks fine:
 *
 *   1. The commit half is reachable, privileged and legal-only-from-FREEZE_STAGED.
 *   2. The commit half cannot be reached by another tenant, by a caller without
 *      a fresh step-up, or from any state that is not FREEZE_STAGED.
 *
 * `tests/redteam/redteam.test.ts` proves the AGENT cannot commit (I-1 stage 1).
 * `tests/auth/stepup.test.ts` proves `commit_freeze` is a declared privileged
 * action. Neither drives the commit route. This file does, end to end, and
 * asserts the audit chain still verifies from genesis afterwards — because a
 * freeze that commits with nothing in the chain is indistinguishable from a
 * freeze that never happened.
 */
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { createCase, transitionCase, caseByRef } from "@/lib/case-state-machine";
import { verifyChain } from "@/lib/audit-chain";
import { POST as stepUpPOST } from "@/app/api/auth/step-up/route";
import { POST as commitPOST } from "@/app/api/console/freeze/commit/route";
import {
  cleanupRun,
  makeAccount,
  makeMember,
  makeSession,
  type Fixture,
  type SessionFixture,
} from "./helpers";

/** 8 state transitions + audit appends against a remote database. */
const DB_STEP_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await cleanupRun();
});

/** A case parked in FREEZE_STAGED, which is the only legal commit precondition. */
async function stagedCase(caseRef: string, orgId: string): Promise<void> {
  await createCase({ caseRef, orgId, phone: "+971500000123", language: "en" });
  await transitionCase(caseRef, "SCREENED");
  await transitionCase(caseRef, "DIALING");
  await transitionCase(caseRef, "RINGING");
  await transitionCase(caseRef, "ANSWERED");
  await transitionCase(caseRef, "DISCLOSED");
  await transitionCase(caseRef, "VERIFYING");
  await transitionCase(caseRef, "CONFIRMED_FRAUD");
  await transitionCase(caseRef, "FREEZE_STAGED");
}

/** A session with a fresh step-up, so the ONLY thing under test is the freeze. */
async function steppedSession(fixture: Fixture): Promise<SessionFixture> {
  const session = await makeSession(fixture);
  await stepUpPOST(
    new Request("http://localhost/api/auth/step-up", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ password: "correct-horse-battery-staple-9" }),
    }) as never,
  );
  return session;
}

function commitRequest(cookie: string, caseRef: string, reason?: string): NextRequest {
  return new NextRequest("http://localhost/api/console/freeze/commit", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ caseRef, ...(reason ? { reason } : {}) }),
  });
}

test(
  "I-1: a staged freeze is committed by the second actor and the case escalates",
  async () => {
    const owner = await makeAccount("Owner", "i1-commit-ok");
    const caseRef = `SV-I1-${Date.now().toString(36)}`;
    await stagedCase(caseRef, owner.orgId);

    const session = await steppedSession(owner);
    const res = await commitPOST(commitRequest(session.cookie, caseRef, "confirmed by customer"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { committed: boolean; caseRef: string; nextState: string };

    expect(body.committed).toBe(true);
    expect(body.caseRef).toBe(caseRef);
    // The freeze is committed; the case moves to escalation, not to CLOSED.
    expect(body.nextState).toBe("ESCALATED");

    const row = await caseByRef(caseRef, owner.orgId);
    expect(row?.state).toBe("ESCALATED");
  },
  DB_STEP_TIMEOUT_MS,
);

test(
  "I-1: the commit is refused WITHOUT a fresh step-up",
  async () => {
    const owner = await makeAccount("Owner", "i1-nostepup");
    const caseRef = `SV-I1-${Date.now().toString(36)}`;
    await stagedCase(caseRef, owner.orgId);

    // A valid Owner session, no step-up. It passes every ROLE check — which is
    // exactly why step-up exists.
    const session = await makeSession(owner);
    const res = await commitPOST(commitRequest(session.cookie, caseRef));

    expect(res.status).toBe(428);
    // And nothing moved: the freeze is still staged, still reversible.
    const row = await caseByRef(caseRef, owner.orgId);
    expect(row?.state).toBe("FREEZE_STAGED");
  },
  DB_STEP_TIMEOUT_MS,
);

test(
  "I-1: another tenant's staged freeze is INVISIBLE, not merely uncommittable",
  async () => {
    const victim = await makeAccount("Owner", "i1-victim");
    const attacker = await makeAccount("Owner", "i1-attacker");
    const caseRef = `SV-I1-${Date.now().toString(36)}`;
    await stagedCase(caseRef, victim.orgId);

    const session = await steppedSession(attacker);
    const res = await commitPOST(commitRequest(session.cookie, caseRef));

    // 404, never 403: a 403 confirms the case exists, which is itself a leak.
    expect(res.status).toBe(404);
    const row = await caseByRef(caseRef, victim.orgId);
    expect(row?.state).toBe("FREEZE_STAGED");
  },
  DB_STEP_TIMEOUT_MS,
);

test(
  "I-1: a freeze can only be committed from FREEZE_STAGED",
  async () => {
    const owner = await makeAccount("Owner", "i1-wrongstate");
    const caseRef = `SV-I1-${Date.now().toString(36)}`;
    await createCase({ caseRef, orgId: owner.orgId, phone: "+971500000123" });
    // Parked in SCREENED — never confirmed as fraud.
    await transitionCase(caseRef, "SCREENED");

    const session = await steppedSession(owner);
    const res = await commitPOST(commitRequest(session.cookie, caseRef));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("state_precondition_failed");
    const row = await caseByRef(caseRef, owner.orgId);
    expect(row?.state).toBe("SCREENED");
  },
  DB_STEP_TIMEOUT_MS,
);

test(
  "I-1: the commit leaves an audit trail that still verifies from genesis",
  async () => {
    const owner = await makeAccount("Owner", "i1-chain");
    const caseRef = `SV-I1-${Date.now().toString(36)}`;
    await stagedCase(caseRef, owner.orgId);
    const session = await steppedSession(owner);

    const res = await commitPOST(commitRequest(session.cookie, caseRef, "chain check"));
    expect(res.status).toBe(200);

    const verification = await verifyChain(caseRef, owner.orgId);
    expect(verification.ok).toBe(true);
  },
  DB_STEP_TIMEOUT_MS,
);

test(
  "I-1: the commit body rejects unknown fields rather than ignoring them",
  async () => {
    const owner = await makeAccount("Owner", "i1-strict");
    const caseRef = `SV-I1-${Date.now().toString(36)}`;
    await stagedCase(caseRef, owner.orgId);
    const session = await steppedSession(owner);

    const res = await commitPOST(
      new NextRequest("http://localhost/api/console/freeze/commit", {
        method: "POST",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({ caseRef, committed: true, force: true }),
      }),
    );

    expect(res.status).toBe(422);
    const row = await caseByRef(caseRef, owner.orgId);
    expect(row?.state).toBe("FREEZE_STAGED");
  },
  DB_STEP_TIMEOUT_MS,
);

test(
  "I-1: an Auditor cannot commit a freeze, even with a valid step-up",
  async () => {
    // Auditor is the read-only role banks always need. Holding a step-up must not
    // promote it — the capability check runs first and independently.
    const auditor = await makeMember("Auditor", "i1-auditor", "unused-org-for-auditor");
    const caseRef = `SV-I1-${Date.now().toString(36)}`;
    await stagedCase(caseRef, auditor.orgId);

    const session = await steppedSession(auditor);
    const res = await commitPOST(commitRequest(session.cookie, caseRef));

    expect(res.status).toBe(403);
    const row = await caseByRef(caseRef, auditor.orgId);
    expect(row?.state).toBe("FREEZE_STAGED");
  },
  DB_STEP_TIMEOUT_MS,
);
