import { NextResponse } from "next/server";
import { z } from "zod";
import { acceptInvite } from "@/lib/auth/invite";
import { SESSION_COOKIE_ATTRS, SESSION_COOKIE_NAME } from "@/lib/auth/constants";

export const dynamic = "force-dynamic";

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
    return NextResponse.json(
      { error: "A valid invitation token is required" },
      { status: 422 }
    );
  }

  const result = await acceptInvite({
    token: parsed.data.token,
    name: parsed.data.name,
    password: parsed.data.password,
  });

  if (!result.ok) {
    // 410 Gone for every invitation failure: expired, already used, or simply
    // not a real token. Distinguishing them would tell a prober which token
    // guesses were real invitations.
    return NextResponse.json(
      { error: result.error, code: result.reason },
      { status: 410, headers: { "Cache-Control": "no-store" } }
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
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
  // Signing the new member straight in: they have just proved they hold the
  // invitation, so requiring a second sign-in round trip adds friction without
  // adding assurance.
  response.cookies.set(
    SESSION_COOKIE_NAME,
    result.session.token,
    SESSION_COOKIE_ATTRS
  );
  return response;
}