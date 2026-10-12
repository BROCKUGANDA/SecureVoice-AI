import { NextResponse } from "next/server";
import { z } from "zod";
import { redeemPasswordReset } from "@/lib/auth/password-reset";
import { getIdentityByEmail, setIdentityPassword } from "@/lib/auth/identity";
import { hashPassword, assertUsablePassword } from "@/lib/auth/password";
import { issueSession } from "@/lib/auth/session";
import { SESSION_COOKIE_ATTRS, SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { AUTH_AUDIT_INTENTS, auditAuthEvent } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/reset/confirm — consume a reset token and set a new password.
 *
 * Body: { token, password }
 *
 * Single use: `redeemPasswordReset` arbitrates the consume marker at the
 * database, so a link that is somehow replayed fails on the second attempt.
 *
 * EVERY existing session for the identity is REVOKED the moment the password
 * changes (setIdentityPassword bumps roleEpoch). That is the point of a reset:
 * the operator runs it because they believe the password may be compromised, so
 * any session an attacker holds must die at the moment the owner recovers
 * control. Not doing this would leave the attacker's session alive even after
 * the legitimate user "recovered" the account.
 *
 * Password strength is validated BEFORE the token is consumed, so a weak
 * password does not burn a valid reset link and force the user to request
 * another. After the consume, nothing in the remaining path is user-recoverable.
 *
 * On success the user is signed in: they just proved control of the mailbox and
 * set a password, so a second round trip adds friction without assurance.
 */
const confirmSchema = z.object({
  token: z.string().trim().min(10).max(512),
  password: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A reset token and a new password are required" },
      { status: 422 },
    );
  }

  // Validate the password BEFORE consuming, so a weak attempt does not burn the
  // link (same ordering as acceptInvite).
  try {
    assertUsablePassword(parsed.data.password);
  } catch {
    return NextResponse.json(
      { error: "That password does not meet the minimum requirements" },
      { status: 422 },
    );
  }

  const redeemed = await redeemPasswordReset(parsed.data.token);
  if (!redeemed.ok) {
    // 401 for every failure so a caller cannot distinguish "wrong token" from
    // "expired" from "already used" and use the difference to probe.
    return NextResponse.json(
      { error: "That reset link is not valid or has expired." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const identity = await getIdentityByEmail(redeemed.email);
  if (!identity) {
    // The address had an account when the link was minted but not now (deleted
    // mid-flight). Same generic failure as an invalid token.
    return NextResponse.json(
      { error: "That reset link is not valid or has expired." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const updated = await setIdentityPassword({
    accountId: identity.accountId,
    orgId: identity.orgId,
    passwordHash,
    auditRequired: () =>
      auditAuthEvent({
        intent: AUTH_AUDIT_INTENTS.passwordChanged,
        actorId: identity.accountId,
        orgId: identity.orgId,
        note: "password reset completed; all sessions revoked",
      }),
  });
  if (!updated.ok) {
    return NextResponse.json(
      { error: "That reset link is not valid or has expired." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { record, token: sessionToken } = await issueSession({ identity, method: "password" });

  const response = NextResponse.json(
    { ok: true, role: identity.role, orgId: identity.orgId, name: identity.name },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(SESSION_COOKIE_NAME, sessionToken, SESSION_COOKIE_ATTRS);
  void record;
  return response;
}