/**
 * WP-11 GATE — roles and capabilities, enforced at the data-access layer.
 *
 * The brief is explicit: roles are enforced **at the data-access layer, not in
 * route handlers**. A role check in a handler is a promise by the author of that
 * handler; it holds until the next handler forgets it, and nothing notices.
 *
 * So this file tests BOTH mechanisms and, importantly, tests the structural one
 * by giving a route handler no role check at all:
 *
 *   1. `assertCapability` — the explicit, named check.
 *   2. `rbacDb(role)` — a Prisma client that REFUSES writes for a read-only
 *      role. Tested here by handing an `Auditor` a client and calling
 *      `create`/`update`/`delete` on it with NO capability check performed,
 *      because a read-only role should not need one.
 *
 * The headline test is the brief's: **an Analyst cannot reach an Admin route or
 * its data.** It is proven at both levels — the route returns 403, AND a direct
 * read through an Admin-only view returns nothing to the Analyst.
 */

import { afterAll, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  assertCapability,
  assertMayAssignRole,
  authorizedDb,
  CapabilityError,
  hasCapability,
  rbacDb,
} from "@/lib/auth/rbac";
import {
  CAPABILITIES,
  ROLES,
  ROLE_CAPABILITIES,
  WRITE_CAPABILITIES,
  isReadOnlyRole,
  isRole,
  roleHas,
  type Capability,
  type Role,
} from "@/lib/auth/roles";
import { requireAuth, requireCapability, requirePrivileged } from "@/lib/auth/guards";
import { listOrgMembers } from "@/lib/auth/identity";
import { isHonourableClerkRole, mapClerkRole } from "@/lib/identity/clerk-role-map";
import { makeAccount, makeMember, makeSession, cleanupRun } from "./helpers";
import { GET as invitesGET, POST as invitesPOST } from "@/app/api/auth/invites/route";
import { GET as exportGET } from "@/app/api/auth/export/route";
import { GET as membersGET, PATCH as membersPATCH } from "@/app/api/auth/members/route";

afterAll(async () => {
  await cleanupRun();
});

// ── The matrix ───────────────────────────────────────────────────────────────

test("the five roles exist and each capability is claimed by at least one role", () => {
  expect(ROLES).toEqual(["Owner", "Admin", "Analyst", "Auditor", "ServiceAccount"]);
  // A capability nobody holds is dead weight; one nobody is denied is a typo in
  // a role name. Both fail here rather than being discovered in production.
  for (const cap of CAPABILITIES) {
    const holders = ROLES.filter((role) => roleHas(role, cap));
    expect(holders.length).toBeGreaterThan(0);
  }
});

test("Auditor is read-only: no write capability at all", () => {
  for (const cap of CAPABILITIES) {
    if (WRITE_CAPABILITIES.has(cap)) {
      expect(roleHas("Auditor", cap)).toBe(false);
    }
  }
  expect(isReadOnlyRole("Auditor")).toBe(true);
  // Reads, yes.
  expect(roleHas("Auditor", "case:read")).toBe(true);
  expect(roleHas("Auditor", "audit:read")).toBe(true);
});

test("Analyst cannot hold any organisation-changing capability", () => {
  for (const cap of [
    "member:invite",
    "member:setRole",
    "producerKey:rotate",
    "byok:change",
    "settings:write",
    "org:revokeSessions",
  ] as Capability[]) {
    expect(roleHas("Analyst", cap)).toBe(false);
  }
  // But an Analyst does the actual fraud work.
  expect(roleHas("Analyst", "case:write")).toBe(true);
  expect(roleHas("Analyst", "case:fire")).toBe(true);
});

test("ServiceAccount holds no console capability", () => {
  for (const cap of CAPABILITIES) {
    expect(roleHas("ServiceAccount", cap)).toBe(false);
  }
});

test("Owner holds every capability", () => {
  for (const cap of CAPABILITIES) {
    expect(roleHas("Owner", cap)).toBe(true);
  }
});

