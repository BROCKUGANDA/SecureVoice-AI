/**
 * WP-11 GATE — step-up re-authentication for the five privileged actions.
 *
 * The brief names five: commit a freeze, rotate a producer key, change a BYOK
 * credential, invite an admin, export bulk data. For each one this file asserts
 * BOTH halves of the control:
 *
 *   1. REFUSED without a fresh step-up (428 step_up_required)
 *   2. ALLOWED with a fresh step-up
 *
 * A test that only asserted (2) would pass against a control that does not
 * exist, and a test that only asserted (1) would pass against one that refuses
 * everything. Both are asserted for all five, which is what makes the pair a
 * control rather than a wall.
 *
 * ── Why step-up is not just a second role check ──────────────────────────────
 * A stolen Admin cookie is a perfectly valid Admin session: it passes every role
 * check. Only re-presenting a credential the cookie does not contain
 * distinguishes the person at the keyboard from the person who logged in earlier.
 * That is what these tests exercise, and the grant is deliberately bound to the
 * SESSION so it cannot be lifted to another one.
 */

import { afterAll, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { issueStepUp, requireStepUp, currentStepUp } from "@/lib/auth/stepup";
import { requireAuth, requirePrivileged } from "@/lib/auth/guards";
import {
  PRIVILEGED_ACTIONS,
  PRIVILEGED_ACTION_CAPABILITY,
  type PrivilegedAction,
} from "@/lib/auth/roles";
import { STEP_UP_WINDOW_MS } from "@/lib/auth/constants";
import { POST as stepUpPOST } from "@/app/api/auth/step-up/route";
import { POST as invitesPOST } from "@/app/api/auth/invites/route";
import { GET as exportGET } from "@/app/api/auth/export/route";
import { cleanupRun, makeAccount, makeMember, makeSession, TEST_PASSWORD } from "./helpers";

afterAll(async () => {
  await cleanupRun();
});

/**
 * A role that holds the capability for a given action, so the step-up is
 * genuinely the only thing missing. Using an Owner for all five keeps that true:
 * Owner holds every capability, so (1) can only be about the step-up.
 */
const SUFFICIENT_ROLE = "Owner" as const;

// ── Every privileged action needs one ────────────────────────────────────────

test("the five privileged actions are exactly the ones the brief names", () => {
  expect([...PRIVILEGED_ACTIONS].sort()).toEqual(
    [
      "change_byok_credential",
      "commit_freeze",
      "export_bulk_data",
      "invite_admin",
      "rotate_producer_key",
    ].sort()
  );
});

test("every privileged action maps to a real capability", () => {
  for (const action of PRIVILEGED_ACTIONS) {
    expect(PRIVILEGED_ACTION_CAPABILITY[action]).toBeTruthy();
  }
});

test("the step-up window is short", () => {
  // Five minutes. If this is ever raised to hours, step-up stops distinguishing
  // "the person at the keyboard" from "the person who was at the keyboard
  // earlier in the session".
  expect(STEP_UP_WINDOW_MS).toBe(5 * 60 * 1000);
});

// ── Per-action: refused without, allowed with ────────────────────────────────

/** For one action: a permitted role with no step-up is refused, and one with a
 *  fresh step-up is allowed. */
async function assertActionGated(
  action: PrivilegedAction,
  capability: keyof typeof PRIVILEGED_ACTION_CAPABILITY
) {
  // ── (1) refused without a step-up ──
  const withoutGrant = await makeAccount(SUFFICIENT_ROLE, `nogate-${action}`);
  const gated = await makeSession(withoutGrant);
  const denied = await requirePrivileged(gated.cookie, action);
  expect(denied.ok).toBe(false);
  if (denied.ok) throw new Error("unreachable");
  // 428, not 403: the role IS permitted; a precondition is unmet.
  expect(denied.status).toBe(428);
  expect(denied.code).toBe("step_up_required");
  void capability;

  // ── (2) allowed with a fresh step-up ──
  const withGrant = await makeAccount(SUFFICIENT_ROLE, `gate-${action}`);
  const primed = await makeSession(withGrant);
  const authed = await requireAuth(primed.cookie);
  expect(authed.ok).toBe(true);
  if (!authed.ok) throw new Error("unreachable");
  await issueStepUp(authed.session, { ok: true }, "password");

  const allowed = await requirePrivileged(primed.cookie, action);
  expect(allowed.ok).toBe(true);
}

test("commit_freeze requires a fresh step-up", async () => {
  await assertActionGated("commit_freeze", "case:write");
});

test("rotate_producer_key requires a fresh step-up", async () => {
  await assertActionGated("rotate_producer_key", "producerKey:rotate");
});

test("change_byok_credential requires a fresh step-up", async () => {
  await assertActionGated("change_byok_credential", "byok:change");
});

test("invite_admin requires a fresh step-up", async () => {
  await assertActionGated("invite_admin", "member:invite");
});

test("export_bulk_data requires a fresh step-up", async () => {
  await assertActionGated("export_bulk_data", "export:bulk");
});

// ── The grant itself ─────────────────────────────────────────────────────────

test("a granted step-up is recorded and readable for this session", async () => {
  const owner = await makeAccount("Owner", "owner");
  const session = await makeSession(owner);
  const authed = await requireAuth(session.cookie);
  if (!authed.ok) throw new Error("unreachable");

  expect(await currentStepUp(authed.session)).toBeNull();

  await issueStepUp(authed.session, { ok: true }, "password");

  const grant = await currentStepUp(authed.session);
  expect(grant).not.toBeNull();
  expect(grant?.method).toBe("password");
  expect(typeof grant?.at).toBe("number");
});

test("a step-up EXPIRES after its window", async () => {
  const owner = await makeAccount("Owner", "owner");
  const session = await makeSession(owner);
  const authed = await requireAuth(session.cookie);
  if (!authed.ok) throw new Error("unreachable");

  await issueStepUp(authed.session, { ok: true }, "password");
  // Freshly granted → allowed.
  expect((await requireStepUp(authed.session, "invite_admin")).ok).toBe(true);

  // Past the window → refused. The window is the control; a grant that never
  // expires would let one re-authentication authorise hours of actions.
  const later = Date.now() + STEP_UP_WINDOW_MS + 1000;
  const expired = await requireStepUp(authed.session, "invite_admin", later);
  expect(expired.ok).toBe(false);
  if (expired.ok) throw new Error("unreachable");
  expect(expired.reason).toBe("step_up_required");
});

test("a step-up is bound to the SESSION and does not transfer to another", async () => {
  const owner = await makeAccount("Owner", "owner");
  const first = await makeSession(owner);
  const second = await makeSession(owner);

  const authedFirst = await requireAuth(first.cookie);
  if (!authedFirst.ok) throw new Error("unreachable");
  await issueStepUp(authedFirst.session, { ok: true }, "password");

  // Granted on session one…
  expect((await requireStepUp(authedFirst.session, "invite_admin")).ok).toBe(true);

  // …does not authorise session two. Otherwise an attacker who compromises a
  // second session inherits the victim's re-authentication.
  const authedSecond = await requireAuth(second.cookie);
  if (!authedSecond.ok) throw new Error("unreachable");
  const stolen = await requireStepUp(authedSecond.session, "invite_admin");
  expect(stolen.ok).toBe(false);
});

test("a step-up is destroyed when a role change revokes the session", async () => {
  const owner = await makeAccount("Owner", "owner");
  const admin = await makeMember("Admin", "admin", owner.orgId);
  const session = await makeSession(admin);

  const authed = await requireAuth(session.cookie);
  if (!authed.ok) throw new Error("unreachable");
  await issueStepUp(authed.session, { ok: true }, "password");
  expect((await requireStepUp(authed.session, "invite_admin")).ok).toBe(true);

  const { setRole } = await import("@/lib/auth/identity");
  const { AUTH_AUDIT_INTENTS, auditAuthEventRequired } = await import("@/lib/auth/audit");
  await setRole(admin.identity.accountId, owner.orgId, "Auditor", async () =>
    auditAuthEventRequired({
      intent: AUTH_AUDIT_INTENTS.roleChanged,
      actorId: owner.identity.accountId,
      orgId: owner.orgId,
      note: "demoted",
    })
  );

  // The session is dead, so the grant it carried is unreachable — the grant is
  // not a bearer token of its own.
  const after = await requireAuth(session.cookie);
  expect(after.ok).toBe(false);
});

test("a failed re-authentication does not grant a step-up", async () => {
  const owner = await makeAccount("Owner", "owner");
  const session = await makeSession(owner);
  const authed = await requireAuth(session.cookie);
  if (!authed.ok) throw new Error("unreachable");

  const result = await issueStepUp(
    authed.session,
    { ok: false, error: "That password is not correct." },
    "password"
  );
  expect("ok" in result && result.ok === false).toBe(true);
  expect(await currentStepUp(authed.session)).toBeNull();
  expect((await requireStepUp(authed.session, "invite_admin")).ok).toBe(false);
});

test("an unknown action name is refused rather than defaulted to allowed", async () => {
  const owner = await makeAccount("Owner", "owner");
  const session = await makeSession(owner);
  const authed = await requireAuth(session.cookie);
  if (!authed.ok) throw new Error("unreachable");
  await issueStepUp(authed.session, { ok: true }, "password");

  const bogus = await requireStepUp(
    authed.session,
    "just_do_it" as PrivilegedAction
  );
  expect(bogus.ok).toBe(false);
  if (bogus.ok) throw new Error("unreachable");
  expect(bogus.reason).toBe("not_a_privileged_action");
});

// ── The route: a fresh credential really unlocks the action ─────────────────

test("POST /api/auth/step-up with the real password unlocks a gated route", async () => {
  const owner = await makeAccount("Owner", "owner");
  const session = await makeSession(owner);

  // Before: refused.
  const before = await invitesPOST(
    new Request("http://t/api/auth/invites", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: `stepup-${Date.now()}@wp11.test`, role: "Analyst" }),
    })
  );
  expect(before.status).toBe(428);

  // Re-authenticate with the actual password.
  const stepped = await stepUpPOST(
    new Request("http://t/api/auth/step-up", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    })
  );
  expect(stepped.status).toBe(200);

  // After: allowed.
  const after = await invitesPOST(
    new Request("http://t/api/auth/invites", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: `stepped-${Date.now()}@wp11.test`, role: "Analyst" }),
    })
  );
  expect(after.status).toBe(201);
});

