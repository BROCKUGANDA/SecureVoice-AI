import "server-only";
/**
 * Step-up re-authentication (WP-11, item 4).
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * Role checks answer "is this session allowed to do X?" — which is true for
 * every live session of an Admin, including one that was stolen an hour after
 * the Admin legitimately logged in. Step-up answers a different question: "is
 * the person at the keyboard right now the one who proved who they were at the
 * moment of this action?"
 *
 * Required for the five expensive, non-obviously-reversible actions declared in
 * `PRIVILEGED_ACTIONS` (src/lib/auth/roles.ts):
 *
 *     commit_freeze           — money is moved and a customer is affected
 *     rotate_producer_key     — a machine credential is rotated; the old one dies
 *     change_byok_credential  — an upstream billing key is replaced
 *     invite_admin            — another human is granted access to everything
 *     export_bulk_data        — an organisation's records leave the system
 *
 * ── A step-up grant is NOT a privilege ───────────────────────────────────────
 * `requireStepUp` is always evaluated AFTER the role/capability check
 * (src/lib/auth/rbac.ts). Holding a fresh step-up while being an `Auditor` still
 * cannot freeze a card, because `Auditor` lacks `case:write`. That ordering is
 * why a step-up grant is safe to store as a bare timestamp.
 *
 * ── The grant is bound to the SESSION, not to the account ────────────────────
 * Two things follow, both intended:
 *   · A grant cannot be lifted from one session and replayed on another, so an
 *     attacker who compromises a second session does not inherit the victim's
 *     step-up.
 *   · A role change (which revokes every session, src/lib/auth/identity.ts) also
 *     destroys the grants, because the session that carried them no longer
 *     passes `verifySession`.
 *
 * ── What counts as re-authentication ─────────────────────────────────────────
 * Re-entering the password, or redeeming a fresh magic link. NOT: re-reading the
 * session cookie, re-confirming a modal, or an OTP sent to the same channel
 * within the last few minutes. `issueStepUp` takes the verified credential as
 * its only argument, so the caller cannot pass "true".
 */

import { AUTH_SCOPES, drop, put, read } from "@/lib/auth/store";
import { STEP_UP_WINDOW_MS } from "@/lib/auth/constants";
import {
  isPrivilegedAction,
  PRIVILEGED_ACTION_CAPABILITY,
  PRIVILEGED_ACTION_LABEL,
  type PrivilegedAction,
} from "@/lib/auth/roles";
import { AUTH_AUDIT_INTENTS, auditAuthEvent } from "@/lib/auth/audit";
import type { SessionRecord } from "@/lib/auth/session";

export type StepUpMethod = "password" | "magic_link";

export type StepUpGrant = {
  at: number;
  method: StepUpMethod;
  /** Which verified credential was presented — never the credential itself. */
  credentialRef: string;
};

export type ReAuthOutcome = { ok: true } | { ok: false; error: string };

/**
 * Record a successful re-authentication.
 *
 * Takes the verification OUTCOME rather than a boolean so there is no way to
 * call this without having verified something: the only value a caller can pass
 * is the result of `verifyPassword` / magic-link redemption.
 */
export async function issueStepUp(
  session: SessionRecord,
  verified: ReAuthOutcome,
  method: StepUpMethod,
  now = Date.now()
): Promise<StepUpGrant | ReAuthOutcome> {
  if (!verified.ok) {
    await auditAuthEvent({
      intent: AUTH_AUDIT_INTENTS.stepUpRefused,
      actorId: session.accountId,
      orgId: session.orgId,
      note: "re-authentication failed",
      meta: { sid: session.sid, method },
    });
    return verified;
  }
  const grant: StepUpGrant = { at: now, method, credentialRef: `${method}:${session.sid.slice(0, 8)}` };
  await put(
    AUTH_SCOPES.stepUp,
    session.sid,
    session.accountId,
    grant,
    new Date(now + STEP_UP_WINDOW_MS)
  );
  await auditAuthEvent({
    intent: AUTH_AUDIT_INTENTS.stepUpGranted,
    actorId: session.accountId,
    orgId: session.orgId,
    note: `re-authenticated via ${method}`,
    meta: { sid: session.sid, method },
  });
  return grant;
}

/** The current grant for this session, or null. */
export async function currentStepUp(
  session: SessionRecord,
  now = Date.now()
): Promise<StepUpGrant | null> {
  const grant = await read<StepUpGrant>(AUTH_SCOPES.stepUp, session.sid, session.accountId);
  if (!grant) return null;
  // The store's TTL is a backstop; freshness is enforced here too so the window
  // is a single rule rather than a property of whichever expiry fired first.
  if (now - grant.at >= STEP_UP_WINDOW_MS) {
    await drop(AUTH_SCOPES.stepUp, session.sid, session.accountId);
    return null;
  }
  return grant;
}

export type StepUpCheck =
  | { ok: true; grant: StepUpGrant }
  | { ok: false; reason: "step_up_required" | "not_a_privileged_action"; error: string; action: string };

/**
 * Assert a fresh step-up for a privileged action.
 *
 * Returns the missing capability alongside the failure so the route can answer
 * 403 (role) rather than 428 (step-up) correctly — the caller has already had
 * its role check pass by the time this runs.
 */
export async function requireStepUp(
  session: SessionRecord,
  action: PrivilegedAction,
  now = Date.now()
): Promise<StepUpCheck> {
  if (!isPrivilegedAction(action)) {
    return {
      ok: false,
      reason: "not_a_privileged_action",
      action: String(action),
      error: `Unknown privileged action: ${String(action)}`,
    };
  }
  const grant = await currentStepUp(session, now);
  if (!grant) {
    return {
      ok: false,
      reason: "step_up_required",
      action,
      error: `Re-authentication required to perform ${PRIVILEGED_ACTION_LABEL[action]}.`,
    };
  }
  await auditAuthEvent({
    intent: AUTH_AUDIT_INTENTS.stepUpConsumed,
    actorId: session.accountId,
    orgId: session.orgId,
    note: `step-up satisfied for ${action}`,
    meta: { sid: session.sid, action, capability: PRIVILEGED_ACTION_CAPABILITY[action], ageMs: now - grant.at },
  });
  return { ok: true, grant };
}