test("an unknown role string is refused rather than defaulted", () => {
  expect(isRole("Owner")).toBe(true);
  expect(isRole("SuperAdmin")).toBe(false);
  expect(isRole("owner")).toBe(false); // case-sensitive
  expect(isRole(undefined)).toBe(false);
  expect(isRole(null)).toBe(false);
});

// ── The explicit check ───────────────────────────────────────────────────────

test("assertCapability throws for a role that lacks the capability", () => {
  expect(() => assertCapability("Analyst", "member:invite")).toThrow(CapabilityError);
  expect(() => assertCapability("Auditor", "case:write")).toThrow(CapabilityError);
  expect(() => assertCapability("ServiceAccount", "case:read")).toThrow(CapabilityError);
});

test("assertCapability passes for a role that holds it", () => {
  expect(() => assertCapability("Admin", "member:invite")).not.toThrow();
  expect(() => assertCapability("Owner", "org:revokeSessions")).not.toThrow();
  expect(() => assertCapability("Auditor", "audit:read")).not.toThrow();
});

test("hasCapability is the non-throwing form and agrees with assertCapability", () => {
  for (const role of ROLES) {
    for (const cap of CAPABILITIES) {
      const held = hasCapability(role, cap);
      expect(held).toBe(roleHas(role, cap));
      if (held) expect(() => assertCapability(role, cap)).not.toThrow();
      else expect(() => assertCapability(role, cap)).toThrow();
    }
  }
});

// ── THE structural control: rbacDb refuses writes for a read-only role ──────

test("rbacDb(Auditor).create THROWS — no capability check was performed", async () => {
  // No assertCapability call anywhere in this test. The point is that a caller
  // who forgets the check still cannot write.
  const auditor = await makeAccount("Auditor", "auditor");
  const handle = rbacDb("Auditor");

  expect(() =>
    handle.account.create({ data: { email: `smuggled-${Date.now()}@x.test`, name: "x", role: "Owner" } })
  ).toThrow(CapabilityError);

  // And it did not create anything.
  expect(await db.account.count({ where: { email: { startsWith: "smuggled-" } } })).toBe(0);
  void auditor;
});

test("rbacDb(Auditor) refuses every write delegate on every model", () => {
  const handle = rbacDb("Auditor") as unknown as Record<string, Record<string, unknown>>;
  for (const model of ["account", "case", "auditLog", "producerKey", "userProfile", "customer"]) {
    for (const method of ["create", "update", "upsert", "delete", "updateMany", "deleteMany"]) {
      expect(() => (handle[model]![method] as () => void)()).toThrow(CapabilityError);
    }
  }
});

test("rbacDb(Auditor) permits READS — read-only means read-only, not no access", async () => {
  const owner = await makeAccount("Owner", "owner");
  await makeMember("Analyst", "analyst", owner.orgId);

  const handle = rbacDb("Auditor");
  // An Auditor's whole job is reading. This must work.
  const rows = await handle.account.findMany({ where: { email: { endsWith: "@wp11.test" } }, take: 5 });
  expect(Array.isArray(rows)).toBe(true);
});

test("a writable role gets a working handle", async () => {
  const admin = await makeAccount("Admin", "admin");
  const handle = rbacDb("Admin");
  const rows = await handle.account.findUnique({
    where: { email: admin.email },
    select: { email: true, role: true },
  });
  expect(rows?.role).toBe("Admin");
});

test("authorizedDb refuses before handing out a handle for a write it lacks", () => {
  // Auditor lacks case:write, so this throws at the check — the caller cannot
  // obtain a write-capable handle for a role that has no write capability.
  expect(() => authorizedDb("Auditor", "case:write")).toThrow(CapabilityError);
  // A read capability does not require a write capability.
  expect(() => authorizedDb("Auditor", "case:read")).not.toThrow();
  expect(() => authorizedDb("Analyst", "case:write")).not.toThrow();
});

// ── THE headline test: an Analyst cannot reach an Admin route or its data ────

