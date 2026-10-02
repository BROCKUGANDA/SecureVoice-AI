import "server-only";
/**
 * Clerk bridge (WP-11) — the seam between the two identity paths.
 *
 * ── Two paths, one role scale ────────────────────────────────────────────────
 *   A. Clerk (pre-existing). `ClerkProvider` is mounted in `src/app/layout.tsx`
 *      and `getProfile()` in `src/lib/credits.ts` reads the Clerk session. Every
 *      existing console route calls `requireSignedIn` / `requireOperator`. This
 *      is untouched and keeps working — WP-11 does not remove Clerk, and
 *      `layout.tsx` still mounts the provider.
 *
 *   B. First-party sessions (new in WP-11). Invite-only provisioning, a signed
 *      `sv_session` cookie, server-enforced idle/absolute limits, and step-up.
 *
 * They coexist because they answer different questions. Clerk answers "who is
 * this person and which organisation do they belong to". WP-11 answers "is this
 * SESSION still inside its idle and absolute bounds, and has the person at the
 * keyboard just proved it" — questions Clerk's session lifetime does not model
 * and this package could not retrofit into Clerk's provider.
 *
 * What they share is the ROLE SCALE, and that is the part that must not fork.
 * `mapClerkRole` (src/lib/identity/clerk-role-map.ts) is the single mapping, so
 * the capability matrix in `src/lib/auth/roles.ts` governs a Clerk-signed-in
 * Admin and an invite-provisioned Admin identically. Two role vocabularies
 * would mean `assertCapability` silently passing or failing depending on which
 * path produced the session.
 *
 * ── Clerk's own limits, stated honestly ──────────────────────────────────────
 * A Clerk session is NOT subject to this package's 15-minute idle or 8-hour
 * absolute policy, because those are enforced by `verifySession` against a
 * first-party session record. What a Clerk session does get, the moment it
 * crosses into first-party territory, is the capability matrix and step-up:
 * `requireCapability` / `requirePrivileged` accept a Clerk identity via
 * `resolveConsoleIdentity`, so an Admin on a Clerk session still cannot rotate a
 * producer key without a fresh re-authentication.
 *
 * WP-11 does NOT add a second identity system. It adds session lifecycle
 * controls and a role scale; Clerk remains the identity provider it already was.
 */

import { auth, currentUser } from "@clerk/nextjs/server";
import { mapClerkRole, type ClerkRoleClaims } from "@/lib/identity/clerk-role-map";
import { getProfile } from "@/lib/credits";
import { NO_ORG } from "@/lib/auth/identity";
import type { Role } from "@/lib/auth/roles";

export type ConsoleIdentity = {
  /** Stable id from whichever path produced the identity. */
  subjectId: string;
  email: string;
  name: string;
  role: Role;
  orgId: string;
  /** Which path authenticated this request. */
  source: "clerk" | "session";
};

/**
 * Resolve the signed-in console identity from Clerk.
 *
 * Called only from request handlers. `currentUser()` reads request context, so
 * this is unusable from a test without a request — which is exactly why the
 * mapping itself lives in the pure `clerk-role-map.ts`.
 *
 * Returns null when nobody is signed in. A signed-in Clerk user whose role
 * claim resolves to `Auditor` is NOT signed out — they are a signed-in reader,
 * and the capability matrix decides what they may do.
 */
export async function resolveClerkIdentity(): Promise<ConsoleIdentity | null> {
  const user = await currentUser();
  if (!user) return null;

  const email =
    user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "unknown";
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || email.split("@")[0];

  // Active Clerk organization (multi-tenant key) from the session claims —
  // the same read getProfile() performs.
  const { sessionClaims } = await auth();
  const orgId =
    (sessionClaims as { o?: { id?: string } } | undefined)?.o?.id ?? NO_ORG;

  return {
    subjectId: user.id,
    email,
    name,
    role: mapClerkRole(user.publicMetadata as ClerkRoleClaims | undefined),
    orgId,
    source: "clerk",
  };
}

/**
 * The Clerk session's identity as WP-11 understands it, reusing `getProfile()`
 * so the Clerk path keeps its existing single source of truth for the Clerk
 * user ↔ `UserProfile` sync and the credits wallet.
 *
 * Deliberately does NOT mint a first-party session: adopting one silently would
 * apply an 8-hour absolute limit to Clerk sign-ins without anyone deciding
 * that. See the module header.
 */
export async function resolveConsoleIdentity(): Promise<ConsoleIdentity | null> {
  const profile = await getProfile();
  if (!profile) return null;
  return {
    subjectId: profile.clerkUserId,
    email: profile.email,
    name: profile.name,
    role: mapClerkRole({ role: profile.role }),
    orgId: profile.orgId ?? NO_ORG,
    source: "clerk",
  };
}

export { mapClerkRole } from "@/lib/identity/clerk-role-map";