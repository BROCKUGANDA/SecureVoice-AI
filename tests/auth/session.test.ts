/**
 * WP-11 GATE — server-enforced session policy.
 *
 * The policy: idle 15 minutes, absolute lifetime 8 hours, `last_seen_at` checked
 * on EVERY authenticated request.
 *
 * ── THE key test in this file is "an idle session is rejected server-side"
 * ─────────────────────────────────────────────────────────────────────────────
 * It plants a session that is PAST IDLE BUT NOT PAST ABSOLUTE (issued 20 minutes
 * ago, last seen 16 minutes ago) and presents a perfectly valid, correctly-signed
 * cookie for it. The session is then rejected with reason `idle_timeout`.
 *
 * The margins are what make this a real test rather than a tautology:
 *   · a control that checked ONLY the absolute limit would accept this session,
 *     because 20 minutes is well inside 8 hours. So the test distinguishes
 *     "enforces idle" from "enforces absolute".
 *   · a control that ran ONLY in a browser would not run at all. This test calls
 *     `verifySession` — the exact function a route handler calls — with nothing
 *     but the cookie string. There is no browser, no client timer, no JavaScript
 *     state to cooperate. That is what "server-enforced" means operationally, and
 *     it is asserted here rather than asserted in a comment.
 *
 * ── The client-side idle hook is NOT this control ────────────────────────────
 * Nothing in this package runs a client timer. `GET /api/auth/me` reports
 * `idleRemainingMs` so a UI can warn the user, and that field is explicitly
 * advisory. A cookie whose session the server has killed stays dead no matter
 * what the page believes, which is what `logout` depends on and what the
 * revocation tests below confirm.
 */

import { afterAll, expect, test } from "bun:test";
import { db } from "@/lib/db";
import {
  verifySession,
  parseSessionToken,
  readSessionCookie,
  signSessionToken,
  issueSession,
  revokeSession,
  type SessionRecord,
} from "@/lib/auth/session";
import { logout, requireAuth } from "@/lib/auth/guards";
import { getIdentity, setRole, revokeOrgSessions } from "@/lib/auth/identity";
import { AUTH_AUDIT_INTENTS, auditAuthEventRequired } from "@/lib/auth/audit";
import { AUTH_SCOPES, put } from "@/lib/auth/store";
import { ABSOLUTE_LIFETIME_MS, IDLE_TIMEOUT_MS, SESSION_RECORD_TTL_MS } from "@/lib/auth/constants";
import {
  cleanupRun,
  expectRejection,
  makeAccount,
  makeActiveButAbsolutelyExpiredSession,
  makeIdleButNotExpiredSession,
  makeMember,
  makeSession,
  uniq,
} from "./helpers";

afterAll(async () => {
  await cleanupRun();
});

// ── The policy numbers are what the brief specifies ──────────────────────────

test("the session policy is 15 minutes idle and 8 hours absolute", () => {
  expect(IDLE_TIMEOUT_MS).toBe(15 * 60 * 1000);
  expect(ABSOLUTE_LIFETIME_MS).toBe(8 * 60 * 60 * 1000);
  // The two limits must not collapse into each other, or one of the two tests
  // below becomes unreachable.
  expect(IDLE_TIMEOUT_MS).toBeLessThan(ABSOLUTE_LIFETIME_MS);
});

// ── KEY TEST: idle rejection, server-side, with a valid cookie ───────────────

test("an idle session is rejected SERVER-SIDE after the cutoff, with a valid cookie", async () => {
  const admin = await makeAccount("Admin", "admin");
  const live = await makeIdleButNotExpiredSession(admin);

  // The planted session is genuinely mid-life: inside the absolute limit.
  const ageMs = Date.now() - live.session.issuedAt;
  expect(ageMs).toBeGreaterThan(IDLE_TIMEOUT_MS);
  expect(ageMs).toBeLessThan(ABSOLUTE_LIFETIME_MS);

  // The cookie is cryptographically VALID — the HMAC verifies and the payload
  // parses. Nothing about the token is wrong; only the server-side clock is.
  const parsed = parseSessionToken(live.token);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("unreachable");
  expect(parsed.sessionId).toBe(live.session.sid);

  // The server refuses it, for the idle reason specifically.
  await expectRejection(live.token, "idle_timeout");
});

test("the idle rejection is enforced through the route guard, not just the helper", async () => {
  const admin = await makeAccount("Admin", "admin");
  const live = await makeIdleButNotExpiredSession(admin);

  // `requireAuth` is what route handlers call. It must refuse, with the idle
  // reason surfaced — proving the control is wired into the request path and
  // is not a function tests call directly but nothing else does.
  const guard = await requireAuth(live.cookie);
  expect(guard.ok).toBe(false);
  if (guard.ok) throw new Error("unreachable");
  expect(guard.code).toBe("idle_timeout");
  expect(guard.status).toBe(403);
});

