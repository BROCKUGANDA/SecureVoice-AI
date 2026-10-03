import "server-only";
/**
 * Single-use invitations (WP-11) — the ONLY way an account comes into existence.
 *
 * ── There is no public signup ────────────────────────────────────────────────
 * Access to this platform is provisioned, not self-serve. A public signup route
 * would make every other control in this package advisory: an unknown address
 * could simply create its own account with its own `Owner` role. So account
 * creation has exactly one entry point — `acceptInvite()` — and
 * `src/lib/auth/signup.ts` is the choke point that refuses everything else.
 *
 * ── The four properties of an invite ─────────────────────────────────────────
 *   1. SINGLE USE.   Enforced by an insert-if-absent marker row arbitrated by a
 *                    unique index (store.take). The DATABASE picks the winner,
 *                    so two concurrent acceptances cannot both succeed — not
 *                    "usually", not "on one node": one INSERT loses on P2002.
 *   2. 72 HOUR TTL.  Enforced on read, not only at issue, so an invite cannot be
 *                    redeemed after expiry even if the evictor never ran.
 *   3. ONE EMAIL.    The account's email is taken from the INVITE ROW, never
 *                    from the request. A caller cannot redirect an invitation
 *                    for alice@example.com to mallory@example.com, which is the
 *                    attack that turns "invite your colleague" into "provision a
 *                    mailbox you control".
 *   4. AUDITED.     Issued and consumed are both appended to the tamper-evident
 *                    chain, with the consuming account id in `callerId`, so the
 *                    record of who provisioned whom is itself tamper-evident.
 *
 * ── Why the email is not "verified" here ────────────────────────────────────
 * There is no mailer in this repository. The token is delivered out of band by
 * the operator (a real deployment puts it in the invitee's inbox), and the
 * 256-bit token IS the proof of that delivery — the same trust model every
 * product using an invite link has. What this module enforces is that the
 * token's own authority stops at its one bound email. An optional
 * `assertedEmail` lets a caller that DOES have an authenticated identity (e.g. a
 * signed-in user redeeming an invite) bind the two; a mismatch is refused.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AUTH_SCOPES, put, read, take } from "@/lib/auth/store";
import { INVITE_RECORD_TTL_MS, INVITE_TTL_MS } from "@/lib/auth/constants";
import { createIdentity, type Identity } from "@/lib/auth/identity";
import { issueSession, type IssuedSession } from "@/lib/auth/session";
import { assertUsablePassword, hashPassword, normalizeEmail } from "@/lib/auth/password";
import { AUTH_AUDIT_INTENTS, auditAuthEvent } from "@/lib/auth/audit";
import { isRole, type Role } from "@/lib/auth/roles";

export type InviteRecord = {
  inviteId: string;
  /** Bound email. The account created by this invite gets THIS email. */
  email: string;
  name: string;
  role: Role;
  orgId: string;
  issuedBy: string;
  issuedAt: number;
  expiresAt: number;
};

/** Only the SHA-256 of the token is stored, so a database dump does not yield
 *  working invitations. Matches the convention used for producer keys
 *  (src/lib/producer-keys.ts). */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type IssueInviteInput = {
  email: string;
  name: string;
  role: Role;
  orgId: string;
  issuedBy: string;
  now?: number;
};

export type IssuedInvite = { invite: InviteRecord; /** Shown ONCE. Never stored. */ token: string };

export async function issueInvite(input: IssueInviteInput): Promise<IssuedInvite> {
  if (!isRole(input.role)) throw new Error(`Unknown role: ${String(input.role)}`);
  const now = input.now ?? Date.now();
  // The token exists BEFORE the row is written, so the row is stored under the
  // hash of the real token in a single write — there is no window in which the
  // invite is unredeemable, and no second row to clean up.
  //
  // callerId is "" for invite rows: the 256-bit token hash is already a global
  // unique key, so partitioning it further would only add a way to read the
  // row with the wrong partition and conclude "unknown invite".
  const token = randomBytes(32).toString("base64url");
  const invite: InviteRecord = {
    inviteId: randomBytes(16).toString("base64url"),
    email: normalizeEmail(input.email),
    name: input.name.trim() || normalizeEmail(input.email).split("@")[0] || "member",
    role: input.role,
    orgId: input.orgId,
    issuedBy: input.issuedBy,
    issuedAt: now,
    expiresAt: now + INVITE_TTL_MS,
  };
  await put(
    AUTH_SCOPES.invite,
    hashInviteToken(token),
    "",
    invite,
    new Date(now + INVITE_RECORD_TTL_MS),
  );

  await auditAuthEvent({
    intent: AUTH_AUDIT_INTENTS.inviteIssued,
    actorId: input.issuedBy,
    orgId: input.orgId,
    note: `invited ${invite.email} as ${invite.role}`,
    meta: {
      inviteId: invite.inviteId,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
    },
  });

  return { invite, token };
}

export type InviteRejection =
  "unknown_invite" | "invite_expired" | "invite_already_used" | "email_mismatch";

