import { NextResponse } from "next/server";
import { z } from "zod";
import { acceptInvite } from "@/lib/auth/invite";
import { SESSION_COOKIE_ATTRS, SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { seatGate } from "@/lib/billing/seats";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * The seat cap for redemption, wrapped so it can only ever refuse on a real
 * limit.
 *
 * If the cap cannot be evaluated — the identity store or the billing mirror is
 * unreachable — the redemption PROCEEDS. This is the same asymmetry
 * `src/lib/billing/seats.ts` documents: the control being enforced is
 * commercial, and the cost of a wrong answer here is a legitimate new operator
 * who holds a working invitation and cannot use it, cannot tell anyone why, and
 * whose invite expires in 72 hours. A tenant that gains one seat because a
 * database blipped is recoverable in the next billing cycle.
 */
async function redeemSeatGate(
  orgId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    return await seatGate(orgId);
  } catch (err) {
    logError("[auth] seat cap unreadable at redemption; allowing it through", {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: true };
  }
}

/**
 * POST /api/auth/invites/accept — redeem an invitation. The ONLY path by which
 * an account comes into existence.
 *
 * Body: { token, name?, password? }
 *
 * Public by necessity — the caller has no session, because they have no account
 * yet. That is exactly why the token is a 256-bit single-use secret with a
 * 72-hour TTL, and why the account's email and role are read from the invite row
 * and never from the request body.
 *
 * `password` is OPTIONAL and, when omitted, the account is magic-link-only.
 * That is the primary operator path; the password exists as the fallback for an
 * operator who must also be able to re-authenticate for step-up on a network
 * with no mail access.
 */
const acceptSchema = z.object({
  token: z.string().trim().min(10).max(512),
  name: z.string().trim().max(120).optional(),
  password: z.string().min(12).max(200).optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = acceptSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid invitation token is required" }, { status: 422 });
  }

  const result = await acceptInvite({
    token: parsed.data.token,
    name: parsed.data.name,
    password: parsed.data.password,
    seatGate: redeemSeatGate,
  });

  if (!result.ok) {
    // A demo address is a POLICY refusal, not a dead invitation: 403, and the
    // invitation is not consumed, so a legitimate re-issue to a real address is
    // unaffected.
    if (result.reason === "demo_address") {
      return NextResponse.json(
        { error: result.error, code: result.reason },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    // A full plan is a COMMERCIAL refusal, not a dead invitation: 402 with the
    // seat facts, and — the part that matters — the invitation was not consumed,
    // so it still works the moment the organization upgrades or frees a seat.
    if (result.reason === "seat_full") {
      return NextResponse.json(
        { error: result.error, code: "seat_limit_reached", inviteStillValid: true },
        { status: 402, headers: { "Cache-Control": "no-store" } },
      );
    }
    // 410 Gone for every invitation failure: expired, already used, or simply
    // not a real token. Distinguishing them would tell a prober which token
    // guesses were real invitations.
    return NextResponse.json(
      { error: result.error, code: result.reason },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  const response = NextResponse.json(
    {
      ok: true,
      email: result.identity.email,
      name: result.identity.name,
      role: result.identity.role,
      orgId: result.identity.orgId,
      passwordSet: Boolean(parsed.data.password),
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
  // Signing the new member straight in: they have just proved they hold the
  // invitation, so requiring a second sign-in round trip adds friction without
  // adding assurance.
  response.cookies.set(SESSION_COOKIE_NAME, result.session.token, SESSION_COOKIE_ATTRS);
  return response;
}
