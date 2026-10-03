import "server-only";
/**
 * First-party sessions (WP-11) — and the enforcement of the session policy.
 *
 * ── What is enforced, and where ──────────────────────────────────────────────
 * The policy is: idle 15 minutes, absolute lifetime 8 hours, checked on EVERY
 * authenticated request.
 *
 * `verifySession()` is that check, and it runs on every authenticated request
 * because every authenticated request calls it. There is no cached decision, no
 * "check once per N minutes", and no path that reads the cookie without
 * checking `lastSeenAt`.
 *
 * ── The client-side idle hook is NOT this control ────────────────────────────
 * A browser-side timer that logs the user out is a CONVENIENCE. It exists so a
 * user walking away from their own laptop is not annoyed by a timeout. It is
 * defeated by anything that does not run that hook — a curl replay, a
 * tampered client, a stale service worker, a different browser, an attacker
 * with the cookie — because all of those still present a perfectly valid,
 * correctly-signed cookie string.
 *
 * The only thing that stops a stale cookie is the server noticing it is stale.
 * That happens here, against `lastSeenAt`, in the request handler's own
 * process. A user whose client-side hook is disabled and who keeps an open tab
 * is rejected server-side exactly the same as one whose hook fired. That is the
 * property the test gate asserts, and it is why the test constructs a session
 * that is PAST IDLE BUT NOT PAST ABSOLUTE and a valid signed cookie, and
 * expects rejection: a control that only checked the absolute limit would pass
 * that test, and a control that only ran in the browser would not run at all.
 *
 * ── Token format ─────────────────────────────────────────────────────────────
 *   sv1.<base64url(payload)>.<base64url(hmac-sha256)>
 *   payload = "<sessionId>.<accountId>.<issuedAtMs>"
 *
 * The payload is READABLE by design. It carries no secret and no role: it
 * identifies the session. All authority lives in the server-side session record,
 * so a token cannot be edited into a different role or a longer lifetime —
 * editing it invalidates the HMAC, and even a validly re-signed one would point
 * at a record the server did not issue under those epochs.
 *
 * The HMAC key is derived from AUTH_SECRET with a purpose tag, so the session
 * key is not the same bytes as the BYOK key-encryption key (which is derived
 * with the `sv-byok:` prefix in src/lib/byok.ts) — one leaked secret does not
 * hand over the other. AUTH_SECRET absent ⇒ every session is refused. There is
 * no development fallback: a default signing key means anyone can mint a token.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AUTH_SCOPES, drop, listFor, patch, put, read } from "@/lib/auth/store";
import {
  ABSOLUTE_LIFETIME_MS,
  IDLE_TIMEOUT_MS,
  SESSION_COOKIE_VERSION,
  SESSION_RECORD_TTL_MS,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/constants";
import { getIdentity, type Identity } from "@/lib/auth/identity";
import type { Role } from "@/lib/auth/roles";

export const SESSION_SECRET_ENV = "AUTH_SECRET";

/** No AUTH_SECRET. Never fall back to a default key. */
export class SessionConfigError extends Error {
  constructor() {
    super(
      `${SESSION_SECRET_ENV} is not set. It signs session cookies; a default key would let anyone mint ` +
        `a valid session. Set ${SESSION_SECRET_ENV} to at least 32 random bytes (see .env.example).`,
    );
    this.name = "SessionConfigError";
  }
}

/** Domain-separated signing key. Never the raw AUTH_SECRET, never the BYOK key. */
function signingKey(): Buffer {
  const secret = process.env[SESSION_SECRET_ENV];
  if (!secret || secret.length < 16) throw new SessionConfigError();
  return createHmac("sha256", secret).update("sv-session-v1").digest();
}

// ── Token codec ──────────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Mint a cookie value for a session id.
 *
 * Exported because a session token is only meaningful alongside a server-side
 * record: signing one for an id that has no record yields `unknown_session`,
 * and signing one for an existing record is exactly what the session gate does
 * when it needs a token for a session it has just planted.
 */
export function signSessionToken(sessionId: string, accountId: string, issuedAtMs: number): string {
  const payload = `${sessionId}.${accountId}.${issuedAtMs}`;
  const encoded = b64url(Buffer.from(payload, "utf8"));
  const sig = b64url(createHmac("sha256", signingKey()).update(encoded).digest());
  return `${SESSION_COOKIE_VERSION}.${encoded}.${sig}`;
}

export type TokenParse =
  { ok: true; sessionId: string; accountId: string; issuedAt: number } | { ok: false };

