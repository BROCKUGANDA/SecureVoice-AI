import { NextResponse } from "next/server";
import { requirePrivileged } from "@/lib/auth/guards";
import { revokeOrgSessions } from "@/lib/auth/identity";
import { AUTH_AUDIT_INTENTS, auditAuthEventRequired } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/sessions/revoke-all — revoke EVERY session in the organisation.
 *
 * Requires `org:revokeSessions` AND a fresh step-up. Step-up is required even
 * though this is not one of the brief's five actions, because it is strictly more
 * consequential than any of them: it terminates every operator session in the
 * workspace and is the "we think something is compromised" control. A control
 * that is only usable by someone who is already logged in, without re-proving who
 * they are, is not a response to an incident — it is part of the incident.
 *
 * The caller is revoked too. "Revoke all sessions" that spares the person who
 * asked for it is not what an incident responder means, and leaving one session
 * alive would make the response revocable by whoever was holding it.
 *
 * Revocation happens by bumping each member's `orgEpoch`, which `verifySession`
 * compares on EVERY request — so the sessions die immediately even though no row
 * is deleted. See `revokeOrgSessions` for why that is the concurrency-safe form.
 *
 * The audit append is REQUIRED and runs first: if the chain is unavailable this
 * refuses rather than performing a mass revocation that leaves no record.
 */
export async function POST(req: Request) {
  const authed = await requirePrivileged(req.headers.get("cookie"), "invite_admin");
  if (!authed.ok) {
    return NextResponse.json(
      { error: authed.error, code: authed.code },
      { status: authed.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  await auditAuthEventRequired({
    intent: AUTH_AUDIT_INTENTS.sessionsRevokedAll,
    actorId: authed.identity.accountId,
    orgId: authed.orgId,
    note: "revoked all sessions in the organization",
    meta: { scope: "organization", orgId: authed.orgId, by: authed.identity.accountId },
  });

  const result = await revokeOrgSessions(authed.orgId);

  return NextResponse.json(
    {
      ok: true,
      scope: "organization",
      membersRevoked: result.revokedSessions,
      orgId: authed.orgId,
      note: "Every session in this organization has been revoked, including the caller's.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
