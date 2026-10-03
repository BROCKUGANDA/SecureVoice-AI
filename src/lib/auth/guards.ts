import "server-only";
/**
 * Route-handler-shaped guards (WP-11).
 *
 * These are THIN. Every decision they make is delegated to the layer that owns
 * it — `verifySession` owns the session policy, `assertCapability` owns roles,
 * `requireStepUp` owns re-authentication. Nothing here re-implements a rule,
 * because a rule implemented twice is a rule that will disagree with itself.
 *
 * The one thing this file is responsible for is ORDER, which is a security
 * property and not a detail:
 *
 *     1. session      — is there a live, unexpired, un-revoked session?
 *     2. capability   — does the LIVE role hold the capability?
 *     3. step-up      — has the person at the keyboard re-authenticated?
 *
 * Session first, because a capability check against an absent session has no
 * subject. Capability second, because step-up is not a privilege. Step-up last,
 * because prompting someone to re-enter their password before telling them the
 * action is not theirs to perform is a way to collect credentials for a denied
 * request.
 *
 * ── `requireAuth` vs the existing console session guards ──────────────────────────────
 * `requireSignedIn` / `requireOperator` in `src/lib/credits.ts` are session-backed
 * and remain the console's path for signed-in identities. These guards are
 * the FIRST-PARTY path for invite-provisioned operators. They are separate on
 * purpose: this package is not permitted to change `credits.ts`, and a session
 * cookie is not a signed-in session. See `src/lib/identity/session-bridge.ts` for the
 * mapping that puts both vocabularies on one role scale.
 */

import { db } from "@/lib/db";
import {
  absoluteRemainingMs,
  idleRemainingMs,
  readSessionCookie,
  revokeSession,
  verifySession,
  type SessionCheck,
  type SessionRecord,
} from "@/lib/auth/session";
import { getIdentity, type Identity } from "@/lib/auth/identity";
import { assertCapability, authorizedDb, CapabilityError, type RbacClient } from "@/lib/auth/rbac";
import { requireStepUp, type StepUpCheck } from "@/lib/auth/stepup";
import { normalizeEmail, verifyPassword } from "@/lib/auth/password";
import { issueSession, type IssuedSession } from "@/lib/auth/session";
import {
  PRIVILEGED_ACTION_CAPABILITY,
  type Capability,
  type PrivilegedAction,
  type Role,
} from "@/lib/auth/roles";
import { AUTH_AUDIT_INTENTS, auditAuthEvent } from "@/lib/auth/audit";

/** A denial, in the shape the route handlers in this repo already use. */
export type AuthDenied = {
  ok: false;
  status: 401 | 403 | 428;
  error: string;
  /** Machine-readable, for the UI to branch on. */
  code: string;
};

export type Authed = {
  ok: true;
  session: SessionRecord;
  identity: Identity;
  role: Role;
  orgId: string;
  /** A database handle already bound to this identity's role. */
  db: RbacClient;
};

/**
 * Resolve a request's session. The ONLY way a request becomes `Authed`.
 *
 * `cookieHeader` is read here rather than by each route so that there is no
 * code path which authenticates a request without running `verifySession` —
 * and therefore no path that skips the idle check.
 */
export async function requireAuth(
  cookieHeader: string | null | undefined,
): Promise<Authed | AuthDenied> {
  const check: SessionCheck = await verifySession(readSessionCookie(cookieHeader));
  if (!check.ok) {
    // 401 for "who are you", 403 for "not any more". Both are the same answer
    // to a browser; the distinction is for the operator reading the log.
    const denied =
      check.reason === "idle_timeout" ||
      check.reason === "absolute_timeout" ||
      check.reason === "revoked"
        ? 403
        : 401;
    await auditAuthEvent({
      intent: AUTH_AUDIT_INTENTS.sessionRejected,
      actorId: "anonymous",
      note: check.error,
      meta: { reason: check.reason },
    });
    return { ok: false, status: denied, error: check.error, code: check.reason };
  }
  return {
    ok: true,
    session: check.session,
    identity: check.identity,
    role: check.identity.role,
    orgId: check.identity.orgId,
    db: authorizedDb(check.identity.role, "case:read"),
  };
}

/** Require a live session holding `capability`. */
export async function requireCapability(
  cookieHeader: string | null | undefined,
  capability: Capability,
): Promise<Authed | AuthDenied> {
  const authed = await requireAuth(cookieHeader);
  if (!authed.ok) return authed;
  try {
    assertCapability(authed.role, capability);
  } catch (err) {
    if (err instanceof CapabilityError) {
      return {
        ok: false,
        status: 403,
        error: `Role ${authed.role} may not perform this action.`,
        code: "capability_denied",
      };
    }
    throw err;
  }
  return authed;
}

