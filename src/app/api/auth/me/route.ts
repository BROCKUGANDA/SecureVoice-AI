import { NextResponse } from "next/server";
import { requireAuth, sessionStatus } from "@/lib/auth/guards";
import { SESSION_COOKIE_ATTRS, IDLE_TIMEOUT_MS, ABSOLUTE_LIFETIME_MS } from "@/lib/auth/constants";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me — the current first-party session, and its remaining life.
 *
 * Runs the FULL server-side policy check (`requireAuth` → `verifySession`), so
 * this endpoint is itself subject to the idle and absolute limits: a caller past
 * the cutoff gets a 403 here rather than a profile with a countdown. That is
 * deliberate — it means the console cannot render an "active session" badge for a
 * session the server has already decided is dead.
 *
 * The two `*RemainingMs` fields are for the client-side convenience timer only.
 * The client timer is not a control (see src/lib/auth/session.ts); it exists so a
 * user is warned before the server cuts them off.
 */
export async function GET(req: Request) {
  const authed = await requireAuth(req.headers.get("cookie"));
  if (!authed.ok) {
    return NextResponse.json(
      { error: authed.error, code: authed.code },
      { status: authed.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    {
      session: sessionStatus(authed.session),
      identity: {
        accountId: authed.identity.accountId,
        email: authed.identity.email,
        name: authed.identity.name,
        role: authed.role,
        orgId: authed.orgId,
      },
      policy: { idleTimeoutMs: IDLE_TIMEOUT_MS, absoluteLifetimeMs: ABSOLUTE_LIFETIME_MS },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
