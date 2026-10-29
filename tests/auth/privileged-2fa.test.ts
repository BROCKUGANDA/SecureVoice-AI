/**
 * STEP-UP IS NOT A SECOND FACTOR.
 *
 * `requirePrivileged` demanded a fresh step-up, and step-up accepts a re-entered
 * password or a magic link. So a stolen password — or one shoulder-surfed in a
 * support call — satisfied every privileged action in the product: commit a card
 * freeze, invite an admin, export an organisation's records, rotate a producer
 * key, replace a BYOK credential. The money routes had required a TOTP enrolment
 * since the money gate landed; the more consequential console actions had not.
 *
 * Proven here against the real session store and the real commit route:
 *
 *   1. A stepped-up Owner with NO factor is refused 428 `two_factor_required`.
 *   2. The same account, enrolled, passes.
 *   3. Order is preserved: a factor without a step-up is still `step_up_required`
 *      (the console prompts for the thing it can prompt for).
 *   4. The commit ROUTE refuses a non-enrolled actor and the case remains
 *      FREEZE_STAGED — the freeze did not happen.
 *   5. The demo exemption is shared with the money gate, so the judged
 *      walkthrough still commits its staged freeze.
 *
 *   bun scripts/run-tests.mjs privileged-2fa
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { db } from "@/lib/db";
import { requirePrivileged } from "@/lib/auth/guards";
import { caseByRef, createCase, transitionCase } from "@/lib/case-state-machine";
import { POST as stepUpPOST } from "@/app/api/auth/step-up/route";
import { POST as commitPOST } from "@/app/api/console/freeze/commit/route";
import { TWO_FACTOR_REQUIRED } from "@/lib/auth/two-factor-gate";
import { cleanupRun, makeAccount, makeSession, TEST_PASSWORD, type Fixture } from "./helpers";

const DB_STEP_TIMEOUT_MS = 60_000;

const previousDemoEnv = process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL;
const createdCases: string[] = [];

afterEach(() => {
  if (previousDemoEnv === undefined) delete process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL;
  else process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL = previousDemoEnv;
});

afterAll(async () => {
  if (createdCases.length > 0) {
    await db.case.deleteMany({ where: { caseRef: { in: createdCases } } }).catch(() => {});
  }
  await cleanupRun();
});

/** A session with a fresh step-up, so the factor is the only variable left. */
async function stepped(fixture: Fixture) {
  const session = await makeSession(fixture);
  const res = await stepUpPOST(
    new Request("http://localhost/api/auth/step-up", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    }) as never,
  );
  expect(res.status).toBe(200);
  return session;
}

/** A case parked in FREEZE_STAGED — the only legal commit precondition. */
async function stagedCase(caseRef: string, orgId: string): Promise<void> {
  await createCase({ caseRef, orgId, phone: "+971500000123", language: "en" });
  for (const state of [
    "SCREENED",
    "DIALING",
    "RINGING",
    "ANSWERED",
    "DISCLOSED",
    "VERIFYING",
    "CONFIRMED_FRAUD",
    "FREEZE_STAGED",
  ] as const) {
    await transitionCase(caseRef, state);
  }
}

test(
  "a stepped-up Owner with no second factor is refused, with its own code",
  async () => {
    const owner = await makeAccount("Owner", "p2fa-no-factor", { totp: false });
    const session = await stepped(owner);
    const authed = await requirePrivileged(session.cookie, "commit_freeze");
    expect(authed.ok).toBe(false);
    if (!authed.ok) {
      expect(authed.status).toBe(428);
      expect(authed.code).toBe(TWO_FACTOR_REQUIRED);
      // The hint must be actionable and must name the difference from step-up,
      // or the operator re-enters their password again and nothing changes.
      expect(authed.error).toContain("two-factor");
    }
  },
  DB_STEP_TIMEOUT_MS,
);

test(
  "the same Owner, enrolled, passes the guard",
  async () => {
    const owner = await makeAccount("Owner", "p2fa-enrolled");
    const session = await stepped(owner);
    const authed = await requirePrivileged(session.cookie, "commit_freeze");
    expect(authed.ok).toBe(true);
  },
  DB_STEP_TIMEOUT_MS,
);

test(
  "a factor without a step-up is still step_up_required — order preserved",
  async () => {
    const owner = await makeAccount("Owner", "p2fa-no-stepup");
    const session = await makeSession(owner);
    const authed = await requirePrivileged(session.cookie, "commit_freeze");
    expect(authed.ok).toBe(false);
    if (!authed.ok) expect(authed.code).toBe("step_up_required");
  },
  DB_STEP_TIMEOUT_MS,
);

test(
  "the commit route refuses a non-enrolled actor and the freeze does not happen",
  async () => {
    const owner = await makeAccount("Owner", "p2fa-route", { totp: false });
    const caseRef = `SV-P2FA-${Date.now().toString(36)}`;
    createdCases.push(caseRef);
    await stagedCase(caseRef, owner.orgId);
    const session = await stepped(owner);

    const res = await commitPOST(
      new NextRequest("http://localhost/api/console/freeze/commit", {
        method: "POST",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({ caseRef }),
      }),
    );
    expect(res.status).toBe(428);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe(TWO_FACTOR_REQUIRED);

    const after = await caseByRef(caseRef, owner.orgId);
    expect(after?.state).toBe("FREEZE_STAGED");
  },
  DB_STEP_TIMEOUT_MS,
);

test(
  "the demo exemption covers privileged actions too — one definition, shared",
  async () => {
    const owner = await makeAccount("Owner", "p2fa-demo", { totp: false });
    process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL = owner.email;
    const session = await stepped(owner);
    const authed = await requirePrivileged(session.cookie, "commit_freeze");
    expect(authed.ok).toBe(true);
  },
  DB_STEP_TIMEOUT_MS,
);
