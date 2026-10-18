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
import { AUTH_SCOPES, PERMANENT_EXPIRY, listByKey, listFor, put, read } from "@/lib/auth/store";
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
      | "role_ceiling",
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
  orgId?: string | null,
): Promise<Identity | null> {
  const org = orgOrDefault(orgId);
  const stored = await read<Identity>(AUTH_SCOPES.identity, accountId, org);
  if (stored) return stored;
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });
  if (!account) return null;
  // email/name are nullable on the model because Better Auth's own credential
  // signup does not write them (see the Account model). A row created by
  // Better Auth instead of the first-party path is therefore not a first-party
  // Identity and is rejected here rather than being given a placeholder that
  // would silently authenticate a user with a fabricated address.
  if (!account.email || !account.name) return null;
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

/**
 * The identity for an email, resolved through the one path that can answer it.
 *
 * This used to call `getIdentity(account.id)` with no org, beside a comment
 * asserting that email uniqueness made the row unambiguous. That sentence was the
 * whole bug (docs/GAP-REGISTER.md §31). Email uniqueness identifies the `Account`;
 * the identity store is keyed `(accountId, orgId)`. Reading at `NO_ORG` missed the
 * row the invite path wrote at the member's real org — and because a store miss
 * does not fail but *reconstructs*, the miss came back looking like a valid
 * identity with `roleEpoch: 1`. So a password reset bumped a row nobody validates,
 * and sessions issued before the reset went on verifying.
 */
export async function getIdentityByEmail(email: string): Promise<Identity | null> {
  const normalized = normalizeEmail(email);
  const account = await db.account.findUnique({
    where: { email: normalized },
    select: { id: true },
  });
  if (!account) return null;
  return resolveIdentityForAccount(account.id);
}

/**
 * The stored identity for an account, without the caller having to know its org.
 *
 * One read path for "who is this account", shared with `loginWithPassword`, which
 * made the same org-less guess. Rules in order, and why each is that way:
 *
 *  1. One row bound to a real org → that row. This is the normal case: an invited
 *     member has exactly one, and its role and epochs are authoritative. Using it
 *     is what makes `roleEpoch` revocation reach the session at all, because
 *     `issueSession` then records the same org that `verifySession` reads back
 *     (src/lib/auth/session.ts:275).
 *  2. More than one real-org row → refuse, never choose. Multi-org membership is
 *     not materialized today (`createIdentity` cannot write a second row for a
 *     unique email), so this branch is unreachable rather than unimportant: picking
 *     an org silently would be a privilege decision made by iteration order. Login
 *     fails, and the log says why.
 *  3. Only a `NO_ORG` row → that row. Such rows exist because earlier versions of
 *     this module wrote them; honouring them keeps those sessions revocable instead
 *     of stranding them.
 *  4. No stored row → reconstruct from `Account` at `NO_ORG`, exactly as
 *     `getIdentity` always did. That is the documented restored-database path, and it
 *     still starts both epochs at 1, so sessions issued before a restore are refused.
 */
export async function resolveIdentityForAccount(accountId: string): Promise<Identity | null> {
  const stored = await listByKey<Identity>(AUTH_SCOPES.identity, accountId);
  const inRealOrg = stored.filter((i) => i.orgId !== NO_ORG);
  if (inRealOrg.length === 1) return inRealOrg[0] ?? null;
  if (inRealOrg.length > 1) {
    console.error(
      `[identity] refusing to pick an org for account ${accountId}: rows in ${inRealOrg.length} organisations`,
    );
    return null;
  }
  if (stored.length === 1) return stored[0] ?? null;
  if (stored.length > 1) {
    // Several rows that are all unbound cannot be told apart by org either.
    console.error(`[identity] refusing: account ${accountId} has ${stored.length} unbound rows`);
    return null;
  }
  return getIdentity(accountId);
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
      "role_ceiling",
    );
  }
  const orgId = orgOrDefault(input.orgId);

  // ── Better Auth shape ─────────────────────────────────────────────────────
  // `Account` is now Better Auth's credential table, so a row is
  // (userId, providerId, accountId) and it is REQUIRED to reference a `User`.
  // A first-party invited operator has no Better Auth session yet, so this
  // creates the backing `user` first and then attaches a `credential` account
  // to it — the same two-row shape Better Auth's own email/password signup
  // produces. Doing it in one nested write keeps it atomic: an Account with no
  // User is not a state this codebase can reach.
  //
  // `passwordHash` stays required and is written here because the first-party
  // auth store (src/lib/auth/password.ts) verifies scrypt digests against it;
  // Better Auth's own hash column is left null because we do not use its
  // credential verifier for these accounts.
  const account = await db.account.create({
    data: {
      user: {
        create: {
          email,
          name: input.name,
          emailVerified: true,
        },
      },
      email,
      name: input.name,
      role,
      passwordHash: input.passwordHash ?? "",
      // Better Auth identifies a credential account by the provider plus the
      // account-scoped id. Email/password uses the literal provider "credential".
      providerId: "credential",
      accountId: input.accountId ?? email,
    },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });

  // Non-null because this row was just created by the first-party path with
  // both values written explicitly; the nullable-on-read path above is the one
  // that has to defend against a Better Auth-created row.
  const identity: Identity = {
    accountId: account.id,
    email: account.email ?? email,
    name: account.name ?? input.name,
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

/**
 * Replace an identity's password hash and revoke every live session for it.
 *
 * Used only by the password-reset flow (src/lib/auth/password-reset.ts). The
 * session revocation is the security-relevant half: a reset exists precisely
 * because the operator believes their password may be compromised, so any
 * session an attacker holds must die the moment the real owner recovers
 * control. Bumping `roleEpoch` achieves that without enumerating sessions —
 * every live session carries the epoch it was issued under and `verifySession`
 * refuses any mismatch — the same mechanism setRole uses.
 *
 * The hash is written to the first-party `passwordHash` column, matching
 * createIdentity: Better Auth's own hash column is left untouched because this
 * codebase verifies these accounts with its own scrypt/argon2 store.
 */
export async function setIdentityPassword(input: {
  accountId: string;
  orgId: string | null | undefined;
  passwordHash: string;
  auditRequired: () => Promise<void>;
}): Promise<{ ok: true; identity: Identity } | { ok: false; reason: "no_such_member" }> {
  const org = orgOrDefault(input.orgId);
  const current = await getIdentity(input.accountId, org);
  if (!current) {
    return { ok: false, reason: "no_such_member" };
  }

  // Audit BEFORE the write, and let it throw — a password change that cannot be
  // recorded in the tamper-evident chain does not happen.
  await input.auditRequired();

  await db.account.update({
    where: { id: input.accountId },
    data: { passwordHash: input.passwordHash },
    select: { id: true },
  });

  const updated: Identity = { ...current, roleEpoch: current.roleEpoch + 1 };
  await put(AUTH_SCOPES.identity, input.accountId, org, updated, PERMANENT_EXPIRY);
  return { ok: true, identity: updated };
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
  auditRequired: () => Promise<void>,
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
        "last_owner",
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
  orgId: string | null | undefined,
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
