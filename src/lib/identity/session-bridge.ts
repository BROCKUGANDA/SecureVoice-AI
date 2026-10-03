/**
 * Identity seam (WP-11).
 *
 * ── One provider, two paths ────────────────────────────────────────────────────
 * Better Auth is the single identity provider (src/lib/better-auth.ts). Two
 * paths resolve a console identity from it:
 *
 *   A. Better Auth session. `auth.api.getSession({ headers })` reads the session
 *      ROW from the database, so revocation and role changes take effect on the
 *      next request rather than when a cache expires (hazard AU-4). This is what
 *      `getProfile()` does, and every console route goes through it.
 *
 *   B. First-party session (invite-only, step-up capable). Carries its own
 *      session record with an explicit idle/absolute/step-up policy.
 *
 * They coexist because they answer different questions. A answers "who is this";
 * B answers "was this proved at the keyboard recently enough". Neither is a
 * second source of truth about identity: both resolve to the same `Role` scale
 * through the single mapping in `session-role-map.ts`, so the capability matrix
 * in `src/lib/auth/roles.ts` governs every path.
 *
 * ── Why the cookie cache is never used for authorisation ─────────────────────
 * Better Auth's `session.cookieCache` is enabled for RENDERING only. Every
 * function in this file reads the database. A cached session is an eventually
 * consistent read, and an authorisation decision taken from one would let a
 * revoked operator keep access for the length of the cache window — which is
 * exactly the hole the session-revocation feature exists to close.
 */
import { getProfile } from "@/lib/credits";
import { NO_ORG } from "@/lib/auth/identity";
import type { Role } from "@/lib/auth/roles";
import { mapSessionRole } from "@/lib/identity/session-role-map";

export type ConsoleIdentity = {
  /** Stable id from whichever path produced the identity. */
  subjectId: string;
  email: string;
  name: string;
  role: Role;
  orgId: string;
  /** Which path authenticated this request. */
  source: "session";
};

/**
 * Resolve the signed-in console identity from the Better Auth session.
 *
 * Called only from request handlers. `auth.api.getSession({ headers })` reads
 * request context, so this is unusable from a test without a request - which is
 * exactly why the role mapping itself lives in the pure `session-role-map.ts`.
 *
 * Returns null when nobody is signed in. A signed-in user whose role claim
 * resolves to `Auditor` is NOT signed out - they are a signed-in reader, and the
 * capability matrix decides what they may do.
 */
export async function resolveSessionIdentity(): Promise<ConsoleIdentity | null> {
  // One authoritative read. `getProfile()` already performs this exact call and
  // additionally mirrors the identity into the UserProfile wallet, so delegating
  // keeps ONE source of truth for user <-> UserProfile sync (hazard AU-12: two
  // readers of the session is how a stale authorisation slips through).
  const profile = await getProfile();
  if (!profile) return null;

  return {
    subjectId: profile.userId,
    email: profile.email,
    name: profile.name,
    role: mapSessionRole({ role: profile.role }),
    orgId: profile.orgId ?? NO_ORG,
    source: "session",
  };
}

export { mapSessionRole } from "@/lib/identity/session-role-map";
