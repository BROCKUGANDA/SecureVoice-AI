import "server-only";
/**
 * Identity records (WP-11) — the first-party account and its revocation state.
 *
 * ── What is stored where ─────────────────────────────────────────────────────
 * `Account` (prisma/schema.prisma) is the account record: `email` (unique),
 * `name`, `role`, `passwordHash`. WP-11 may not add a migration, so these four
 * columns plus `id`/`createdAt` are the entire durable identity surface — which
 * is enough, and is why the brief points at this model.
 *
 * What `Account` CANNOT hold, and therefore lives in the auth store
 * (src/lib/auth/store.ts):
 *   · `orgId`     — `Account` has no tenancy column. Org binding is a separate
 *                   record keyed by accountId.
 *   · `roleEpoch` — the counter that makes role change revoke sessions.
 *   · `orgEpoch`  — the counter that makes revoke-all-sessions work.
 *
 * A counter rather than a delete-the-rows approach: revoking "every session for
 * this identity" requires either enumerating sessions (a partial write, which
 * misses concurrent issuance) or an epoch that new sessions must match. The
 * epoch is a single atomic field, so there is no window in which a session
 * issued during the revocation survives it.
 *
 * ── `Account.role` vs `IDENTITY.role` ────────────────────────────────────────
 * The auth-store record is the AUTHORITY for authorisation. `Account.role` is
 * kept in sync as a mirror because it is the column the pre-existing console
 * path reads, and two code paths reading two different role columns is exactly
 * the failure this package exists to prevent. Both are written in `setRole`
 * (and only there), so they cannot drift apart through this module.
 */

import { db } from "@/lib/db";
import { AUTH_SCOPES, PERMANENT_EXPIRY, listFor, put, read } from "@/lib/auth/store";
import { DEFAULT_ORG_ID } from "@/lib/tenancy/guard";
import { isRole, type Role } from "@/lib/auth/roles";
import { normalizeEmail } from "@/lib/auth/password";

/** The namespace an account with no Clerk organization shares with seeded rows.
 *  Identical to the tenancy guard's default namespace on purpose: an org-less
 *  first-party account must land in the same bucket as an org-less Clerk one,
 *  or the two would see different data for the same visible workspace. */
export const NO_ORG = DEFAULT_ORG_ID;

export type Identity = {
  accountId: string;
  email: string;
  name: string;
  role: Role;
  orgId: string;
  /** Bumped on every role change. A session carrying an older epoch is dead. */
  roleEpoch: number;
  /** Bumped on every org-wide revocation. Same rule. */
  orgEpoch: number;
  createdAt: number;
};

/**
 * Roles that may hold an interactive session. `ServiceAccount` is a machine
 * identity: it authenticates to ingest with a producer key, never with a cookie,
 * so it is deliberately not something an invitation can mint.
 */
export const CONSOLE_ROLES: readonly Role[] = ["Owner", "Admin", "Analyst", "Auditor"];

export class IdentityError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "unknown_account"
      | "email_taken"
      | "invalid_role"
      | "no_such_member"
      | "last_owner"
      | "role_ceiling"
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

function assertRole(value: unknown): Role {
  if (!isRole(value)) throw new IdentityError(`Unknown role: ${String(value)}`, "invalid_role");
  return value;
}

function orgOrDefault(orgId: string | null | undefined): string {
  return orgId && orgId.length > 0 ? orgId : NO_ORG;
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * The identity record, or null.
 *
 * Reconstructs from `Account` if the auth record is missing (a database restored
 * from a pre-WP-11 backup), so an account can never be permanently
 * un-authorisable because of a lost store row. The reconstruction starts both
 * epochs at 1, which means any session issued before the restore is refused —
 * the fail-closed direction.
 */
export async function getIdentity(
  accountId: string,
  orgId?: string | null
): Promise<Identity | null> {
  const org = orgOrDefault(orgId);
  const stored = await read<Identity>(AUTH_SCOPES.identity, accountId, org);
  if (stored) return stored;
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });
  if (!account) return null;
  return {
    accountId: account.id,
    email: account.email,
    name: account.name,
    // A legacy row may hold "operator"/"demo" — mapped, never passed through.
    role: legacyRoleToPlatformRole(account.role),
    orgId: org,
    roleEpoch: 1,
    orgEpoch: 1,
    createdAt: account.createdAt.getTime(),
  };
}

export async function getIdentityByEmail(email: string): Promise<Identity | null> {
  const normalized = normalizeEmail(email);
  const account = await db.account.findUnique({
    where: { email: normalized },
    select: { id: true },
  });
  if (!account) return null;
  // Email is globally unique on Account, so the identity row is unambiguous
  // even though we do not know the org yet.
  return getIdentity(account.id);
}

/**
 * Every member of an organisation. Used by the revocation sweep and the
 * "last Owner" check.
 */
export async function listOrgMembers(orgId: string | null | undefined): Promise<Identity[]> {
  return listFor<Identity>(AUTH_SCOPES.identity, orgOrDefault(orgId));
}

// ── Create ───────────────────────────────────────────────────────────────────

export type CreateIdentityInput = {
  email: string;
  name: string;
  role: Role;
  orgId?: string | null;
  passwordHash?: string;
  /** Explicit account id — lets a caller reuse an id it already chose. */
  accountId?: string;
};

/**
 * Create the account and its identity record.
 *
 * Email uniqueness is enforced by the `Account.email` unique index, not by a
 * pre-check, so two concurrent attempts to create the same address cannot both
 * succeed.
 */