test("a WRONG password does not unlock a gated route", async () => {
  const owner = await makeAccount("Owner", "owner");
  const session = await makeSession(owner);

  const stepped = await stepUpPOST(
    new Request("http://t/api/auth/step-up", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ password: "not-the-password-at-all" }),
    })
  );
  expect(stepped.status).toBe(401);

  const stillGated = await invitesPOST(
    new Request("http://t/api/auth/invites", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: `nope-${Date.now()}@wp11.test`, role: "Analyst" }),
    })
  );
  expect(stillGated.status).toBe(428);
});

test("step-up cannot be requested without a live session", async () => {
  const response = await stepUpPOST(
    new Request("http://t/api/auth/step-up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    })
  );
  expect(response.status).toBe(401);
});

test("the export route is gated end to end: 428 then 200", async () => {
  const owner = await makeAccount("Owner", "owner");
  const session = await makeSession(owner);

  const before = await exportGET(
    new Request("http://t/api/auth/export", { headers: { cookie: session.cookie } })
  );
  expect(before.status).toBe(428);

  const authed = await requireAuth(session.cookie);
  if (!authed.ok) throw new Error("unreachable");
  await issueStepUp(authed.session, { ok: true }, "password");

  const after = await exportGET(
    new Request("http://t/api/auth/export", { headers: { cookie: session.cookie } })
  );
  expect(after.status).toBe(200);
  expect(after.headers.get("content-type")).toContain("text/csv");
  // An export is never cached, by a proxy or otherwise.
  expect(after.headers.get("cache-control")).toBe("no-store");
});

test("a fresh session starts with NO step-up — the grant does not persist across logins", async () => {
  const owner = await makeAccount("Owner", "owner");
  const first = await makeSession(owner);
  const authedFirst = await requireAuth(first.cookie);
  if (!authedFirst.ok) throw new Error("unreachable");
  await issueStepUp(authedFirst.session, { ok: true }, "password");

  // A brand new login.
  const second = await makeSession(owner);
  const authedSecond = await requireAuth(second.cookie);
  if (!authedSecond.ok) throw new Error("unreachable");

  expect(await currentStepUp(authedSecond.session)).toBeNull();
  expect((await requireStepUp(authedSecond.session, "invite_admin")).ok).toBe(false);
});

// ── Audit ────────────────────────────────────────────────────────────────────

test("granting and consuming a step-up is written to the audit chain", async () => {
  const owner = await makeAccount("Owner", "owner");
  const session = await makeSession(owner);
  const authed = await requireAuth(session.cookie);
  if (!authed.ok) throw new Error("unreachable");

  await issueStepUp(authed.session, { ok: true }, "password");
  await requireStepUp(authed.session, "commit_freeze");

  const rows = await db.auditLog.findMany({
    where: { callRef: `AUTH-${owner.identity.accountId.replace(/[^\w.:-]/g, "")}` },
    select: { intent: true },
  });
  const intents = rows.map((r) => r.intent);
  expect(intents).toContain("auth.stepup.granted");
  expect(intents).toContain("auth.stepup.consumed");
});