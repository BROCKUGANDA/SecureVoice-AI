import { NextResponse } from "next/server";
import { z } from "zod";
import { loginWithPassword } from "@/lib/auth/guards";
import { SESSION_COOKIE_ATTRS, SESSION_COOKIE_NAME } from "@/lib/auth/constants";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/password — password sign-in. The FALLBACK path.
 *
 * Magic link is primary (src/lib/auth/magic-link.ts explains why). This exists
 * for an operator on a locked-down network with no mail access.
 *
 * Every failure returns the same message and the same status, whether the
 * address is unknown, has no password set, or the password is wrong — the
 * endpoint cannot be used to enumerate staff addresses.
 */
const loginSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 422 });
  }

  const result = await loginWithPassword(parsed.data.email, parsed.data.password);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const response = NextResponse.json(
    {
      ok: true,
      role: result.identity.role,
      orgId: result.identity.orgId,
      name: result.identity.name,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(SESSION_COOKIE_NAME, result.session.token, SESSION_COOKIE_ATTRS);
  return response;
}
