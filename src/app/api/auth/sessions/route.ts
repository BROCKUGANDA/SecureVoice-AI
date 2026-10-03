import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/guards";
import { listIdentitySessions, revokeIdentitySessions } from "@/lib/auth/session";
import { AUTH_AUDIT_INTENTS, auditAuthEventRequired } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

/**
 * Session revocation (WP-11 item 6).
 *
 *   GET    /api/auth/sessions          → this identity's live sessions
 *   DELETE /api/auth/sessions          → revoke ALL of THIS identity's sessions
 *   POST   /api/auth/sessions/revoke-all → revoke every session in the ORG
 *
 * ── Two different scopes, on purpose ─────────────────────────────────────────
 * `DELETE /api/auth/sessions` is self-service: "sign out everywhere". No role is
 * needed beyond having a session, because it only ever affects the caller.
 *
 * `POST /api/auth/sessions/revoke-all` is an administrative action on OTHER
 * people: `org:revokeSessions`, plus a step-up, because it is the "assume
 * compromise" button and it logs out every operator in the workspace including
 * the one who pressed it.
 *
 * The org-wide sweep bumps an epoch per member rather than deleting session
 * rows. That is what makes it correct under concurrency: a session minted while
 * the sweep runs is issued with the NEW epoch and survives, while every session
 * issued before it carries the old epoch and dies. Deleting rows would leave
 * that race wide open. See `revokeOrgSessions` in src/lib/auth/identity.ts.
 */
export async function GET(req: NextRequest) {
  const authed = await requireCapability(req.headers.get("cookie"), "member:read");
  if (!authed.ok) {
    return NextResponse.json({ error: authed.error, code: authed.code }, { status: authed.status });
  }
  const sessions = await listIdentitySessions(authed.identity.accountId);
  return NextResponse.json(
    {
      sessions: sessions.map((s) => ({
        // No token is ever returned — a session listing must not become a
        // session-stealing endpoint.
        sessionId: s.sid.slice(0, 8),
        issuedAt: new Date(s.issuedAt).toISOString(),
        lastSeenAt: new Date(s.lastSeenAt).toISOString(),
        method: s.method,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(req: NextRequest) {
  const authed = await requireCapability(req.headers.get("cookie"), "member:read");
  if (!authed.ok) {
    return NextResponse.json({ error: authed.error, code: authed.code }, { status: authed.status });
  }
  const revoked = await revokeIdentitySessions(authed.identity.accountId);
  // Audit is REQUIRED here: an unrevoked session is the artefact of an incident,
  // and the record of revoking it has to be as durable as the session was.
  await auditAuthEventRequired({
    intent: AUTH_AUDIT_INTENTS.sessionsRevokedAll,
    actorId: authed.identity.accountId,
    orgId: authed.orgId,
    note: `revoked all own sessions (${revoked})`,
    meta: { scope: "identity", revoked, by: authed.identity.accountId },
  });
  return NextResponse.json(
    { ok: true, revoked, scope: "identity" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