export async function createIdentity(input: CreateIdentityInput): Promise<Identity> {
  const email = normalizeEmail(input.email);
  const role = assertRole(input.role);
  if (!CONSOLE_ROLES.includes(role)) {
    throw new IdentityError(
      `Role ${role} does not hold an interactive session and cannot be created here.`,
      "role_ceiling"
    );
  }
  const orgId = orgOrDefault(input.orgId);

  const account = await db.account.create({
    data: {
      id: input.accountId,
      email,
      name: input.name,
      role,
      passwordHash: input.passwordHash ?? "",
    },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });

  const identity: Identity = {
    accountId: account.id,
    email: account.email,
    name: account.name,
    role,
    orgId,
    roleEpoch: 1,
    orgEpoch: 1,
    createdAt: account.createdAt.getTime(),
  };
  // The member list is permanent, not a session with a TTL.
  await put(AUTH_SCOPES.identity, identity.accountId, orgId, identity, PERMANENT_EXPIRY);
  return identity;
}

// ── Role change (item 6: automatic revocation on role change) ────────────────

export type SetRoleResult = { ok: true; identity: Identity; previousRole: Role };

/**
 * Change a role and REVOKE EVERY EXISTING SESSION for that identity.
 *
 * The revocation is the point, not a side effect. A session carries the
 * `roleEpoch` and `orgEpoch` it was issued under; `verifySession` (session.ts)
 * refuses any session whose epochs do not match the identity's current ones. So
 * incrementing `roleEpoch` invalidates every live session at once, without
 * enumerating them and without a window where a concurrently-issued session
 * survives.
 *
 * It fires for UPGRADES as well as downgrades. The brief says "automatic
 * revocation on role change"; applying it only to demotions would leave a
 * promoted user's pre-promotion session alive, which is precisely the session
 * that was issued while they had the LOWER role.
 *
 * The audit append happens BEFORE the write and is allowed to throw — a role
 * change that cannot be recorded in the tamper-evident chain does not happen.
 * The caller passes the audit callback in, which keeps this module free of a
 * dependency cycle with the callers of auth/audit.ts.
 */
export async function setRole(
  accountId: string,
  orgId: string | null | undefined,
  nextRole: Role,
  auditRequired: () => Promise<void>
): Promise<SetRoleResult> {
  const org = orgOrDefault(orgId);
  const role = assertRole(nextRole);
  const current = await getIdentity(accountId, org);
  if (!current) {
    throw new IdentityError(`No identity ${accountId} in ${org}.`, "no_such_member");
  }

  // Refuse to remove the last Owner: an organisation with no Owner cannot be
  // administered, and the only people who could fix it are the ones we just
  // locked out.
  if (current.role === "Owner" && role !== "Owner") {
    const owners = (await listOrgMembers(org)).filter((m) => m.role === "Owner");
    if (owners.length <= 1) {
      throw new IdentityError(
        "This is the only Owner in the organization. Promote another member first.",
        "last_owner"
      );
    }
  }

  // Audit BEFORE the write, and let it throw.
  await auditRequired();

  const updated: Identity = {
    ...current,
    role,
    roleEpoch: current.roleEpoch + 1,
  };
  // Mirror the role onto the Account column in the same logical step.
  await db.account.update({
    where: { id: accountId },
    data: { role },
    select: { id: true },
  });
  await put(AUTH_SCOPES.identity, accountId, org, updated, PERMANENT_EXPIRY);
  return { ok: true, identity: updated, previousRole: current.role };
}

// ── Org-wide revocation (item 6: revoke-all-sessions) ────────────────────────

export type RevokeOrgResult = { revokedSessions: number; members: number; orgEpoch: number };

/**
 * Revoke every session in an organisation by bumping each member's `orgEpoch`.
 *
 * Bumping the epoch (rather than deleting session rows) is what makes this
 * correct under concurrency: a session created while the sweep is running is
 * issued with the NEW epoch and stays valid, while every session issued before
 * the sweep carries the OLD one and dies. Deleting rows would leave exactly that
 * race open — a session minted mid-sweep survives the "revoke all".
 *
 * `orgEpoch` is bumped on every member including the caller, so an admin who
 * triggers a mass revocation is logged out too. That is intended: "revoke all
 * sessions" that spares the person who asked for it is not what an incident
 * responder means.
 */
export async function revokeOrgSessions(
  orgId: string | null | undefined
): Promise<RevokeOrgResult> {
  const org = orgOrDefault(orgId);
  const members = await listOrgMembers(org);
  let revoked = 0;
  let highest = 1;
  for (const member of members) {
    const next: Identity = { ...member, orgEpoch: member.orgEpoch + 1 };
    await put(AUTH_SCOPES.identity, member.accountId, org, next, PERMANENT_EXPIRY);
    revoked++;
    highest = Math.max(highest, next.orgEpoch);
  }
  return { revokedSessions: revoked, members: members.length, orgEpoch: highest };
}

// ── Legacy role mapping ──────────────────────────────────────────────────────

/**
 * Pre-WP-11 `Account.role` values -> the WP-11 vocabulary.
 *
 * `operator` was "full platform access" and `demo` was a guided read-mostly
 * view. Mapping operator -> Admin (not Owner) is deliberate: Owner confers the
 * ability to change roles, and no row that predates this package should acquire
 * that by existing. An Owner is granted explicitly.
 */
export function legacyRoleToPlatformRole(raw: string | null | undefined): Role {
  switch (raw) {
    case "Owner":
    case "Admin":
    case "Analyst":
    case "Auditor":
    case "ServiceAccount":
      return raw;
    case "operator":
      return "Admin";
    case "demo":
      return "Auditor";
    default:
      // Unknown or absent role grants the least privilege. A role string this
      // module does not recognise must never widen access.
      return "Auditor";
  }
}