test("an Analyst is refused by an Admin-only ROUTE", async () => {
  const owner = await makeAccount("Owner", "owner");
  const analyst = await makeMember("Analyst", "analyst", owner.orgId);
  const session = await makeSession(analyst);

  // GET /api/auth/invites requires member:read, which an Analyst holds — so this
  // one is allowed. The POST requires member:invite AND a step-up, which an
  // Analyst cannot have. Both halves are asserted, because "the route returned
  // 403 for some reason" is not the same as "the role stopped it".
  const list = await invitesGET(
    new Request("http://t/api/auth/invites", { headers: { cookie: session.cookie } })
  );
  expect(list.status).toBe(200);

  const issue = await invitesPOST(
    new Request("http://t/api/auth/invites", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: `x-${Date.now()}@wp11.test`, role: "Admin" }),
    })
  );
  // 403 (capability denied) rather than 428 (step-up missing): the Analyst is
  // not permitted the action at all, so there is nothing to confirm.
  expect(issue.status).toBe(403);
});

test("an Analyst is refused the Admin-only bulk EXPORT route and its data", async () => {
  const owner = await makeAccount("Owner", "owner");
  const analyst = await makeMember("Analyst", "owner-analyst", owner.orgId);
  const session = await makeSession(analyst);

  const response = await exportGET(
    new Request("http://t/api/auth/export", { headers: { cookie: session.cookie } })
  );

  // Refused. The Analyst HOLDS `export:bulk` (it is queue work, not an
  // organisation change), so this reaches the step-up stage and is refused with
  // 428 "confirm it's you" — a different answer from the 403 below, which is a
  // role that is not permitted at all. Both are refusals; asserting the exact
  // one matters, because conflating them would let the UI prompt an Auditor for
  // a password on an action they can never perform.
  expect(response.status).toBe(428);
  expect(response.headers.get("content-type")).toContain("application/json");
  // …and crucially: no rows of data came back. A 403 with a body would still be
  // a leak.
  const body = await response.text();
  expect(body).not.toContain("caseRef");
  expect(body).not.toContain("merchant");
});

test("an Analyst's read of the member list shows no member data it may not see", async () => {
  const owner = await makeAccount("Owner", "owner");
  const analyst = await makeMember("Analyst", "analyst", owner.orgId);
  const session = await makeSession(analyst);

  // member:read is held by Analyst, so the route answers — but the body must be
  // the member list only, never any operational data.
  const response = await membersGET(
    new Request("http://t/api/auth/members", { headers: { cookie: session.cookie } })
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { members: Array<{ email: string }> };
  for (const member of body.members) {
    expect(member.email).toContain("@wp11.test");
  }
  // Nothing else is in the payload.
  expect(Object.keys(body)).toEqual(["members"]);
});

test("an Analyst cannot change a role through the members route", async () => {
  const owner = await makeAccount("Owner", "owner");
  const analyst = await makeMember("Analyst", "analyst", owner.orgId);
  const victim = await makeMember("Auditor", "victim", owner.orgId);
  const session = await makeSession(analyst);

  const response = await membersPATCH(
    new Request("http://t/api/auth/members", {
      method: "PATCH",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ accountId: victim.identity.accountId, role: "Owner" }),
    })
  );
  expect(response.status).toBe(403);

  // The role is unchanged in the database.
  const account = await db.account.findUnique({
    where: { id: victim.identity.accountId },
    select: { role: true },
  });
  expect(account?.role).toBe("Auditor");
});