export type PrivilegedAuthed = Authed & { stepUp: StepUpCheck };

/**
 * Require a live session, the role capability, AND a fresh step-up for a
 * privileged action.
 *
 * The capability comes from the action's declared mapping, so a caller cannot
 * forget it: `requirePrivileged(cookie, "commit_freeze")` cannot be satisfied
 * by a role that lacks `case:write`.
 */
export async function requirePrivileged(
  cookieHeader: string | null | undefined,
  action: PrivilegedAction,
): Promise<PrivilegedAuthed | AuthDenied> {
  const authed = await requireCapability(cookieHeader, PRIVILEGED_ACTION_CAPABILITY[action]);
  if (!authed.ok) return authed;
  const stepUp = await requireStepUp(authed.session, action);
  if (!stepUp.ok) {
    return {
      ok: false,
      // 428 Precondition Required: the request is well-formed and the caller is
      // permitted, but a precondition (fresh re-authentication) is unmet. A
      // distinct status is what lets the console show "confirm it's you" rather
      // than a generic failure.
      status: 428,
      error: stepUp.error,
      code: stepUp.reason,
    };
  }
  return { ...authed, stepUp };
}

// ── Password sign-in (fallback path) ─────────────────────────────────────────

export type PasswordLogin =
  | { ok: true; identity: Identity; session: IssuedSession }
  | { ok: false; reason: "invalid_credentials" | "no_password_set"; error: string };

/**
 * Password sign-in — the FALLBACK. See magic-link.ts for why magic link is
 * primary.
 *
 * Unknown email and wrong password return the SAME error, so the endpoint
 * cannot be used to enumerate which addresses have accounts. The comparison
 * runs against whatever hash is stored regardless of the account existing, so
 * the response time does not leak existence either.
 */
export async function loginWithPassword(email: string, password: string): Promise<PasswordLogin> {
  const normalized = normalizeEmail(email);
  const account = await db.account.findUnique({
    where: { email: normalized },
    select: { id: true, passwordHash: true, role: true },
  });

  if (!account || !account.passwordHash) {
    // Uniform failure. No audit row naming the address: an attacker must not be
    // able to make the chain confirm that a guessed address exists.
    return {
      ok: false,
      reason: "invalid_credentials",
      error: "That email and password combination is not valid.",
    };
  }

  const ok = await verifyPassword(password, account.passwordHash);
  if (!ok) {
    await auditAuthEvent({
      intent: AUTH_AUDIT_INTENTS.loginFailed,
      actorId: account.id,
      note: "password sign-in failed",
      meta: { method: "password" },
    });
    return {
      ok: false,
      reason: "invalid_credentials",
      error: "That email and password combination is not valid.",
    };
  }

  const identity = await getIdentity(account.id);
  if (!identity) {
    return {
      ok: false,
      reason: "no_password_set",
      error: "Account is not provisioned for session sign-in.",
    };
  }

  const session = await issueSession({ identity, method: "password" });
  await auditAuthEvent({
    intent: AUTH_AUDIT_INTENTS.loginOk,
    actorId: identity.accountId,
    orgId: identity.orgId,
    note: "signed in via password",
    meta: { method: "password" },
  });
  return { ok: true, identity, session };
}

// ── Session self-service ─────────────────────────────────────────────────────

/** Everything the console needs to render its (advisory) idle countdown. */
export function sessionStatus(session: SessionRecord, now = Date.now()) {
  return {
    issuedAt: new Date(session.issuedAt).toISOString(),
    lastSeenAt: new Date(session.lastSeenAt).toISOString(),
    idleRemainingMs: idleRemainingMs(session, now),
    absoluteRemainingMs: absoluteRemainingMs(session, now),
    role: session.role,
    method: session.method,
  };
}

/** Sign out: revoke THIS session. Revocation is server-side, so the cookie
 *  being left in the browser is not a gap. */
export async function logout(session: SessionRecord): Promise<void> {
  await revokeSession(session.sid, session.accountId);
  await auditAuthEvent({
    intent: AUTH_AUDIT_INTENTS.sessionRevoked,
    actorId: session.accountId,
    orgId: session.orgId,
    note: "signed out",
    meta: { sid: session.sid },
  });
}
