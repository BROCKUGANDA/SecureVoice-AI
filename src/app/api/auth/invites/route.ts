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
import { seatFacts, seatGate } from "@/lib/billing/seats";

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
  // The seat line travels with the member list, because the list is where an
  // operator looks to find out whether they can invite someone. A cap that only
  // appears as a 402 on the button is a cap discovered by being refused.
  const facts = await seatFacts(authed.orgId);
  return NextResponse.json(
    {
      members: members.map((m) => ({
        accountId: m.accountId,
        email: m.email,
        name: m.name,
        role: m.role,
        orgId: m.orgId,
      })),
      seats: {
        /** null = unlimited, including "no plan resolved for this organization". */
        allowed: facts.seats,
        used: facts.members,
        remaining: facts.remaining,
        plan: facts.plan,
        /** Already above the plan's seats (a downgrade). Members are NOT removed. */
        overCap: facts.members > (facts.seats ?? Infinity),
      },
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

  // Seat cap. Runs AFTER every authorization check and BEFORE `issueInvite`, so
  // a caller who was never allowed to invite is still refused for the reason
  // that comes first, and an allowed caller is refused before an invitation
  // record or an email exists — a minted-then-discarded invite is a credential
  // with a 72-hour life that nobody intended to issue.
  //
  // 402, not 403: nothing about the caller's permission is wrong, and the fix is
  // commercial (upgrade), not procedural (ask an Owner). `api-errors.ts`'s
  // `paymentRequired()` is deliberately NOT reused here — it stamps
  // `X-Credits-Balance: 0`, and this refusal says nothing about the wallet.
  const seats = await seatGate(authed.orgId);
  if (!seats.ok) {
    return NextResponse.json(
      {
        error: seats.message,
        code: seats.code,
        seats: seats.facts.seats,
        members: seats.facts.members,
        plan: seats.facts.plan,
      },
      { status: 402, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { invite, token } = await issueInvite({
    email: parsed.data.email,
    name: parsed.data.name ?? "",
    role,
    orgId: authed.orgId,
    issuedBy: authed.identity.accountId,
  });

  // Deliver the invite by email (enqueue-then-attempt via Resend). The token is
  // NEVER returned in this response — that was the leak this module's magic-link
  // sibling refuses by design (src/lib/auth/magic-link.ts:19-22): an endpoint
  // that hands a usable credential back to the caller is a password reset with
  // an auth header, and works against any address the caller can name.
  const { deliverInvite } = await import("@/lib/email/deliverers");
  try {
    await deliverInvite({
      email: invite.email,
      token,
      expiresAt: invite.expiresAt,
      role: invite.role,
    });
  } catch (err) {
    // The invite exists (issueInvite already committed) but its email did not go
    // out. Report it loudly: this endpoint is ADMIN-ONLY and already
    // authenticated, so there is no enumeration concern here — an admin who was
    // told 201 while the email bounced would believe an analyst was invited when
    // nobody received anything.
    console.error("[auth] invite email delivery failed", {
      inviteId: invite.inviteId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error: "The invitation was created but the email could not be sent.",
        invite: {
          inviteId: invite.inviteId,
          email: invite.email,
          expiresAt: new Date(invite.expiresAt).toISOString(),
        },
        retryable: true,
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

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
      // The token is emailed to the invitee and never echoed here. Delivery is
      // queued durably, so a transient provider failure is retried by the
      // email worker rather than lost.
      note: "Invitation emailed. Single use. Bound to this email. Expires in 72 hours.",
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