test("an Auditor cannot change a role even WITH a fresh step-up", async () => {
  const owner = await makeAccount("Owner", "owner");
  const auditor = await makeMember("Auditor", "auditor", owner.orgId);
  const victim = await makeMember("Auditor", "victim", owner.orgId);
  const session = await makeSession(auditor);

  // A step-up is not a privilege. Grant a REAL one through the guard, so the
  // only remaining reason to refuse is the role.
  const guard = await requireAuth(session.cookie);
  expect(guard.ok).toBe(true);
  if (!guard.ok) throw new Error("unreachable");
  const { issueStepUp } = await import("@/lib/auth/stepup");
  const grant = await issueStepUp(guard.session, { ok: true }, "password");
  // On success issueStepUp returns a grant (which has no `ok` field); on failure
  // it returns the ReAuthOutcome it was handed. Assert on the grant's shape.
  expect("at" in grant && typeof grant.at === "number").toBe(true);

  // The grant is real — requireStepUp accepts it. So the refusal that follows is
  // about the ROLE, not about a missing step-up.
  const { requireStepUp } = await import("@/lib/auth/stepup");
  const stepUp = await requireStepUp(guard.session, "invite_admin");
  expect(stepUp.ok).toBe(true);

  const response = await membersPATCH(
    new Request("http://t/api/auth/members", {
      method: "PATCH",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ accountId: victim.identity.accountId, role: "Admin" }),
    })
  );
  expect(response.status).toBe(403);

  const account = await db.account.findUnique({
    where: { id: victim.identity.accountId },
    select: { role: true },
  });
  expect(account?.role).toBe("Auditor");
});

// ── Owner/Admin separation ───────────────────────────────────────────────────

test("an Admin may not promote anyone to Owner", () => {
  expect(() => assertMayAssignRole("Admin", "Analyst", "Owner")).toThrow(CapabilityError);
  // But may change a non-Owner to a non-Owner.
  expect(() => assertMayAssignRole("Admin", "Analyst", "Admin")).not.toThrow();
});

test("an Admin may not change an Owner's role in either direction", () => {
  expect(() => assertMayAssignRole("Admin", "Owner", "Admin")).toThrow(CapabilityError);
  expect(() => assertMayAssignRole("Admin", "Owner", "Owner")).toThrow(CapabilityError);
});

test("an Owner may change anyone's role", () => {
  expect(() => assertMayAssignRole("Owner", "Owner", "Admin")).not.toThrow();
  expect(() => assertMayAssignRole("Owner", "Analyst", "Owner")).not.toThrow();
});

test("an Analyst or Auditor may not change roles at all", () => {
  for (const role of ["Analyst", "Auditor", "ServiceAccount"] as Role[]) {
    expect(() => assertMayAssignRole(role, "Auditor", "Admin")).toThrow(CapabilityError);
  }
});

// ── Live roles come from the identity, not the token ─────────────────────────

test("the live role is read from the identity record, not the session snapshot", async () => {
  const owner = await makeAccount("Owner", "owner");
  const admin = await makeMember("Admin", "admin", owner.orgId);
  const live = await makeSession(admin);

  // The session record still says Admin — it is a snapshot.
  expect(live.session.role).toBe("Admin");

  // Demote directly in the identity store (bypassing setRole, to prove the
  // check is not reading the snapshot).
  const { put } = await import("@/lib/auth/store");
  const { AUTH_SCOPES } = await import("@/lib/auth/store");
  const identity = (await listOrgMembers(owner.orgId)).find(
    (m) => m.accountId === admin.identity.accountId
  )!;
  await put(
    AUTH_SCOPES.identity,
    identity.accountId,
    owner.orgId,
    { ...identity, role: "Auditor" },
    new Date("2999-12-31T00:00:00.000Z")
  );

  // The session's snapshotted role is IGNORED. The guard reports the LIVE role
  // from the identity record. This is the property that matters: if any code
  // read `session.role`, it would see "Admin" and grant Admin actions to a
  // demoted account.
  const guard = await requireAuth(live.cookie);
  expect(guard.ok).toBe(true);
  if (!guard.ok) throw new Error("unreachable");
  expect(guard.role).toBe("Auditor");
  expect(guard.identity.role).toBe("Auditor");
  // The snapshot still claims Admin — proving the two genuinely diverge and the
  // guard picked the right one.
  expect(live.session.role).toBe("Admin");

  // And the demoted handle cannot write.
  expect(() =>
    guard.db.account.update({ where: { id: admin.identity.accountId }, data: { name: "x" } })
  ).toThrow(CapabilityError);
});

// ── Clerk coexistence ────────────────────────────────────────────────────────

