/**
 * WP-11 test fixtures.
 *
 * Every fixture is keyed by a RUN id (`Date.now().toString(36)`), so a run never
 * collides with a previous one and two concurrent runs cannot see each other's
 * sessions, invites or accounts. Tests that assert on a global ("exactly one
 * winner across two concurrent uses") therefore assert about THIS run's data.
 *
 * `AUTH_SECRET` is set here if absent, because `verifySession` fails closed
 * without it. Setting it in the harness rather than per-test means no test can
 * accidentally pass by having silently skipped the signing path.
 */

import { db } from "@/lib/db";
import { AUTH_SCOPES, put } from "@/lib/auth/store";
import {
  issueSession,
  signSessionToken,
  verifySession,
  type AuthMethod,
  type SessionRecord,
} from "@/lib/auth/session";
import { createIdentity, type Identity } from "@/lib/auth/identity";
import { issueInvite, type IssuedInvite } from "@/lib/auth/invite";
import { ABSOLUTE_LIFETIME_MS, IDLE_TIMEOUT_MS, INVITE_TTL_MS } from "@/lib/auth/constants";
import type { Role } from "@/lib/auth/roles";

/** Unique per run. Set once per process, reused by every test in the file. */
export const RUN = Date.now().toString(36);

if (!process.env.AUTH_SECRET) {
  process.env.AUTH_SECRET = `test-secret-${RUN}-not-a-production-value`;
}