test("a session is accepted right up to the idle cutoff and refused just past it", async () => {
  const admin = await makeAccount("Admin", "admin");

  // Just inside the window.
  const fresh = await makeSession(admin);
  fresh.session.lastSeenAt = Date.now() - (IDLE_TIMEOUT_MS - 5_000);
  await persistSession(fresh);
  const inside = await verifySession(fresh.token);
  expect(inside.ok).toBe(true);

  // Just outside it, by one millisecond past the boundary.
  const stale = await makeSession(admin);
  stale.session.lastSeenAt = Date.now() - (IDLE_TIMEOUT_MS + 1_000);
  await persistSession(stale);
  await expectRejection(stale.token, "idle_timeout");
});

test("each accepted request advances last_seen_at, so active use keeps a session alive", async () => {
  const admin = await makeAccount("Admin", "admin");
  const live = await makeSession(admin);
  const original = live.session.lastSeenAt;

  await new Promise((r) => setTimeout(r, 25));

  const first = await verifySession(live.token);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("unreachable");
  expect(first.session.lastSeenAt).toBeGreaterThan(original);
  expect(first.session.lastSeenAt).toBeLessThanOrEqual(Date.now());
});

// ── Absolute lifetime ────────────────────────────────────────────────────────

test("an absolutely-expired session is rejected even though it is ACTIVE", async () => {
  const admin = await makeAccount("Admin", "admin");
  const live = await makeActiveButAbsolutelyExpiredSession(admin);

  // Active: last seen a second ago, so the idle check would have passed. Only
  // the absolute limit can be what refuses this.
  expect(Date.now() - live.session.lastSeenAt).toBeLessThan(IDLE_TIMEOUT_MS);
  expect(Date.now() - live.session.issuedAt).toBeGreaterThan(ABSOLUTE_LIFETIME_MS);

  const parsed = parseSessionToken(live.token);
  expect(parsed.ok).toBe(true);

  await expectRejection(live.token, "absolute_timeout");
});

test("absolute expiry wins over idle when both are past", async () => {
  const admin = await makeAccount("Admin", "admin");
  const now = Date.now();
  const live = await makeSession(admin);
  live.session.issuedAt = now - (ABSOLUTE_LIFETIME_MS + 60_000);
  live.session.lastSeenAt = now - (IDLE_TIMEOUT_MS + 60_000);
  await persistSession(live);
  const token = signSessionToken(live.session.sid, admin.identity.accountId, live.session.issuedAt);

  // Ordering matters for the audit trail: a session that is past both should
  // report the limit that is actually the ceiling for it, which is the absolute
  // one — "your 8 hours are up" is the useful message, not "you went idle".
  await expectRejection(token, "absolute_timeout");
});

// ── Token integrity ──────────────────────────────────────────────────────────