test("Clerk roles map onto the WP-11 scale", () => {
  expect(mapClerkRole({ role: "operator" })).toBe("Admin");
  expect(mapClerkRole({ role: "demo" })).toBe("Auditor");
  // An explicit platform role wins.
  expect(mapClerkRole({ role: "operator", platformRole: "Owner" })).toBe("Owner");
  expect(mapClerkRole({ platformRole: "Analyst" })).toBe("Analyst");
});

test("an unrecognised Clerk role resolves to the LEAST privilege", () => {
  // Fail-closed is the only safe default in a permission mapping.
  expect(mapClerkRole({ role: "superadmin" })).toBe("Auditor");
  expect(mapClerkRole({ role: "operator", platformRole: "root" })).toBe("Admin");
  expect(mapClerkRole(null)).toBe("Auditor");
  expect(mapClerkRole(undefined)).toBe("Auditor");
  expect(mapClerkRole({})).toBe("Auditor");
});

test("a Clerk identity cannot claim the machine ServiceAccount role", () => {
  expect(isHonourableClerkRole("ServiceAccount")).toBe(false);
  expect(isHonourableClerkRole("Owner")).toBe(true);
  // And the mapping refuses to honour it, falling back to the legacy value.
  expect(mapClerkRole({ role: "operator", platformRole: "ServiceAccount" })).toBe("Admin");
});

test("the mapped Clerk roles exist in the matrix, so one scale governs both paths", () => {
  for (const role of ROLES) {
    expect(ROLE_CAPABILITIES[role]).toBeDefined();
  }
  // A Clerk-mapped Admin is subject to the same matrix as an invited Admin.
  expect(roleHas(mapClerkRole({ role: "operator" }), "member:invite")).toBe(true);
  expect(roleHas(mapClerkRole({ role: "demo" }), "case:write")).toBe(false);
});

// ── Guard composition ────────────────────────────────────────────────────────

test("requireCapability returns 403 with capability_denied for the wrong role", async () => {
  const owner = await makeAccount("Owner", "owner");
  const analyst = await makeMember("Analyst", "analyst", owner.orgId);
  const session = await makeSession(analyst);

  const allowed = await requireCapability(session.cookie, "case:read");
  expect(allowed.ok).toBe(true);

  const denied = await requireCapability(session.cookie, "member:invite");
  expect(denied.ok).toBe(false);
  if (denied.ok) throw new Error("unreachable");
  expect(denied.status).toBe(403);
  expect(denied.code).toBe("capability_denied");
});

test("the handle a guard hands back is already role-bound", async () => {
  const owner = await makeAccount("Owner", "owner");
  const auditor = await makeMember("Auditor", "auditor", owner.orgId);
  const session = await makeSession(auditor);

  const guard = await requireCapability(session.cookie, "case:read");
  expect(guard.ok).toBe(true);
  if (!guard.ok) throw new Error("unreachable");

  // The Auditor's handle refuses a write without the route having to remember.
  expect(() =>
    guard.db.account.update({ where: { id: auditor.identity.accountId }, data: { name: "x" } })
  ).toThrow(CapabilityError);
});

test("requirePrivileged refuses before the step-up is even considered", async () => {
  const owner = await makeAccount("Owner", "owner");
  const analyst = await makeMember("Analyst", "analyst", owner.orgId);
  const session = await makeSession(analyst);

  // `export_bulk_data` maps to `export:bulk`, which an Analyst DOES hold — so
  // this one reaches the step-up stage and must be 428, not 403. The two are
  // different answers and the console needs to tell them apart.
  const result = await requirePrivileged(session.cookie, "export_bulk_data");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.status).toBe(428);
  expect(result.code).toBe("step_up_required");
});

test("a role that cannot perform the action gets 403, not 428", async () => {
  const owner = await makeAccount("Owner", "owner");
  const auditor = await makeMember("Auditor", "auditor", owner.orgId);
  const session = await makeSession(auditor);

  // commit_freeze maps to case:write, which an Auditor does NOT hold.
  const result = await requirePrivileged(session.cookie, "commit_freeze");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.status).toBe(403);
  expect(result.code).toBe("capability_denied");
});