let counter = 0;
/** A unique-per-call suffix so one test's fixtures never collide with another's. */
export function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${RUN}-${counter}`;
}

export function testEmail(prefix: string): string {
  return `${uniq(prefix)}@wp11.test`;
}

export const TEST_PASSWORD = "correct-horse-battery-staple-9";

/** Fresh organisation per fixture, so revocation sweeps cannot cross tests. */
export function testOrg(prefix: string): string {
  return uniq(`org-${prefix}`);
}

export type Fixture = {
  identity: Identity;
  email: string;
  orgId: string;
  role: Role;
};

/**
 * Create an account directly (no invite) for a test that is not exercising
 * provisioning. Bypasses `acceptInvite` deliberately — this is fixture setup, not
 * the code path under test.
 */
export async function makeAccount(
  role: Role,
  prefix: string,
  opts: { orgId?: string; password?: string | null; name?: string } = {}
): Promise<Fixture> {
  const email = testEmail(prefix);
  const orgId = opts.orgId ?? testOrg(prefix);
  const { hashPassword } = await import("@/lib/auth/password");
  const identity = await createIdentity({
    email,
    name: opts.name ?? prefix,
    role,
    orgId,
    passwordHash:
      opts.password === null
        ? undefined
        : await hashPassword(opts.password ?? TEST_PASSWORD),
  });
  return { identity, email, orgId, role };
}

/** An account in a specific org — for multi-member revocation tests. */
export async function makeMember(
  role: Role,
  prefix: string,
  orgId: string
): Promise<Fixture> {
  return makeAccount(role, prefix, { orgId });
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export type SessionFixture = {
  identity: Identity;
  session: SessionRecord;
  token: string;
  cookie: string;
};

/** Issue a live session and the cookie header that carries it. */
export async function makeSession(
  fixture: Fixture,
  method: AuthMethod = "password"
): Promise<SessionFixture> {
  const { record, token } = await issueSession({ identity: fixture.identity, method });
  return {
    identity: fixture.identity,
    session: record,
    token,
    cookie: `sv_session=${token}`,
  };
}

/**
 * Overwrite a session's server-side record so it looks issued/seen at a chosen
 * time.
 *
 * This is the lever the KEY test uses: plant a session that is past idle but
 * still well inside its absolute lifetime, then present a perfectly valid signed
 * cookie for it and assert the server refuses. Writing the record directly (rather
 * than adding a test-only backdoor to production code) means the code under test
 * is the same code a real request runs.
 */
export async function backdateSession(
  sessionFixture: SessionFixture,
  opts: { issuedAt?: number; lastSeenAt?: number }
): Promise<void> {
  const base = sessionFixture.session;
  const next: SessionRecord = {
    ...base,
    issuedAt: opts.issuedAt ?? base.issuedAt,
    lastSeenAt: opts.lastSeenAt ?? base.lastSeenAt,
  };
  sessionFixture.session = next;
  await put(
    AUTH_SCOPES.session,
    next.sid,
    next.accountId,
    next,
    new Date(next.issuedAt + ABSOLUTE_LIFETIME_MS + 3_600_000)
  );
}

/**
 * Plant a session that is PAST IDLE but NOT PAST ABSOLUTE, and hand back a
 * validly-signed cookie for it.
 *
 * The margins are chosen to sit strictly inside the other limit, so a control
 * that only checked the absolute lifetime would let this session through — which
 * is what makes the test able to distinguish the two.
 */
export async function makeIdleButNotExpiredSession(
  fixture: Fixture
): Promise<SessionFixture> {
  const now = Date.now();
  const live = await makeSession(fixture);
  await backdateSession(live, {
    issuedAt: now - 20 * 60 * 1000, // 20 min ago: inside the 8-hour absolute life
    lastSeenAt: now - (IDLE_TIMEOUT_MS + 60 * 1000), // 16 min ago: past the 15-min idle cutoff
  });
  // Re-sign so the cookie's issuedAt matches the planted record. The signature is
  // genuine — the server still has to reject this on `lastSeenAt`.
  const token = signSessionToken(live.session.sid, fixture.identity.accountId, live.session.issuedAt);
  return { ...live, token, cookie: `sv_session=${token}` };
}

/** A session past its 8-hour absolute lifetime but recently active. */
export async function makeActiveButAbsolutelyExpiredSession(
  fixture: Fixture
): Promise<SessionFixture> {
  const now = Date.now();
  const live = await makeSession(fixture);
  await backdateSession(live, {
    issuedAt: now - (ABSOLUTE_LIFETIME_MS + 60 * 1000), // 8h01m ago: past absolute
    lastSeenAt: now - 1000, // 1s ago: NOT idle
  });
  const token = signSessionToken(live.session.sid, fixture.identity.accountId, live.session.issuedAt);
  return { ...live, token, cookie: `sv_session=${token}` };
}

/** Assert a session is rejected for a SPECIFIC reason, not merely rejected. */
export async function expectRejection(
  token: string,
  reason: string
): Promise<void> {
  const check = await verifySession(token);
  if (check.ok) {
    throw new Error(`expected rejection "${reason}" but the session was accepted`);
  }
  if (check.reason !== reason) {
    throw new Error(`expected rejection "${reason}" but got "${check.reason}"`);
  }
}

// ── Invites ──────────────────────────────────────────────────────────────────

/**
 * Issue an invite and return the plaintext token.
 *
 * `issuedAgoMs` shifts the issue time rather than the expiry, so the invite is
 * still created by the production `issueInvite` with the production 72-hour TTL —
 * the expiry test is then asserting on the real policy, not on a value the
 * fixture invented.
 */
export async function makeInvite(
  role: Role,
  issuedBy: string,
  orgId: string,
  opts: { email?: string; issuedAgoMs?: number } = {}
): Promise<IssuedInvite & { email: string }> {
  const email = opts.email ?? testEmail("invitee");
  const issuedAt = Date.now() - (opts.issuedAgoMs ?? 0);
  const { invite, token } = await issueInvite({
    email,
    name: "invitee",
    role,
    orgId,
    issuedBy,
    now: issuedAt,
  });
  return { invite, token, email };
}

/** An invite issued long enough ago that its 72-hour window has closed. */
export async function makeExpiredInvite(
  role: Role,
  issuedBy: string,
  orgId: string
): Promise<IssuedInvite & { email: string }> {
  return makeInvite(role, issuedBy, orgId, {
    issuedAgoMs: INVITE_TTL_MS + 60 * 60 * 1000,
  });
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Remove this run's auth rows and accounts.
 *
 * Scoped to the run id on purpose: a cleanup that deleted every row would make
 * the suite order-dependent and would destroy another concurrent run's data.
 * Idempotent, and safe to call from afterEach.
 */
export async function cleanupRun(): Promise<void> {
  const suffix = `-${RUN}-`;
  await db.account.deleteMany({ where: { email: { contains: suffix } } }).catch(() => {});
  await db.idempotencyKey
    .deleteMany({
      where: {
        scope: { startsWith: "sv.auth." },
        OR: [{ key: { contains: suffix } }, { callerId: { contains: suffix } }],
      },
    })
    .catch(() => {});
}