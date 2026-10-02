import "server-only";
/**
 * Public signup is CLOSED (WP-11, item 1).
 *
 * ── Why this file exists even though nothing calls it ────────────────────────
 * "There is no public signup route" is a claim about the absence of code, and
 * absence is not a control. The next person to need a route will add
 * `POST /api/auth/signup`, wire it to `createIdentity` in
 * `src/lib/identity`-adjacent code, ship it, and every other guarantee in this
 * package becomes advisory: an unknown address can create its own account, and
 * if the role is read from a request body it can grant itself `Owner`.
 *
 * So the invariant is made into a control that can be executed and tested:
 *
 *   1. There is NO `signup`/`register`/`join` route under `src/app/api/auth/**`.
 *      The test gate asserts this against the filesystem, not against memory.
 *   2. `createAccountFromSignup()` exists and ALWAYS refuses. It is the obvious
 *      name to reach for, and reaching for it gets a refusal rather than a
 *      provisioning path.
 *   3. `createIdentity` (src/lib/auth/identity.ts) is deliberately NOT exported
 *      for general use; the invite path is the only caller, and
 *      `accountCreationPath()` names it so the audit trail of this decision is
 *      greppable.
 *
 * The only supported way an account comes into existence is
 * `acceptInvite()` in src/lib/auth/invite.ts.
 */

export const SIGNUP_CLOSED_MESSAGE =
  "Sign-up is invite-only. Ask an administrator for an invitation.";

export const SIGNUP_CLOSED_CODE = "signup_closed" as const;

export type SignupRefusal = {
  ok: false;
  code: typeof SIGNUP_CLOSED_CODE;
  error: string;
};

/**
 * The single supported account-creation path. Named so that "how does an
 * account get created?" has one answer, and it is not "the signup endpoint".
 */
export function accountCreationPath(): "invite_redemption" {
  return "invite_redemption";
}

/**
 * Always refuses. Present so the name a developer would reach for exists and
 * returns a refusal.
 *
 * Takes no credentials and ignores them: there is no argument this function
 * will accept that changes its answer. Adding one is the signal that the
 * decision has been deliberately reversed, which should be a reviewable change
 * to this file rather than a new route that bypasses it.
 */
export async function createAccountFromSignup(
  // Intentionally ignored — never read, never logged.
  _input?: unknown
): Promise<SignupRefusal> {
  return { ok: false, code: SIGNUP_CLOSED_CODE, error: SIGNUP_CLOSED_MESSAGE };
}

/** HTTP status a signup refusal should map to. 403, not 404: the endpoint's
 *  existence is not a secret, and 403 tells an integrator the real answer. */
export const SIGNUP_CLOSED_STATUS = 403;