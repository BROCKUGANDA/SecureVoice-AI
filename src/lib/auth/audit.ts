import "server-only";
/**
 * Auth audit events (WP-11).
 *
 * Every authentication decision that changes who can reach what — an invite
 * issued, an invite consumed, a session revoked, a role changed — is appended
 * to the SAME tamper-evident chain the call record uses
 * (`src/lib/audit-chain.ts`), not to a second log.
 *
 * Why one chain: a separate auth log is a separate thing to trust, and it is
 * exactly the log an operator would be asked to produce after an incident
 * ("who granted access, when, and from where"). `AuditLog.chainHash` already
 * makes any later edit detectable via `verifyChain()`, so an auth event that a
 * privileged account tried to remove is provably missing rather than merely
 * absent.
 *
 * `AuditEntry.action` is a closed union (`tts | asr | agent | freeze |
 * handoff | consent`) and this module may not extend it — the chain's schema is
 * owned elsewhere. So auth events ride `action: "consent"` (the existing
 * "security-relevant, human-authorised change" bucket, which `credits.ts` and
 * `producer-keys.ts` already use for wallet and key events) with the specific
 * event name in `intent`, which is what the chain actually keys on.
 *
 * Fire-and-forget by default, matching the rest of the codebase: a failing
 * audit write must not turn a successful login into a 500. Security events that
 * MUST be recorded (role change, revoke-all) pass `await: true` and propagate a
 * failure instead — see `auditAuthEventRequired`.
 */

import { append as auditAppend } from "@/lib/audit-chain";

/** Event names. `intent` is sanitised to 40 chars and [\w.:-] by audit-chain. */
export const AUTH_AUDIT_INTENTS = {
  inviteIssued: "auth.invite.issued",
  inviteConsumed: "auth.invite.consumed",
  inviteRejected: "auth.invite.rejected",
  signupRefused: "auth.signup.refused",
  loginOk: "auth.login.ok",
  loginFailed: "auth.login.failed",
  magicLinkIssued: "auth.magiclink.issued",
  sessionRevoked: "auth.session.revoked",
  sessionRejected: "auth.session.rejected",
  sessionsRevokedAll: "auth.sessions.revoke_all",
  roleChanged: "auth.role.changed",
  stepUpGranted: "auth.stepup.granted",
  stepUpRefused: "auth.stepup.refused",
  stepUpConsumed: "auth.stepup.consumed",
} as const;

export type AuthAuditIntent = (typeof AUTH_AUDIT_INTENTS)[keyof typeof AUTH_AUDIT_INTENTS];

export type AuthAuditEvent = {
  intent: AuthAuditIntent;
  /** Who performed it. A stable id — never an email in this field. */
  actorId: string;
  orgId?: string | null;
  /**
   * Free text. Redacted before it reaches the chain (the chain truncates to 500
   * chars). Callers must not put a password, token, or key here: this is a
   * tamper-EVIDENT log, not a secret store, and its whole value is that it can
   * be shown to an auditor.
   */
  note?: string;
  meta?: Record<string, unknown>;
};

/**
 * A chain `callRef` that groups every auth event for one identity, so
 * `verifyChain(actorId)` walks that identity's whole history as one linked
 * sequence — including across an org change, which a per-org callRef would
 * split.
 */
function callRefFor(actorId: string): string {
  return `AUTH-${actorId.replace(/[^\w.:-]/g, "").slice(0, 48) || "unknown"}`;
}

/** Best-effort append. A chain failure is logged, never thrown. */
export async function auditAuthEvent(event: AuthAuditEvent): Promise<void> {
  await auditAppend({
    callRef: callRefFor(event.actorId),
    action: "consent",
    intent: event.intent,
    callerId: event.actorId,
    redactedText: event.note,
    meta: event.meta,
    orgId: event.orgId ?? undefined,
  }).catch((err: unknown) => {
    console.error("[auth] audit append failed:", err instanceof Error ? err.message : err);
  });
}

/**
 * Append that MUST succeed. Used for the events where losing the record is
 * itself the incident: a role change and a mass revocation. If the chain is
 * unavailable the operation does not proceed — the alternative is a privilege
 * grant that no one can prove was ever made.
 */
export async function auditAuthEventRequired(event: AuthAuditEvent): Promise<void> {
  await auditAppend({
    callRef: callRefFor(event.actorId),
    action: "consent",
    intent: event.intent,
    callerId: event.actorId,
    redactedText: event.note,
    meta: event.meta,
    orgId: event.orgId ?? undefined,
  });
}