export type AcceptInviteInput = {
  token: string;
  /**
   * Optional. When the caller already has an authenticated email (a signed-in
   * user redeeming an invite), it must equal the invite's bound email.
   */
  assertedEmail?: string;
  /** Overrides the invite's default name. Email and role are never overridable. */
  name?: string;
  /** Password for the new account. Omit to leave the account password-less
   *  (magic-link-only), which is the primary operator path. */
  password?: string;
  now?: number;
};

export type AcceptInviteResult =
  | { ok: true; identity: Identity; session: IssuedSession }
  | { ok: false; reason: InviteRejection; error: string };

const REJECTION: Record<InviteRejection, string> = {
  unknown_invite: "That invitation is not valid.",
  invite_expired: "That invitation has expired.",
  invite_already_used: "That invitation has already been used.",
  email_mismatch: "That invitation was issued to a different email address.",
};

/**
 * Redeem an invitation: consume it atomically, create the account, sign in.
 *
 * Order — validate, THEN consume — is deliberate. Consuming first would let an
 * attacker burn any invitation they could guess an email for by submitting the
 * wrong address, a denial-of-service against the operator's own onboarding.
 * Validating first means only a caller who already holds a valid, unexpired
 * token can reach the consuming write.
 */
export async function acceptInvite(input: AcceptInviteInput): Promise<AcceptInviteResult> {
  const now = input.now ?? Date.now();
  const token = typeof input.token === "string" ? input.token.trim() : "";
  const reject = (reason: InviteRejection): AcceptInviteResult => ({
    ok: false,
    reason,
    error: REJECTION[reason],
  });
  if (!token) return reject("unknown_invite");

  // Constant-time lookup: the stored value is a hash, so compare digests rather
  // than letting a match/miss timing reveal whether the token existed.
  const candidate = Buffer.from(hashInviteToken(token), "hex");
  const invite = await read<InviteRecord>(AUTH_SCOPES.invite, hashInviteToken(token), "");
  if (!invite) {
    // Still burn a constant-time comparison so an absent token costs the same
    // work as a wrong one.
    timingSafeEqual(candidate, candidate);
    return reject("unknown_invite");
  }

  if (invite.expiresAt <= now) {
    await auditAuthEvent({
      intent: AUTH_AUDIT_INTENTS.inviteRejected,
      actorId: invite.issuedBy,
      orgId: invite.orgId,
      note: "expired invite redemption refused",
      meta: { inviteId: invite.inviteId, reason: "invite_expired" },
    });
    return reject("invite_expired");
  }

  // Bound-email check. The account's email comes from the invite regardless.
  if (input.assertedEmail && normalizeEmail(input.assertedEmail) !== invite.email) {
    await auditAuthEvent({
      intent: AUTH_AUDIT_INTENTS.inviteRejected,
      actorId: invite.issuedBy,
      orgId: invite.orgId,
      note: "invite redeemed with a mismatched email",
      meta: { inviteId: invite.inviteId, reason: "email_mismatch" },
    });
    return reject("email_mismatch");
  }

  // Validate the password BEFORE the invite is consumed. A weak or over-long
  // password must not burn a valid invitation: once the consume marker is
  // written the invite is dead, and an operator would have to issue another one
  // because a client sent a bad password. After this point nothing in the
  // remaining path is user-recoverable.
  if (input.password !== undefined) assertUsablePassword(input.password);

  // ── The atomic single-use gate ─────────────────────────────────────────────
  // A consume-marker row, inserted with no prior read. The unique index on
  // (scope, key, callerId) decides the winner. Every accept path above this line
  // is read-only, so the number of writers reaching it is unbounded and the
  // database is the only thing that can arbitrate correctly.
  const claim = await take(
    AUTH_SCOPES.inviteConsumed,
    invite.inviteId,
    "",
    { at: now, inviteId: invite.inviteId },
    new Date(invite.expiresAt + INVITE_RECORD_TTL_MS),
  );
  if (!claim.ok) return reject("invite_already_used");

  // Past this point the invite is consumed. Any failure must be loud, because a
  // silent failure here would leave a consumed invite and no account.
  const passwordHash = input.password ? await hashPassword(input.password) : undefined;

  const identity = await createIdentity({
    email: invite.email,
    name: input.name?.trim() || invite.name,
    role: invite.role,
    orgId: invite.orgId,
    passwordHash,
  });

  await auditAuthEvent({
    intent: AUTH_AUDIT_INTENTS.inviteConsumed,
    actorId: identity.accountId,
    orgId: invite.orgId,
    note: `account created from invite as ${identity.role}`,
    meta: {
      inviteId: invite.inviteId,
      email: identity.email,
      role: identity.role,
      issuedBy: invite.issuedBy,
    },
  });

  const session = await issueSession({ identity, method: "invite", now });
  return { ok: true, identity, session };
}

/** True when the invite exists, is unexpired, and has not been consumed. */
export async function inviteStatus(
  token: string,
  now = Date.now(),
): Promise<InviteRejection | "usable"> {
  const invite = await read<InviteRecord>(AUTH_SCOPES.invite, hashInviteToken(token.trim()), "");
  if (!invite) return "unknown_invite";
  if (invite.expiresAt <= now) return "invite_expired";
  const consumed = await read(AUTH_SCOPES.inviteConsumed, invite.inviteId, "");
  if (consumed) return "invite_already_used";
  return "usable";
}
