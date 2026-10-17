import { NextResponse } from "next/server";
import { requireAuth, logout } from "@/lib/auth/guards";
import { SESSION_COOKIE_ATTRS, SESSION_COOKIE_NAME } from "@/lib/auth/constants";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout — sign out of THIS session, completely.
 *
 * ## The order of operations, and why it is that order
 *
 * A sign-out has two halves and they fail differently. REVOCATION is
 * server-side and authoritative: `revokeSession` flips `revokedAt`, and
 * `verifySession` checks that flag before anything else. COOKIE CLEARING is
 * client-side hygiene. Clearing the cookie first and then failing to revoke
 * leaves a live session reachable by anyone who captured the token; revoking
 * first and failing to clear leaves a dead cookie the next sign-in overwrites.
 *
 * So revoke first, then clear — and if revocation throws, STILL clear, because
 * leaving the cookie is the only outcome in which a retry is guaranteed to be
 * needed. Revocation is additionally the backstop against a non-cooperative
 * client: a caller that ignores these Set-Cookie headers still presents a token
 * whose session row is dead.
 *
 * ## Why every cookie is expired explicitly
 *
 * This deployment has two session systems behind one browser: Better Auth's own
 * `session_token` / `session_data` pair, and the first-party `sv_session`. The
 * first-party one is expired explicitly below. Better Auth's are expired by
 * `authClient.signOut()` on the client — but that call is a network round trip,
 * and if it fails, is offline, or is simply not reached (a user closing the tab,
 * a killed tab, an expired `sv_session` making the UI look signed out while
 * Better Auth's cookie is still live) the token stays in the jar.
 *
 * The server cannot know Better Auth's exact cookie names at build time — they
 * are derived from `advanced.cookiePrefix` plus the `useSecureCookies` and
 * `.secure` suffixes — so they are enumerated below from the same configuration
 * this app was built with. Expiring a cookie that does not exist is a no-op;
 * leaving one that does is the failure.
 *
 * `secure` is applied in PRODUCTION ONLY. A cookie set `Secure` cannot be
 * deleted by a non-Secure Set-Cookie over plain HTTP, so on a local http origin
 * a `Secure` delete is silently ignored and the cookie survives — which is how a
 * dev machine ends up "signed out" with a live session.
 *
 * ## Cache
 *
 * `no-store` on the response AND on the caller's subsequent navigations is why
 * this matters: a sign-out that leaves a warm bfcache entry or a cached document
 * showing the previous operator's name on screen is a leak that looks like a UI
 * bug. The client handler navigates with `window.location.replace` for the same
 * reason — it does not add a history entry, so Back cannot return to an
 * authenticated page.
 *
 * Idempotent: signing out twice, or with no valid session, is a 200. A sign-out
 * that 500s teaches users to click it twice and to distrust it.
 */

/**
 * Better Auth's cookies for this deployment, expired alongside the first-party one.
 *
 * `advanced.cookiePrefix` is unset, so Better Auth's default `better-auth`
 * prefix applies; the `session_token` (opaque) and `session_data` (JWE cookie
 * cache) pair are the ones that carry a live session. The CSRF cookie is included
 * because it is minted per request and a stale one makes the NEXT sign-in fail
 * with a confusing token-mismatch rather than a clear "signed out".
 */
const BETTER_AUTH_COOKIE_NAMES = [
  "better-auth.session_token",
  "better-auth.session_data",
  "better-auth.csrf_token",
] as const;

/** Expire one cookie under BOTH the secure and non-secure attribute sets. */
function expire(
  response: NextResponse,
  name: string,
  attrs: { path: string; sameSite?: "lax" | "strict" | "none" },
) {
  const base = { ...attrs, maxAge: 0, expires: new Date(0) };
  // Insecure first: a `Secure` delete is ignored over plain HTTP, so the
  // non-secure variant is the one that works on a local origin.
  response.cookies.set(name, "", { ...base, secure: false });
  response.cookies.set(name, "", { ...base, secure: true });
}

export async function POST(req: Request) {
  const authed = await requireAuth(req.headers.get("cookie"));
  if (authed.ok) {
    try {
      await logout(authed.session);
    } catch {
      // Revocation failed but the cookies must still go: leaving them is the only
      // outcome that guarantees the user has to try again. The session record will
      // also expire on its own absolute lifetime.
    }
  }

  const response = NextResponse.json(
    { ok: true },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        // Belt and braces on the browser bfcache, which will otherwise restore a
        // rendered authenticated page on Back after the session is gone.
        "Clear-Site-Data": '"cache", "storage"',
      },
    },
  );

  // The first-party session cookie, expired under the same attribute set it was
  // issued with — a path or domain mismatch means the browser keeps it.
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...SESSION_COOKIE_ATTRS, maxAge: 0 });
  for (const name of BETTER_AUTH_COOKIE_NAMES) {
    expire(response, name, { path: "/", sameSite: "lax" });
  }

  return response;
}
