import "server-only";
/**
 * Two-factor is a precondition of spending money, not a suggestion.
 *
 * ## The gap this closes
 *
 * `User.twoFactorEnabled` was read in exactly three places before this file —
 * `src/app/page.tsx`, `TwoFactorPrompt.tsx` and `TwoFactorCard.tsx` — all of
 * them client components deciding what to SHOW. Nothing on the server ever
 * refused an action because the flag was false. That left the product making a
 * claim about itself in code it did not honour: `src/lib/better-auth.ts:98-99`
 * disables auto sign-in after invite acceptance because "a credential
 * compromise should force an MFA challenge", and no challenge existed to force.
 * Meanwhile every money route (`/api/billing/checkout`, `/api/billing/invoice`,
 * `/api/billing/portal`) authenticated the session and then went straight to
 * Paddle, so a stolen cookie with no second factor could start a subscription,
 * raise a negotiated invoice, and mint a customer-portal session where plans are
 * changed and cancelled.
 *
 * ## What "turned on and it works" means
 *
 * Both halves are required, because the flag alone is a claim rather than a
 * fact:
 *
 *   · `User.twoFactorEnabled === true` — Better Auth flips this only when a TOTP
 *     code the user entered actually verifies, so it is evidence of a completed
 *     enrolment rather than a scanned QR code; and
 *   · a `TwoFactor` row for that user holding the shared secret, not explicitly
 *     unverified. Without it the flag could describe a half-written setup (the
 *     row is created at "enable", the flag at "verify") or a row deleted out from
 *     under the user, in which case the next challenge cannot be answered at all
 *     — a user who cannot pass their own second factor must not be able to spend.
 *
 * ## Who is exempt, and why it is not the `demo` tier
 *
 * Only the demo account, matched on its email against the same env var the sign-
 * in screen already uses. Exempting by `planTier === "demo"` would be the
 * natural-looking choice and the wrong one: tiers are per-ORGANISATION and
 * `planTierFor` resolves an undeclared org to `"demo"` (`src/lib/abuse/tiers.ts:39-41`),
 * so a tier-based exemption silently grants every newly created tenant — and
 * every tenant whose operator never set `ABUSE_PLAN_TIER__*` — a pass around
 * second factor on the money path. The exemption would widen by itself as the
 * customer base grew, and no test would notice.
 *
 * The env var is unset by default, which means NOBODY is exempt. A deployment
 * that wants the walkthrough unblocked has to say so explicitly.
 */

import { db } from "@/lib/db";
import { isDemoAccount } from "@/lib/demo-account";
import type { Identity } from "@/lib/auth/identity";
import { logWarn } from "@/lib/validation/safe-log";

/** Machine-readable refusal, sibling to `step_up_required`. */
export const TWO_FACTOR_REQUIRED = "two_factor_required";

export type TwoFactorDenial = {
  /**
   * 428 Precondition Required — the same status `requirePrivileged` uses for an
   * unmet re-authentication precondition (`src/lib/auth/guards.ts:158-160`).
   * It is not a 403: the caller IS permitted to do this, and the console must
   * be able to tell "go enable two-factor" apart from "you are not the Owner".
   */
  status: 428;
  error: typeof TWO_FACTOR_REQUIRED;
  hint: string;
};

/**
 * Refuse a money action unless this identity has a working second factor.
 *
 * Takes an already-authenticated `Identity` rather than re-verifying the session
 * itself: the calling route has just run `verifySession`, and a second
 * verification is another ~300 ms round trip against a remote pooler spent on
 * re-reading the same cookie.
 */
export async function moneyTwoFactorBlocker(identity: Identity): Promise<TwoFactorDenial | null> {
  if (isDemoAccount(identity.email)) return null;

  const user = await db.user.findUnique({
    where: { id: identity.accountId },
    select: { twoFactorEnabled: true },
  });
  if (user?.twoFactorEnabled === true) {
    const enrolled = await db.twoFactor.count({
      where: { userId: identity.accountId, secret: { not: "" }, verified: { not: false } },
    });
    if (enrolled > 0) return null;
    // The flag says enrolled, the factor says otherwise. Reported because this
    // state means the user cannot complete their own next challenge — it is an
    // integrity problem in the auth data, not a user error.
    logWarn("[two-factor] user flag set with no usable factor row", {
      accountId: identity.accountId,
    });
  }

  return {
    status: 428,
    error: TWO_FACTOR_REQUIRED,
    hint: "Enable two-factor authentication in Settings → Security and verify a code before any payment action.",
  };
}

/**
 * The body every money route returns on refusal, and the shape the console is
 * allowed to branch on. Kept here so the three routes cannot drift into three
 * different spellings of the same refusal.
 */
export function twoFactorDenialBody(denial: TwoFactorDenial): Record<string, string> {
  return { error: denial.error, hint: denial.hint };
}
