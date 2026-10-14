import "server-only";
/**
 * Sign-out backstop — the bridge between the two session systems.
 *
 * There are two independent sessions behind one browser:
 *
 *   · Better Auth's own session row + cookie. The Auth view signs in with
 *     `authClient.signIn.email()` (src/views/Auth.tsx) and `authClient.signOut()`
 *     revokes this one.
 *   · The first-party `sv_session` store (src/lib/auth/session.ts), minted by
 *     /api/auth/magic-link/verify, /api/auth/password, /api/auth/invites/accept
 *     and /api/auth/reset/confirm, and enforced on EVERY authenticated route by
 *     `requireAuth` → `verifySession`.
 *
 * Magic link is the PRIMARY operator sign-in (src/lib/auth/magic-link.ts) and that
 * path mints ONLY `sv_session` — it never creates a Better Auth session. So
 * `authClient.signOut()` had no Better Auth session to revoke, `/api/auth/logout`
 * (the only thing that sets `revokedAt`) had no callers at all, and the
 * `sv_session` row SURVIVED the sign-out: the UI showed signed-out while every
 * guarded route kept answering `ok: true` until the 15-minute idle or 8-hour
 * absolute limit.
 *
 * The Navbar and the idle handler now POST /api/auth/logout as well, which
 * revokes THIS session precisely. This function is the backstop for every sign-out
 * that is not those two: a future button, a support tool, a server action. It is
 * wired in as Better Auth's `databaseHooks.session.delete.after`.
 *
 * ## Why it revokes ALL first-party sessions for the identity
 *
 * The two systems hold unrelated session ids and nothing maps one Better Auth
 * session to one `sv_session` — so a per-session revocation is not expressible
 * from this side. Revoking every session for the identity is the fail-secure
 * direction: over-revoking signs the same person out of a second device, while
 * under-revoking leaves them in. The scope is the IDENTITY, never global — a
 * sign-out must not touch another operator.
 *
 * ## Why the failure is swallowed
 *
 * A throw here would propagate out of Better Auth's sign-out and turn a logout
 * into a 500, leaving the client unable to tell whether it is signed in. A
 * revoker that can break the thing it exists to protect is worse than one that
 * logs and moves on, so the failure is recorded and swallowed.
 */

import { db } from "@/lib/db";
import { revokeIdentitySessions } from "@/lib/auth/session";
import { logError } from "@/lib/validation/safe-log";

/**
 * Revoke every live first-party `sv_session` belonging to the Better Auth user.
 *
 * `accountId` is Better Auth's `Account.id` — NOT `userId` (see `getIdentity()`
 * in src/lib/auth/identity.ts) — so the mapping is userId → Account rows → ids.
 */
export async function revokeFirstPartySessionsOnSignOut(userId: string): Promise<void> {
  if (!userId) return;
  try {
    const accounts = await db.account.findMany({
      where: { userId },
      select: { id: true },
    });
    for (const account of accounts) {
      await revokeIdentitySessions(account.id);
    }
  } catch (error) {
    logError("[auth] could not revoke first-party sessions on sign-out", {
      userId,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}