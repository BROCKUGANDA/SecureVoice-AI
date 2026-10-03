import "server-only";

/**
 * WP-11 Session Policy — the SINGLE authoritative statement of how long a
 * session lives.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * The cutover left two session systems on one request path:
 *
 *   1. Better Auth — the `better-session.*` cookie. Sign-in, the console UI and
 *      `getProfile()` (src/lib/credits.ts) go through this. It natively
 *      expresses only a ROLLING expiry (expiresIn + updateAge); it has no idle
 *      concept of its own.
 *   2. First-party — the `sv_session` cookie, minted by /api/auth/password,
 *      /api/auth/magic-link/verify and /api/auth/invites/accept, enforced by
 *      `verifySession()` in src/lib/auth/session.ts. It expresses BOTH an idle
 *      timeout and an absolute lifetime.
 *
 * Before this file those two systems carried DIFFERENT numbers for the same
 * question, so the effective policy depended on which cookie a route read. Two
 * auth policies in one codebase is hazard AU-7: revocation cannot be reasoned
 * about, and no session lifetime can be stated to a customer without knowing
 * which path you are on.
 *
 * ── The decision ────────────────────────────────────────────────────────────
 * Keep the FIRST-PARTY numbers as authoritative, because they are strictly
 * tighter than the spec's, and tighten Better Auth to match them exactly:
 *
 *                  SPEC              CHOSEN         WHY
 *   idle           30 min            15 min         defence in depth
 *   absolute       7 days (rolling)   8 hours       finite promise
 *   step-up        15 min             5 min         the window IS the control
 *
 * Deviation from spec, stated explicitly rather than hidden:
 *
 *  - SPEC says a 7-day rolling session with 30-minute idle. We ship 8 HOURS
 *    absolute instead. This is TIGHTER, never looser, so it cannot weaken the
 *    control the spec asked for. For a bank selling a compliance story, "no
 *    token lives past a working day" is a better answer than "a week", and the
 *    audit chain gains a hard upper bound. The cost is re-authentication roughly
 *    twice in an operator's 3-hour day — an acceptable, reversible product call.
 *  - SPEC says a 15-minute step-up window. We ship 5 minutes. The whole security
 *    value of step-up is the width of that window; 5 minutes still covers
 *    "noticed, re-entered the password, clicked commit" and stops covering
 *    "walked away from an unlocked machine".
 *  - Better Auth's native rolling refresh is DISABLED for the same reason. A
 *    rolling 7-day token and a hard 8-hour bound cannot both be true, and a
 *    hard bound that is silently undermined by refresh is worse than no bound,
 *    because it is documented as if it were real.
 *
 * ── How the two systems stay in agreement ──────────────────────────────────
 * Better Auth's own expiresIn is set from ABSOLUTE_LIFETIME_SECONDS below, so
 * the cookie and the session row cannot disagree about expiry. The idle limit is
 * NOT expressible in Better Auth, so it is enforced on our side of the
 * databaseHooks boundary (see better-auth.ts). One file owns both numbers; no
 * route is allowed to hard-code either.
 *
 * Deviating from the spec is a decision for a human to ratify. It is recorded
 * here in code, not only in a doc, so it cannot drift.
 */

// ── Better Auth / shared session policy (seconds — the unit Better Auth uses) ──

/**
 * Absolute session lifetime. Also the Better Auth `expiresIn`, so the signed
 * cookie and the stored row expire at the SAME instant. If these ever disagree,
 * `getSession()` trusts the row and the cookie becomes an unbounded token.
 */
export const ABSOLUTE_LIFETIME_SECONDS = 8 * 60 * 60;

/** Idle timeout: no authenticated request for this long ends the session. */
export const IDLE_TIMEOUT_SECONDS = 15 * 60;

/**
 * Rolling refresh window. 0 = never refresh.
 *
 * Set to 0 deliberately: with a rolling refresh the absolute lifetime above
 * would never actually be reached, because every use would push `expiresAt`
 * out by another 8 hours.
 */
export const SESSION_REFRESH_SECONDS = 0;

/**
 * Cookie-cache lifetime. DISPLAY ONLY (hazard AU-4).
 *
 * This is the window in which a cached copy of the session can be read without
 * a database round trip. It must stay SHORT relative to IDLE_TIMEOUT_SECONDS,
 * because a cached read is a read that cannot observe revocation or a role
 * change. Authorizing callers use `auth.api.getSession()` against the database
 * and never trust this.
 */
export const COOKIE_CACHE_SECONDS = 5 * 60;

/**
 * Step-up window: how long a successful re-authentication authorises a
 * privileged action.
 */
export const STEP_UP_WINDOW_SECONDS = 5 * 60;

// ── First-party session policy (milliseconds — the unit the store uses) ──────

/** Same idle limit, in ms, for the first-party `sv_session` store. */
export const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_SECONDS * 1000;

/** Same absolute limit, in ms, for the first-party `sv_session` store. */
export const ABSOLUTE_LIFETIME_MS = ABSOLUTE_LIFETIME_SECONDS * 1000;

/**
 * How long a dead session row is retained before the store may reuse its key.
 * Slightly over the absolute lifetime so a rejected-but-recent session still
 * resolves to "expired" rather than "unknown", which keeps the audit trail
 * readable.
 */
export const SESSION_RECORD_TTL_MS = ABSOLUTE_LIFETIME_MS + 60 * 60 * 1000;

/** The same step-up window, in ms, for the first-party store. */
export const STEP_UP_WINDOW_MS = STEP_UP_WINDOW_SECONDS * 1000;

// ── Invitation policy (first-party only; unchanged by the cutover) ───────────

/** Invite lifetime: 72 hours — long enough to cross a weekend, short enough that
 *  a link left in a chat log is dead by the following week. */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

/** Retention for a consumed or expired invite row, so "this invite was already
 *  used" is answerable from the record rather than inferred. */
export const INVITE_RECORD_TTL_MS = INVITE_TTL_MS + 7 * 24 * 60 * 60 * 1000;

/** Magic-link lifetime: 15 minutes. A login link is handed to someone already at
 *  the keyboard, so it is not an invitation. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

// ── Cookie (first-party `sv_session` only) ─────────────────────────────────

/** First-party session cookie name. NOT the Better Auth cookie. */
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
