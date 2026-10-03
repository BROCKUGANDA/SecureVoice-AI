import "server-only";
//
// The session policy has MOVED to `@/lib/auth/session-policy`.
//
// The Clerk -> Better Auth cutover briefly left TWO session systems on the same
// request path carrying DIFFERENT numbers for the same question (hazard AU-7):
// this module held 15min idle / 8h absolute while better-auth.ts held a rolling
// 12h, so which limit applied depended on which cookie a route read. One file now
// owns both numbers, so neither can drift from the other.

/**
 * Compatibility shim — the session policy now lives in ONE place.
 *
 * Historically this file held both the session numbers and the cookie settings,
 * and `better-auth.ts` carried a SECOND, different set. That divergence was
 * hazard AU-7. Every number now originates in `@/lib/auth/session-policy`, which
 * documents the chosen values and the deviation from the specification.
 *
 * This module re-exports rather than redefines so that the many existing
 * `@/lib/auth/constants` importers (guards, session store, invite, step-up, the
 * /api/auth/* routes and their tests) keep working unchanged, while there is
 * physically only one definition of "how long is a session good for".
 */
export {
  ABSOLUTE_LIFETIME_MS,
  ABSOLUTE_LIFETIME_SECONDS,
  COOKIE_CACHE_SECONDS,
  IDLE_TIMEOUT_MS,
  IDLE_TIMEOUT_SECONDS,
  INVITE_RECORD_TTL_MS,
  INVITE_TTL_MS,
  MAGIC_LINK_TTL_MS,
  SESSION_COOKIE_ATTRS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_VERSION,
  SESSION_RECORD_TTL_MS,
  SESSION_REFRESH_SECONDS,
  STEP_UP_WINDOW_MS,
  STEP_UP_WINDOW_SECONDS,
} from "@/lib/auth/session-policy";
