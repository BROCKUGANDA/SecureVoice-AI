/**
 * Session role -> WP-11 capability mapping (WP-11).
 *
 * ── The situation this resolves ─────────────────────────────────────────────
 * There are two ways a console identity arrives, and both must land on ONE role
 * scale so a single capability matrix governs every guard:
 *
 *   A. Better Auth (primary). The organization IS the tenant, so the role
 *      arrives as an organization MEMBERSHIP role on the session.
 *   B. First-party session (invite-only, step-up capable). Carries its own
 *      role claim.
 *
 * Neither path adds a new source of truth about WHO a person is. This module
 * only answers: a role string arrived, what is it in the WP-11 vocabulary of
 * Owner | Admin | Analyst | Auditor | ServiceAccount?
 *
 * ── The mapping ──────────────────────────────────────────────────────────────
 *   explicit `platformRole` -> used verbatim, if it names a role.
 *   "operator"             -> Admin
 *   "demo"                 -> Auditor
 *   anything else          -> Auditor  (least privilege)
 *
 * Two decisions worth stating:
 *
 *   · `operator` maps to Admin, NOT Owner. Owner in WP-11 confers exactly one
 *     extra power: granting or changing the Owner role
 *     (rbac.assertMayAssignRole). No existing account should acquire that
 *     implicitly because it predates the vocabulary. Granting Owner is an
 *     explicit act.
 *
 *   · `demo` maps to Auditor, i.e. READ-ONLY. `demo` is a guided simulation
 *     view. WP-11 has no "read-mostly"; a read-only role is the honest match,
 *     and it means a demo account cannot fire an intervention.
 *
 * An UNRECOGNISED role resolves to Auditor. A role string this module does not
 * understand must never widen access; that is the whole failure mode a fail-open
 * default has in a permission check.
 *
 * ── No provider import ───────────────────────────────────────────────────────
 * This file deliberately imports nothing but the role vocabulary. Reading a
 * session requires a live request context and throws outside one, so keeping the
 * mapping pure is what lets the test gate exercise it as a table rather than
 * through a mocked provider.
 */
import { isRole, ROLES, type Role } from "@/lib/auth/roles";

/** The subset of Clerk's public metadata WP-11 reads. */
export type SessionRoleClaims = {
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
export function mapSessionRole(claims: SessionRoleClaims | null | undefined): Role {
  // `isHonourableSessionRole`, not `isRole`: a Clerk user is a human, and
  // `ServiceAccount` is a machine role. Honouring that claim would let a
  // browser session claim an identity that is meant to be authenticated by a
  // producer key.
  const explicit = claims?.platformRole;
  if (isHonourableSessionRole(explicit)) return explicit;

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
export function allowedSessionRoles(): readonly Role[] {
  return ROLES.filter((role) => role !== "ServiceAccount");
}

/** True when an explicit claim is a role this bridge will honour. */
export function isHonourableSessionRole(value: unknown): value is Role {
  return isRole(value) && value !== "ServiceAccount";
}
