import { NextResponse } from "next/server";
import { requireAuth, logout } from "@/lib/auth/guards";
import { SESSION_COOKIE_ATTRS, SESSION_COOKIE_NAME } from "@/lib/auth/constants";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout — sign out of THIS session.
 *
 * Revocation is server-side (`revokeSession` flips `revokedAt`), and
 * `verifySession` checks that flag before anything else. Clearing the cookie is
 * hygiene, not the control: a client that ignores the cookie-clearing response
 * still presents a cookie whose session is dead. That is the property that makes
 * revocation survivable against a non-cooperative client.
 *
 * Idempotent: signing out twice, or without a valid session, is a 200.
 */
export async function POST(req: Request) {
  const authed = await requireAuth(req.headers.get("cookie"));
  if (authed.ok) {
    await logout(authed.session);
  }
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  // Expire the cookie with the same attribute set it was issued under, or a
  // path/domain mismatch means the browser keeps it.
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...SESSION_COOKIE_ATTRS, maxAge: 0 });
  return response;
}
