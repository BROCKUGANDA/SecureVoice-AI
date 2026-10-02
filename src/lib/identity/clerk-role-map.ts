/**
 * Clerk → WP-11 role mapping (WP-11).
 *
 * ── The situation this resolves ─────────────────────────────────────────────
 * This repository already has an identity system: Clerk. It is mounted in
 * `src/app/layout.tsx` as `ClerkProvider`, it backs `getProfile()` in
 * `src/lib/credits.ts`, and every existing console route calls
 * `requireSignedIn` / `requireOperator`, which read Clerk. That is the codebase's
 * operator sign-in and it keeps working — WP-11 does not replace it.
 *
 * WP-11 adds a SECOND, narrow path: invite-only provisioning with
 * server-enforced session policy and step-up. The brief forbids ADDING a second
 * identity system, and this is not one — it adds no new source of truth about
 * who a person IS. It adds session LIFECYCLE and step-up CONTROLS on top of the
 * `Account` model, and it needs Clerk's identities to be expressible in the same
 * role vocabulary so a single capability matrix governs both.
 *
 * So the only question this file answers is: a Clerk identity arrives with
 * `publicMetadata.role ∈ {operator, demo}`. What is that in the WP-11
 * vocabulary of Owner | Admin | Analyst | Auditor | ServiceAccount?
 *
 * ── The mapping ──────────────────────────────────────────────────────────────
 *   explicit `publicMetadata.platformRole` → used verbatim, if it names a role.
 *   "operator" → Admin
 *   "demo"     → Auditor
 *   anything else → Auditor  (least privilege)
 *
 * Two decisions worth stating:
 *
 *   · `operator` maps to Admin, NOT Owner. `Account`'s own comment calls
 *     operator "full platform access", and Owner in WP-11 confers exactly one
 *     extra power: granting or changing the Owner role (rbac.assertMayAssignRole).
 *     No existing account should acquire that implicitly because it predates the
 *     vocabulary. Granting Owner is an explicit act.
 *
 *   · `demo` maps to Auditor, i.e. READ-ONLY. `demo` is a guided simulation
 *     view. WP-11 has no "read-mostly"; a read-only role is the honest match,
 *     and it means a demo account cannot fire an intervention.
 *
 * An UNRECOGNISED role resolves to Auditor. A role string this module does not
 * understand must never widen access; that is the whole failure mode a
 * fail-open default has in a permission check.
 *
 * ── No Clerk import ──────────────────────────────────────────────────────────
 * This file deliberately imports nothing. `currentUser()` requires a live request
 * context and throws outside one, so keeping the mapping pure is what lets the
 * test gate exercise it — and lets it be unit-tested as a table rather than
 * through a mocked provider. The Clerk-dependent caller is
 * `src/lib/identity/clerk-bridge.ts`.
 */

import { isRole, ROLES, type Role } from "@/lib/auth/roles";

/** The subset of Clerk's public metadata WP-11 reads. */
export type ClerkRoleClaims = {
  /** Pre-WP-11 vocabulary. */
  role?: string | null;
  /** WP-11 vocabulary, if an operator has set one explicitly. */
  platformRole?: string | null;
};

/**
 * Resolve a Clerk role claim to a WP-11 role.
 *
 * Order matters: an explicit `platformRole` is an operator's stated intent and
 * wins over the legacy `role`. The legacy value is only a default.
 */
export function mapClerkRole(claims: ClerkRoleClaims | null | undefined): Role {
  // `isHonourableClerkRole`, not `isRole`: a Clerk user is a human, and
  // `ServiceAccount` is a machine role. Honouring that claim would let a
  // browser session claim an identity that is meant to be authenticated by a
  // producer key.
  const explicit = claims?.platformRole;
  if (isHonourableClerkRole(explicit)) return explicit;

  switch (claims?.role) {
    case "operator":
      return "Admin";
    case "demo":
      return "Auditor";
    default:
      // Unknown, absent, or null. Least privilege.
      return "Auditor";
  }
}

/**
 * Roles a Clerk identity may resolve to.
 *
 * `ServiceAccount` is excluded: it is a machine role, and a Clerk
 * `publicMetadata.platformRole` of `ServiceAccount` would mint a machine
 * identity out of a human's browser session. Any explicit claim naming it falls
 * back to the legacy mapping instead of being honoured.
 */
export function allowedClerkRoles(): readonly Role[] {
  return ROLES.filter((role) => role !== "ServiceAccount");
}

/** True when an explicit claim is a role this bridge will honour. */
export function isHonourableClerkRole(value: unknown): value is Role {
  return isRole(value) && value !== "ServiceAccount";
}