test("a tampered token is refused", async () => {
  const admin = await makeAccount("Admin", "admin");
  const live = await makeSession(admin);

  // Flip one character of the signature.
  const parts = live.token.split(".");
  const sig = parts[2]!;
  const flipped = `${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
  await expectRejection(`${parts[0]}.${parts[1]}.${flipped}`, "invalid_token");
});

test("a token with no session record is refused, not treated as valid", async () => {
  const admin = await makeAccount("Admin", "admin");
  // A valid signature for a session id that was never issued. The signature is
  // correct; the authority is absent.
  const orphan = signSessionToken(uniq("never-issued"), admin.identity.accountId, Date.now());
  expect(parseSessionToken(orphan).ok).toBe(true);
  await expectRejection(orphan, "unknown_session");
});

test("a token whose payload was edited is refused", async () => {
  const admin = await makeAccount("Admin", "admin");
  const live = await makeSession(admin);
  const forged = signSessionToken(live.session.sid, uniq("other-account"), Date.now());
  // Signed, but for a different account id than the record is filed under.
  await expectRejection(forged, "unknown_session");
});

test("no cookie yields no_session", async () => {
  await expectRejection(null, "no_session");
  await expectRejection("", "no_session");
});

test("the session cookie is read out of a cookie header", () => {
  expect(readSessionCookie("sv_session=abc.def.ghi")).toBe("abc.def.ghi");
  expect(readSessionCookie("other=1; sv_session=abc.def.ghi; more=2")).toBe("abc.def.ghi");
  expect(readSessionCookie("nope=1")).toBeNull();
  expect(readSessionCookie(null)).toBeNull();
});

test("the token payload exposes no role, so it cannot be edited into one", () => {
  // The payload is `<sid>.<accountId>.<issuedAt>` — three opaque identifiers.
  // Authority lives in the server-side record, so there is nothing here to forge.
  const token = signSessionToken("sid1", "acct1", 1234);
  const payload = Buffer.from(token.split(".")[1]!, "base64").toString("utf8");
  expect(payload).toBe("sid1.acct1.1234");
  for (const role of ["Owner", "Admin", "Analyst", "Auditor"]) {
    expect(payload).not.toContain(role);
  }
});

// ── Explicit revocation ──────────────────────────────────────────────────────

test("a revoked session is refused", async () => {
  const admin = await makeAccount("Admin", "admin");
  const live = await makeSession(admin);
  expect((await verifySession(live.token)).ok).toBe(true);

  await revokeSession(live.session.sid, admin.identity.accountId);

  await expectRejection(live.token, "revoked");
});

test("signing out invalidates the session even if the client keeps the cookie", async () => {
  const admin = await makeAccount("Admin", "admin");
  const live = await makeSession(admin);
  const guard = await requireAuth(live.cookie);
  expect(guard.ok).toBe(true);
  if (!guard.ok) throw new Error("unreachable");
  await logout(guard.session);

  // A client that ignores the cookie-clearing response and replays the old
  // cookie is refused. This is why revocation is server-side.
  const replay = await requireAuth(live.cookie);
  expect(replay.ok).toBe(false);
  if (replay.ok) throw new Error("unreachable");
  expect(replay.code).toBe("revoked");
});

// ── Item 6: automatic revocation on role change ──────────────────────────────

test("a role change revokes every existing session for that identity", async () => {
  const owner = await makeAccount("Owner", "owner");
  const analyst = await makeMember("Analyst", "analyst", owner.orgId);

  // Two concurrent sessions, so the revocation cannot be an artefact of one.
  const first = await makeSession(analyst);
  const second = await makeSession(analyst);
  expect((await verifySession(first.token)).ok).toBe(true);
  expect((await verifySession(second.token)).ok).toBe(true);

  await setRole(analyst.identity.accountId, owner.orgId, "Admin", async () =>
    auditAuthEventRequired({
      intent: AUTH_AUDIT_INTENTS.roleChanged,
      actorId: owner.identity.accountId,
      orgId: owner.orgId,
      note: "promoted",
    }),
  );

  // Both are dead, even though both were fresh and neither was revoked by id.
  await expectRejection(first.token, "revoked");
  await expectRejection(second.token, "revoked");
});

test("a demotion revokes the session too, so the old role cannot be used", async () => {
  const owner = await makeAccount("Owner", "owner");
  const admin = await makeMember("Admin", "admin", owner.orgId);
  const live = await makeSession(admin);

  // Live and holding Admin.
  const before = await requireAuth(live.cookie);
  expect(before.ok).toBe(true);
  if (!before.ok) throw new Error("unreachable");
  expect(before.role).toBe("Admin");

  await setRole(admin.identity.accountId, owner.orgId, "Auditor", async () =>
    auditAuthEventRequired({
      intent: AUTH_AUDIT_INTENTS.roleChanged,
      actorId: owner.identity.accountId,
      orgId: owner.orgId,
      note: "demoted",
    }),
  );

  const after = await requireAuth(live.cookie);
  expect(after.ok).toBe(false);
  if (after.ok) throw new Error("unreachable");
  expect(after.code).toBe("revoked");
});

test("an UPGRADE also revokes, because the pre-promotion session had the lower role", async () => {
  const owner = await makeAccount("Owner", "owner");
  const analyst = await makeMember("Analyst", "analyst", owner.orgId);
  const live = await makeSession(analyst);

  await setRole(analyst.identity.accountId, owner.orgId, "Admin", async () =>
    auditAuthEventRequired({
      intent: AUTH_AUDIT_INTENTS.roleChanged,
      actorId: owner.identity.accountId,
      orgId: owner.orgId,
      note: "promoted",
    }),
  );

  // A session issued while they were an Analyst does not survive the promotion.
  await expectRejection(live.token, "revoked");

  // But a NEW session issued under the new role works, and carries the new role.
  const reloaded = await getIdentity(analyst.identity.accountId, owner.orgId);
  expect(reloaded).not.toBeNull();
  const fresh = await issueSession({ identity: reloaded!, method: "password" });
  const reauthed = await requireAuth(`sv_session=${fresh.token}`);
  expect(reauthed.ok).toBe(true);
  if (!reauthed.ok) throw new Error("unreachable");
  expect(reauthed.role).toBe("Admin");
});

test("a role change in one org does not revoke sessions in another", async () => {
  const orgA = await makeAccount("Owner", "owner-a");
  const orgB = await makeAccount("Owner", "owner-b");
  const memberA = await makeMember("Analyst", "member-a", orgA.orgId);

  const inA = await makeSession(memberA);

  // A different organisation, entirely separate.
  const outsider = await makeMember("Analyst", "outsider", orgB.orgId);
  const inB = await makeSession(outsider);

  await setRole(memberA.identity.accountId, orgA.orgId, "Auditor", async () =>
    auditAuthEventRequired({
      intent: AUTH_AUDIT_INTENTS.roleChanged,
      actorId: orgA.identity.accountId,
      orgId: orgA.orgId,
      note: "demoted in A only",
    }),
  );

  await expectRejection(inA.token, "revoked");
  expect((await verifySession(inB.token)).ok).toBe(true);
});

// ── Item 6: revoke-all-sessions for an organisation ──────────────────────────

test("revoke-all-sessions kills every session of every member in the org", async () => {
  const owner = await makeAccount("Owner", "owner");
  const analyst = await makeMember("Analyst", "analyst", owner.orgId);
  const auditor = await makeMember("Auditor", "auditor", owner.orgId);

  const sessions = [
    await makeSession(owner),
    await makeSession(analyst),
    await makeSession(auditor),
  ];
  for (const s of sessions) {
    expect((await verifySession(s.token)).ok).toBe(true);
  }

  const result = await revokeOrgSessions(owner.orgId);
  expect(result.revokedSessions).toBe(3);

  // Including the caller's own — "revoke all" that spares the caller is not
  // what an incident responder means.
  for (const s of sessions) {
    await expectRejection(s.token, "revoked");
  }
});

test("revoke-all-sessions does not touch another organisation", async () => {
  const orgA = await makeAccount("Owner", "owner-a");
  const orgB = await makeAccount("Owner", "owner-b");
  const memberA = await makeMember("Analyst", "member-a", orgA.orgId);
  const memberB = await makeMember("Analyst", "member-b", orgB.orgId);

  const inA = await makeSession(memberA);
  const inB = await makeSession(memberB);

  await revokeOrgSessions(orgA.orgId);

  await expectRejection(inA.token, "revoked");
  expect((await verifySession(inB.token)).ok).toBe(true);
});

test("a session issued AFTER a revoke-all is valid, so the sweep has no race", async () => {
  const owner = await makeAccount("Owner", "owner");
  const admin = await makeMember("Admin", "admin", owner.orgId);

  await revokeOrgSessions(owner.orgId);

  // This is the concurrency property: the sweep bumps an epoch, so anything
  // issued afterwards carries the new one. A sweep that deleted rows would let a
  // session minted mid-sweep survive it.
  const reloaded = await getIdentity(admin.identity.accountId, owner.orgId);
  expect(reloaded).not.toBeNull();
  const fresh = await issueSession({ identity: reloaded!, method: "password" });
  expect((await verifySession(fresh.token)).ok).toBe(true);
});

// ── Persistence ──────────────────────────────────────────────────────────────

test("no session record is written without a server-side identity and epochs", async () => {
  const admin = await makeAccount("Admin", "admin");
  const live = await makeSession(admin);

  const row = await db.idempotencyKey.findUnique({
    where: {
      scope_key_callerId: {
        scope: "sv.auth.session",
        key: live.session.sid,
        callerId: admin.identity.accountId,
      },
    },
    select: { response: true },
  });
  expect(row).not.toBeNull();
  const stored = JSON.parse(row!.response) as Record<string, unknown>;
  // The epochs are what make revocation work; their absence would silently turn
  // "role change revokes sessions" into a no-op.
  expect(stored.roleEpoch).toBe(1);
  expect(stored.orgEpoch).toBe(1);
  expect(stored.lastSeenAt).toBeGreaterThan(0);
  // No IP or user-agent: PDPL-conscious collection is a decision that has not
  // been made yet, so the data is not collected.
  expect(Object.keys(stored)).not.toContain("ip");
  expect(Object.keys(stored)).not.toContain("userAgent");
});

/**
 * Persist a mutated session record back to the store.
 *
 * Writes the record the test built, so `verifySession` reads exactly what the
 * fixture intended. This is the same write `issueSession` performs.
 */
async function persistSession(live: { session: SessionRecord }): Promise<void> {
  await put(
    AUTH_SCOPES.session,
    live.session.sid,
    live.session.accountId,
    live.session,
    new Date(live.session.issuedAt + SESSION_RECORD_TTL_MS),
  );
}
