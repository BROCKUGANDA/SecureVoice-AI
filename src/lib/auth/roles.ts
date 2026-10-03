import "server-only";
/**
 * Roles and capabilities (WP-11).
 *
 * ── The decision this file encodes ───────────────────────────────────────────
 * Roles are NOT a linear ladder, so they are not modelled as one. `Auditor` is
 * read-only and that is its whole job; `ServiceAccount` is a machine that may
 * never touch the console at all. Modelling them as ranks above `Analyst`
 * would mean `Auditor` could write something, which is the specific outcome
 * this matrix exists to prevent.
 *
 * So authorisation is expressed as a CAPABILITY set, and a role is only a
 * named bundle of capabilities. Adding a capability to a role is a visible
 * one-line diff; adding it to the ladder would silently grant it to every role
 * above.
 *
 * `Owner` and `Admin` differ in exactly one way that matters — an Admin may
 * not change an Owner, and may not remove the last Owner. Everything else they
 * share. That difference is enforced in `assertMayAssignRole`
 * (src/lib/auth/rbac.ts), not by widening the matrix, because a matrix cannot
 * express "this role may act on that role".
 */

// ── Roles ────────────────────────────────────────────────────────────────────

export const ROLES = ["Owner", "Admin", "Analyst", "Auditor", "ServiceAccount"] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// ── Capabilities ─────────────────────────────────────────────────────────────

export const CAPABILITIES = [
  // Reading platform data.
  "case:read",
  "intervention:read",
  "audit:read",
  "member:read",
  "producerKey:read",
  "byok:read",
  // Acting on cases.
  "case:write",
  "case:fire",
  // Changing the organisation.
  "member:invite",
  "member:setRole",
  "producerKey:rotate",
  "byok:change",
  "settings:write",
  "export:bulk",
  "org:revokeSessions",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Capabilities that MUTATE state. `Auditor` is refused every one of them at the
 * data-access layer, which is what makes "read-only" a property of the role
 * rather than a property of how carefully each route handler remembers to only
 * call `findMany`.
 */
export const WRITE_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "case:write",
  "case:fire",
  "member:invite",
  "member:setRole",
  "producerKey:rotate",
  "byok:change",
  "settings:write",
  "export:bulk",
  "org:revokeSessions",
]);

export function isWriteCapability(cap: Capability): boolean {
  return WRITE_CAPABILITIES.has(cap);
}

const READ_ALL: readonly Capability[] = [
  "case:read",
  "intervention:read",
  "audit:read",
  "member:read",
  "producerKey:read",
  "byok:read",
];

/**
 * The matrix. Frozen so a stray `matrix.Admin.push(...)` at runtime fails, and
 * so `verifyRoleMatrix()` in the test gate can assert that every capability is
 * explicitly claimed by at least one role — a capability nobody holds is dead
 * weight, and one everybody holds is a missing review.
 */
export const ROLE_CAPABILITIES: Readonly<Record<Role, ReadonlySet<Capability>>> = Object.freeze({
  Owner: new Set<Capability>([...READ_ALL, ...WRITE_CAPABILITIES]),
  Admin: new Set<Capability>([
    ...READ_ALL,
    "case:write",
    "case:fire",
    "member:invite",
    "member:setRole",
    "producerKey:rotate",
    "byok:change",
    "settings:write",
    "export:bulk",
    "org:revokeSessions",
  ]),
  // Works the queue, cannot change the organisation.
  Analyst: new Set<Capability>([...READ_ALL, "case:write", "case:fire", "export:bulk"]),
  // Read-only. No write capability appears here, and `rbacDb` refuses writes for
  // this role independently of the matrix.
  Auditor: new Set<Capability>([...READ_ALL]),
  // A machine identity. It authenticates to ingest endpoints with a producer
  // key, not with a session cookie, so it holds NO console capability. It is
  // listed because it is a role an Admin can assign and the matrix must say
  // what it means rather than leaving it undefined.
  ServiceAccount: new Set<Capability>([]),
});

export function roleHas(role: Role, cap: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(cap);
}

export function isReadOnlyRole(role: Role): boolean {
  return WRITE_CAPABILITIES.size > 0 && [...WRITE_CAPABILITIES].every((c) => !roleHas(role, c));
}

// ── Privileged actions requiring step-up ─────────────────────────────────────

/**
 * The five actions that require a fresh re-authentication even for a role that
 * is allowed to perform them.
 *
 * Step-up is not a second role check — the role check already passed. It answers
 * a different question: is the human at the keyboard right now the one who was
 * authorised when the session started? A session that was stolen an hour after a
 * legitimate Admin logged in has a perfectly valid Admin role; only
 * re-entering the credential distinguishes it.
 *
 * These are the actions where being wrong is expensive and not obviously
 * reversible: money frozen, a credential rotated, an external party trusted,
 * another human granted access, or a whole organisation's data leaving.
 */
export const PRIVILEGED_ACTIONS = [
  "commit_freeze",
  "rotate_producer_key",
  "change_byok_credential",
  "invite_admin",
  "export_bulk_data",
] as const;

export type PrivilegedAction = (typeof PRIVILEGED_ACTIONS)[number];

export function isPrivilegedAction(value: unknown): value is PrivilegedAction {
  return typeof value === "string" && (PRIVILEGED_ACTIONS as readonly string[]).includes(value);
}

/**
 * The capability a caller must ALSO hold for the step-up to be meaningful. A
 * step-up grant is not a privilege: possessing one while holding `Auditor`
 * still cannot freeze a card, because the role check runs first and the
 * step-up check second.
 */
export const PRIVILEGED_ACTION_CAPABILITY: Readonly<Record<PrivilegedAction, Capability>> =
  Object.freeze({
    commit_freeze: "case:write",
    rotate_producer_key: "producerKey:rotate",
    change_byok_credential: "byok:change",
    invite_admin: "member:invite",
    export_bulk_data: "export:bulk",
  });

/** Human-facing description, used in the 403 body so the UI can prompt sensibly. */
export const PRIVILEGED_ACTION_LABEL: Readonly<Record<PrivilegedAction, string>> = Object.freeze({
  commit_freeze: "committing a card freeze",
  rotate_producer_key: "rotating a producer key",
  change_byok_credential: "changing the BYOK credential",
  invite_admin: "inviting an administrator",
  export_bulk_data: "exporting bulk data",
});
