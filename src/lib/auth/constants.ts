import "server-only";
/**
 * WP-11 Authentication — policy constants.
 *
 * Every number in this file is a CONTROL, not a default. They are frozen here
 * so that "how long is a session good for" has exactly one answer in the
 * codebase, and so the test gate can import the same constants it is
 * asserting against instead of hard-coding a duplicate that can drift.
 *
 * The two session limits are deliberately different KINDS of limit:
 *
 *   IDLE_TIMEOUT_MS     — "how long may a session sit unused". Bounds the
 *                         damage from a walk-away-from-an-open-laptop. This is
 *                         the limit that catches session hijacking.
 *   ABSOLUTE_LIFETIME_MS — "how long may a session exist at all, no matter how
 *                         busy it is". Bounds the damage from an immortal
 *                         token. This is the limit that makes "log out
 *                         everywhere" a finite promise and stops a
 *                         continuously-used session from never expiring.
 *
 * An 8-hour absolute lifetime with a 15-minute idle timeout means an operator
 * whose day is 3 hours long re-authenticates roughly twice, and never holds a
 * bearer token overnight.
 */

// ── Session policy (server-enforced; see src/lib/auth/session.ts) ──────────────

/** Idle timeout: 15 minutes without an authenticated request kills the session. */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** Absolute session lifetime: 8 hours from issue, regardless of activity. */
export const ABSOLUTE_LIFETIME_MS = 8 * 60 * 60 * 1000;

/**
 * How long a row for a dead session is kept before the store may reuse its
 * key. Slightly over the absolute lifetime so a rejected-but-recent session
 * still resolves to the "expired" reason rather than "unknown", which makes
 * the audit trail readable.
 */
export const SESSION_RECORD_TTL_MS = ABSOLUTE_LIFETIME_MS + 60 * 60 * 1000;

// ── Invite policy ────────────────────────────────────────────────────────────

/** Invite lifetime: 72 hours. Long enough to travel across a weekend, short
 *  enough that a link left in a chat log is dead by the following week. */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

/** Store retention for an invite row after it is consumed or expired — kept so
 *  "this invite was already used" is answerable from the record, not inferred. */
export const INVITE_RECORD_TTL_MS = INVITE_TTL_MS + 7 * 24 * 60 * 60 * 1000;

/** Magic-link lifetime: 15 minutes. A login link is not an invitation; it is
 *  handed to someone who is already at the keyboard. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

// ── Step-up policy ───────────────────────────────────────────────────────────

/**
 * How long a successful re-authentication authorises a privileged action.
 *
 * This is the whole security value of step-up, so it is SHORT. Five minutes
 * covers "user noticed, re-entered their password, clicked commit" without
 * covering "user stepped away from an unlocked machine for an hour". The
 * privileged action is the thing being protected; the window bounds how long a
 * granted step-up can be spent on something the re-authenticator may no longer
 * be looking at.
 */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

// ── Cookie ───────────────────────────────────────────────────────────────────

/** First-party session cookie. NOT a Clerk cookie — see src/lib/identity. */
export const SESSION_COOKIE_NAME = "sv_session";

/** Cookie value prefix + version tag, so a future format change is detectable
 *  rather than being mis-parsed as a malformed token (and locked out). */
export const SESSION_COOKIE_VERSION = "sv1";

/**
 * `Secure` is on in production. `SameSite=Lax` is required, not optional: it is
 * what stops another origin from driving an authenticated POST to these routes.
 * `HttpOnly` is non-negotiable — a session token readable from JS is a session
 * token an XSS can steal with no user interaction.
 */
export const SESSION_COOKIE_ATTRS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
} as const;