import { NextResponse } from "next/server";
import { z } from "zod";
import { redeemMagicLink } from "@/lib/auth/magic-link";
import { getIdentityByEmail } from "@/lib/auth/identity";
import { issueSession } from "@/lib/auth/session";
import { SESSION_COOKIE_ATTRS, SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { AUTH_AUDIT_INTENTS, auditAuthEvent } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/magic-link/verify — redeem a link and start a session.
 *
 * Body: { token }
 *
 * The link is consumed atomically (a unique-index insert arbitrates the winner),
 * so a link works exactly once. No account is ever CREATED here: if the bound
 * address has no account the redemption fails and says so, because provisioning
 * is invite-only (src/lib/auth/signup.ts).
 *
 * On success the session cookie is set with HttpOnly + SameSite=Lax + Secure in
 * production. The cookie is the only artefact the browser keeps; authority lives
 * server-side, which is what lets the session be revoked.
 */
const verifySchema = z.object({ token: z.string().trim().min(10).max(512) });

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "A token is required" }, { status: 422 });
  }

  const redeemed = await redeemMagicLink(parsed.data.token);
  if (!redeemed.ok) {
    // 401 for every failure mode: a caller must not be able to tell "wrong
    // token" from "expired" from "no account" and use that to probe.
    return NextResponse.json(
      { error: "That sign-in link is not valid." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const identity = await getIdentityByEmail(redeemed.email);
  if (!identity) {
    return NextResponse.json(
      { error: "No account exists for that address." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const { record, token } = await issueSession({ identity, method: "magic_link" });
  await auditAuthEvent({
    intent: AUTH_AUDIT_INTENTS.loginOk,
    actorId: identity.accountId,
    orgId: identity.orgId,
    note: "signed in via magic link",
    meta: { sid: record.sid, method: "magic_link" },
  });

  const response = NextResponse.json(
    {
      ok: true,
      role: identity.role,
      orgId: identity.orgId,
      name: identity.name,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
  response.cookies.set(SESSION_COOKIE_NAME, token, SESSION_COOKIE_ATTRS);
  return response;
}