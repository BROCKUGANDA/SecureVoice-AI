import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/guards";
import { issueStepUp } from "@/lib/auth/stepup";
import { loginWithPassword } from "@/lib/auth/guards";
import { verifyPassword } from "@/lib/auth/password";
import { db } from "@/lib/db";
import { STEP_UP_WINDOW_MS } from "@/lib/auth/constants";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/step-up — re-authenticate to unlock a privileged action.
 *
 * Body: { password }
 *
 * Requires a LIVE session (so this cannot be used to obtain one) and verifies
 * the account's password. On success it records a short-lived grant BOUND TO
 * THIS SESSION (src/lib/auth/stepup.ts).
 *
 * A grant is not a privilege: `requirePrivileged` still checks the role's
 * capability, so a grant held by an Auditor does not permit a card freeze.
 *
 * One honest limitation: a password cannot be "re-entered" by a session that was
 * never password-authenticated — an operator who signed in purely by magic link
 * and never set a password has nothing to present here. That is why the brief's
 * magic-link-first design pairs with an optional password at invite acceptance:
 * without one, their only re-authentication path is redeeming a fresh magic
 * link, which `POST /api/auth/step-up` accepts via `magicToken`.
 */
const stepUpSchema = z
  .object({
    password: z.string().min(1).max(200).optional(),
    /** Alternative credential: redeem a fresh magic link as the step-up proof. */
    magicToken: z.string().trim().min(10).max(512).optional(),
  })
  .refine((v) => Boolean(v.password) || Boolean(v.magicToken), {
    message: "password or magicToken is required",
  });

export async function POST(req: Request) {
  const authed = await requireAuth(req.headers.get("cookie"));
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
  const parsed = stepUpSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "password or magicToken is required" }, { status: 422 });
  }

  let verified: { ok: true } | { ok: false; error: string };
  let method: "password" | "magic_link";

  if (parsed.data.password) {
    method = "password";
    // The password is checked against the ACCOUNT, not against a claim in the
    // request, so a step-up proves possession of the credential rather than
    // echoing something the session already believed.
    const account = await db.account.findUnique({
      where: { id: authed.identity.accountId },
      select: { passwordHash: true },
    });
    const ok = account?.passwordHash
      ? await verifyPassword(parsed.data.password, account.passwordHash)
      : false;
    verified = ok ? { ok: true } : { ok: false, error: "That password is not correct." };
  } else {
    method = "magic_link";
    // Deferred import avoids a cycle: magic-link reads identity, guards reads
    // magic-link through this route only.
    const { redeemMagicLink } = await import("@/lib/auth/magic-link");
    const redeemed = await redeemMagicLink(parsed.data.magicToken as string);
    verified =
      redeemed.ok && redeemed.email === authed.identity.email
        ? { ok: true }
        : { ok: false, error: "That sign-in link is not valid for this account." };
  }

  const grant = await issueStepUp(authed.session, verified, method);
  if ("ok" in grant && grant.ok === false) {
    return NextResponse.json(
      { error: grant.error, code: "step_up_failed" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      method,
      windowMs: STEP_UP_WINDOW_MS,
      note: `Re-authenticated. Privileged actions are unlocked for ${Math.round(STEP_UP_WINDOW_MS / 1000)} seconds.`,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