/** Verify the HMAC and decode. A bad signature is `ok:false`, never a throw. */
export function parseSessionToken(token: string | null | undefined): TokenParse {
  if (!token) return { ok: false };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_COOKIE_VERSION) return { ok: false };
  const [, encoded, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", signingKey()).update(encoded).digest();
  const given = unb64url(sig);
  // Constant-time over fixed-size buffers; length mismatch is a mismatch, not
  // a thrown TypeError that would become a 500.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false };
  }
  const decoded = unb64url(encoded).toString("utf8");
  const fields = decoded.split(".");
  if (fields.length !== 3) return { ok: false };
  const [sessionId, accountId, issuedAtRaw] = fields as [string, string, string];
  const issuedAt = Number(issuedAtRaw);
  if (!sessionId || !accountId || !Number.isSafeInteger(issuedAt)) return { ok: false };
  return { ok: true, sessionId, accountId, issuedAt };
}

// ── Session record ───────────────────────────────────────────────────────────

export type AuthMethod = "invite" | "magic_link" | "password";

export type SessionRecord = {
  sid: string;
  accountId: string;
  orgId: string;
  /** The role at issue time. Kept for the audit trail; the LIVE role always
   *  comes from the identity record, never from here. */
  role: Role;
  roleEpoch: number;
  orgEpoch: number;
  issuedAt: number;
  /** Server-side last-activity stamp. This is the field the idle check reads. */
  lastSeenAt: number;
  revokedAt: number | null;
  method: AuthMethod;
};

/**
 * No IP address or user-agent is stored. This is a PDPL-conscious codebase and
 * session-telemetry retention is a decision that has not been made; collecting
 * the data before that decision would be the wrong order. The audit chain
 * records security EVENTS, not request metadata, so the incident question
 * "who revoked this session" is still answerable.
 */
export type IssueSessionInput = {
  identity: Identity;
  method: AuthMethod;
  /** Overridable for tests that need a deterministic lifetime. */
  now?: number;
};

export type IssuedSession = { record: SessionRecord; token: string };

export async function issueSession(input: IssueSessionInput): Promise<IssuedSession> {
  const now = input.now ?? Date.now();
  const sid = randomBytes(32).toString("base64url");
  const record: SessionRecord = {
    sid,
    accountId: input.identity.accountId,
    orgId: input.identity.orgId,
    role: input.identity.role,
    roleEpoch: input.identity.roleEpoch,
    orgEpoch: input.identity.orgEpoch,
    issuedAt: now,
    lastSeenAt: now,
    revokedAt: null,
    method: input.method,
  };
  await put(
    AUTH_SCOPES.session,
    sid,
    record.accountId,
    record,
    new Date(now + SESSION_RECORD_TTL_MS),
  );
  return { record, token: signSessionToken(sid, record.accountId, now) };
}

// ── The server-side check ────────────────────────────────────────────────────

export type SessionRejection =
  /** No cookie, or AUTH_SECRET missing/unusable. */
  | "no_session"
  /** Cookie present but not parseable or wrongly signed. */
  | "invalid_token"
  /** Signature is valid but the server has no such session (expired row, restart). */
  | "unknown_session"
  /** Revoked individually, or by a role change / org revocation epoch bump. */
  | "revoked"
  /** Past the 15-minute idle cutoff. */
  | "idle_timeout"
  /** Past the 8-hour absolute lifetime. */
  | "absolute_timeout";

export type SessionCheck =
  | { ok: true; session: SessionRecord; identity: Identity; token: string }
  | { ok: false; reason: SessionRejection; error: string };

const REJECTION_MESSAGE: Record<SessionRejection, string> = {
  no_session: "Sign in required.",
  invalid_token: "Session token is not valid.",
  unknown_session: "Session is no longer recognised — sign in again.",
  revoked: "Session was revoked — sign in again.",
  idle_timeout: "Session expired after 15 minutes of inactivity.",
  absolute_timeout: "Session reached its 8-hour lifetime — sign in again.",
};

/**
 * THE server-side session control. Call this on every authenticated request.
 *
 * Order matters and is deliberate:
 *   signature → record → revoked → absolute → idle → epochs → touch.
 *
 * Absolute is checked BEFORE idle so an eight-hour-old session reports
 * `absolute_timeout` rather than `idle_timeout`; the audit trail should say
 * which limit actually stopped it.
 *
 * The epoch checks come last: they are what makes a role change and an
 * org-wide revocation take effect on sessions that are otherwise perfectly
 * fresh. A session is only touched (`lastSeenAt` advanced) once every check has
 * passed, so a rejected request never extends the session it was rejected by.
 */
