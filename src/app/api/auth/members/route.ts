import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCapability, requirePrivileged } from "@/lib/auth/guards";
import { assertMayAssignRole, CapabilityError } from "@/lib/auth/rbac";
import { getIdentity, setRole, IdentityError } from "@/lib/auth/identity";
import { isRole } from "@/lib/auth/roles";
import { AUTH_AUDIT_INTENTS, auditAuthEventRequired } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

/**
 * Members of an organisation.
 *
 *   GET   /api/auth/members                     → list (member:read)
 *   PATCH /api/auth/members                     → change a role
 *         Body: { accountId, role }
 *
 * A role change is a privileged action: it requires `member:setRole` AND a fresh
 * step-up (`invite_admin` is the declared step-up action for granting access;
 * changing an existing grant is the same capability and gets the same gate).
 *
 * TWO things happen atomically-in-effect on success:
 *   1. The role changes.
 *   2. EVERY existing session for that identity is revoked.
 *
 * (2) is not a courtesy — see `setRole` in src/lib/auth/identity.ts. The session
 * carries the `roleEpoch` it was issued under; bumping the epoch invalidates all
 * of them at once, including one being created concurrently with the change.
 * A demotion that left the old session alive would leave a promoted-to-Auditor
 * account still writing cases with a perfectly valid cookie.
 *
 * The audit append happens BEFORE the write and is allowed to throw: a role
 * change that cannot be recorded in the tamper-evident chain does not happen.
 */
const patchSchema = z.object({
  accountId: z.string().trim().min(1).max(64),
  role: z.string().trim(),
});

export async function GET(req: NextRequest) {
  const authed = await requireCapability(req.headers.get("cookie"), "member:read");
  if (!authed.ok) {
    return NextResponse.json({ error: authed.error, code: authed.code }, { status: authed.status });
  }
  // Delegated to the members listing in the invites route's module (one query
  // path, one place that knows the org predicate).
  const { listOrgMembers } = await import("@/lib/auth/identity");
  const members = await listOrgMembers(authed.orgId);
  return NextResponse.json(
    {
      members: members.map((m) => ({
        accountId: m.accountId,
        email: m.email,
        name: m.name,
        role: m.role,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(req: NextRequest) {
  const authed = await requirePrivileged(req.headers.get("cookie"), "invite_admin");
  if (!authed.ok) {
    return NextResponse.json(
      { error: authed.error, code: authed.code },
      { status: authed.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "accountId and role are required" }, { status: 422 });
  }
  if (!isRole(parsed.data.role)) {
    return NextResponse.json({ error: `Unknown role: ${parsed.data.role}` }, { status: 422 });
  }

  const target = await getIdentity(parsed.data.accountId, authed.orgId);
  if (!target) {
    return NextResponse.json({ error: "No such member in this organization" }, { status: 404 });
  }

  // Owner/Admin separation, before anything is written.
  try {
    assertMayAssignRole(authed.role, target.role, parsed.data.role);
  } catch (err) {
    if (err instanceof CapabilityError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  try {
    const result = await setRole(target.accountId, authed.orgId, parsed.data.role, async () =>
      auditAuthEventRequired({
        intent: AUTH_AUDIT_INTENTS.roleChanged,
        actorId: authed.identity.accountId,
        orgId: authed.orgId,
        note: `role ${target.role} → ${parsed.data.role}`,
        meta: {
          targetAccountId: target.accountId,
          targetEmail: target.email,
          previousRole: target.role,
          nextRole: parsed.data.role,
          by: authed.identity.accountId,
        },
      }),
    );
    return NextResponse.json(
      {
        ok: true,
        accountId: result.identity.accountId,
        previousRole: result.previousRole,
        role: result.identity.role,
        // Stated in the response so the operator does not have to know it:
        revokesAllSessions: true,
        note: "Role changed. Every existing session for that member has been revoked.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof IdentityError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    throw err;
  }
}
