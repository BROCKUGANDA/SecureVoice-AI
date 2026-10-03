import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCapability, requirePrivileged } from "@/lib/auth/guards";
import { issueInvite } from "@/lib/auth/invite";
import { listOrgMembers } from "@/lib/auth/identity";
import { CONSOLE_ROLES } from "@/lib/auth/identity";
import { isRole } from "@/lib/auth/roles";
import { inviteStatus } from "@/lib/auth/invite";
import { INVITE_TTL_MS } from "@/lib/auth/constants";

export const dynamic = "force-dynamic";

/**
 * Invitations — the ONLY way an account is created (WP-11 item 1).
 *
 *   GET  /api/auth/invites          → members of this org (member:read)
 *   POST /api/auth/invites          → issue an invitation
 *        Requires `member:invite` AND a fresh step-up (`invite_admin`), because
 *        granting another human access to everything an organisation holds is
 *        the most consequential thing an operator can do here.
 *
 * There is deliberately NO `DELETE`/revoke and NO public issuance: an
 * unconsumed invitation is bounded by its 72-hour TTL, and revoking one early
 * would be a second way to mint credentials that outlive the operator's intent.
 */
const issueSchema = z.object({
  email: z.string().trim().min(3).max(254),
  name: z.string().trim().max(120).optional(),
  role: z.string().trim(),
});

export async function GET(req: NextRequest) {
  const authed = await requireCapability(req.headers.get("cookie"), "member:read");
  if (!authed.ok) {
    return NextResponse.json({ error: authed.error, code: authed.code }, { status: authed.status });
  }
  const members = await listOrgMembers(authed.orgId);
  return NextResponse.json(
    {
      members: members.map((m) => ({
        accountId: m.accountId,
        email: m.email,
        name: m.name,
        role: m.role,
        orgId: m.orgId,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  // Capability AND step-up. Order is enforced inside requirePrivileged.
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
  const parsed = issueSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "email and role are required" }, { status: 422 });
  }

  // Role must be one an administrator may actually grant. `isRole` alone would
  // accept "Owner", and letting an Admin mint Owners is precisely what
  // rbac.assertMayAssignRole exists to prevent — so the same rule is applied
  // here, before the invite is ever created.
  const role = parsed.data.role;
  if (!isRole(role) || !CONSOLE_ROLES.includes(role)) {
    return NextResponse.json(
      { error: `role must be one of: ${CONSOLE_ROLES.join(", ")}` },
      { status: 422 },
    );
  }
  if (role === "Owner" && authed.role !== "Owner") {
    return NextResponse.json({ error: "Only an Owner may invite another Owner." }, { status: 403 });
  }

  const { invite, token } = await issueInvite({
    email: parsed.data.email,
    name: parsed.data.name ?? "",
    role,
    orgId: authed.orgId,
    issuedBy: authed.identity.accountId,
  });

  return NextResponse.json(
    {
      ok: true,
      invite: {
        inviteId: invite.inviteId,
        email: invite.email,
        role: invite.role,
        expiresAt: new Date(invite.expiresAt).toISOString(),
        ttlMs: INVITE_TTL_MS,
      },
      // Shown ONCE, to be delivered to the invitee out of band. Only the hash
      // is stored (src/lib/auth/invite.ts), so this cannot be recovered later.
      token,
      note: "Single use. Bound to this email. Expires in 72 hours.",
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

/** GET /api/auth/invites?token=… — is this invitation still usable? */
export async function HEAD(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "token required" }, { status: 422 });
  }
  const status = await inviteStatus(token);
  return NextResponse.json(
    { status },
    { status: status === "usable" ? 200 : 410, headers: { "Cache-Control": "no-store" } },
  );
}