export async function verifySession(
  token: string | null | undefined,
  options: { now?: number } = {},
): Promise<SessionCheck> {
  const now = options.now ?? Date.now();
  const reject = (reason: SessionRejection): SessionCheck => ({
    ok: false,
    reason,
    error: REJECTION_MESSAGE[reason],
  });

  // A missing AUTH_SECRET makes EVERY token unverifiable. Fail closed with a
  // distinct reason so the operator sees a configuration fault, not "signed out".
  let parsed: TokenParse;
  try {
    parsed = parseSessionToken(token);
  } catch (err) {
    if (err instanceof SessionConfigError) return reject("invalid_token");
    throw err;
  }
  if (!parsed.ok) return reject(token ? "invalid_token" : "no_session");

  const record = await read<SessionRecord>(AUTH_SCOPES.session, parsed.sessionId, parsed.accountId);
  if (!record) return reject("unknown_session");

  if (record.revokedAt !== null) return reject("revoked");

  if (now - record.issuedAt > ABSOLUTE_LIFETIME_MS) {
    await drop(AUTH_SCOPES.session, record.sid, record.accountId);
    return reject("absolute_timeout");
  }

  if (now - record.lastSeenAt > IDLE_TIMEOUT_MS) {
    await drop(AUTH_SCOPES.session, record.sid, record.accountId);
    return reject("idle_timeout");
  }

  // Live authority: the identity record, never the role snapshotted in the
  // session. If the identity is gone the session is not merely unauthorised,
  // it is orphaned.
  const identity = await getIdentity(record.accountId, record.orgId);
  if (!identity) {
    await drop(AUTH_SCOPES.session, record.sid, record.accountId);
    return reject("revoked");
  }
  if (record.roleEpoch !== identity.roleEpoch) {
    await drop(AUTH_SCOPES.session, record.sid, record.accountId);
    return reject("revoked");
  }
  if (record.orgEpoch !== identity.orgEpoch) {
    await drop(AUTH_SCOPES.session, record.sid, record.accountId);
    return reject("revoked");
  }

  // Passed every check: advance lastSeenAt. Only ever FORWARD, so a lost
  // concurrent read-modify-write cannot move the idle window backwards.
  if (record.lastSeenAt < now) {
    await patch<SessionRecord>(AUTH_SCOPES.session, record.sid, record.accountId, (cur) => ({
      ...cur,
      lastSeenAt: Math.max(cur.lastSeenAt, now),
    }));
    record.lastSeenAt = now;
  }

  return { ok: true, session: record, identity, token: token as string };
}

/** Milliseconds until this session is killed for inactivity (0 if already due). */
export function idleRemainingMs(session: SessionRecord, now = Date.now()): number {
  return Math.max(0, IDLE_TIMEOUT_MS - (now - session.lastSeenAt));
}

/** Milliseconds until this session is killed for absolute lifetime. */
export function absoluteRemainingMs(session: SessionRecord, now = Date.now()): number {
  return Math.max(0, ABSOLUTE_LIFETIME_MS - (now - session.issuedAt));
}

// ── Cookie extraction ────────────────────────────────────────────────────────

/**
 * Pull the session cookie out of a raw `Cookie` header.
 *
 * Implemented here rather than via `cookies()` from `next/headers` so that the
 * same enforcement path runs in a route handler AND in a test, with no request
 * context to fabricate. Route handlers call this; there is no second,
 * weaker way in.
 */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = pair.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      // A malformed percent-escape is a malformed token, not a crash.
      return value;
    }
  }
  return null;
}

// ── Revocation ───────────────────────────────────────────────────────────────

/** Revoke one session. */
export async function revokeSession(sessionId: string, accountId: string): Promise<boolean> {
  const patched = await patch<SessionRecord>(AUTH_SCOPES.session, sessionId, accountId, (cur) =>
    cur.revokedAt === null ? { ...cur, revokedAt: Date.now() } : cur,
  );
  return patched !== null;
}

/**
 * Revoke every session belonging to ONE identity (used when a password is
 * changed, and available for a "sign out everywhere" self-service action).
 *
 * Distinct from `revokeOrgSessions` in identity.ts, which bumps the epoch and
 * therefore also blocks sessions issued while the sweep runs.
 */
export async function revokeIdentitySessions(accountId: string): Promise<number> {
  const sessions = await listFor<SessionRecord>(AUTH_SCOPES.session, accountId);
  let count = 0;
  for (const session of sessions) {
    if (session.revokedAt === null) {
      await revokeSession(session.sid, accountId);
      count++;
    }
  }
  return count;
}

/** Every live session for an identity. Metadata only — no tokens. */
export async function listIdentitySessions(accountId: string): Promise<SessionRecord[]> {
  const sessions = await listFor<SessionRecord>(AUTH_SCOPES.session, accountId);
  return sessions.filter((s) => s.revokedAt === null);
}
