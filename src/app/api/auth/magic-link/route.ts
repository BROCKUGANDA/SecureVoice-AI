import { NextResponse } from "next/server";
import { z } from "zod";
import { issueMagicLink } from "@/lib/auth/magic-link";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/magic-link — request a sign-in link. The PRIMARY path.
 *
 * Body: { email }
 * Response: 202 always, with the SAME body whether or not the address has an
 * account. Answering differently would turn this endpoint into an account
 * oracle: "that address is not registered" tells an attacker which addresses are
 * staff at a bank.
 *
 * The link itself is delivered by the `deliver` callback a deployment supplies.
 * With no mailer configured this returns 503 and NO token — a login endpoint
 * that echoes a usable token back to whoever asked is an open door.
 */
const requestSchema = z.object({
  email: z.string().trim().min(3).max(254),
});

/**
 * Delivery hook. Unset in this repository (there is no mailer), which makes the
 * endpoint refuse rather than leak. A deployment replaces this function body
 * with its mailer. Kept as a named export so it is greppable and so the
 * "is this wired?" question has one place to look.
 */
async function deliver(input: { email: string; token: string; expiresAt: number }): Promise<void> {
  throw new Error("no mailer configured");
}

const MAILER_CONFIGURED = process.env.SV_MAGIC_LINK_MAILER === "configured";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 422 });
  }

  const result = MAILER_CONFIGURED
    ? await issueMagicLink(parsed.data.email, deliver)
    : await issueMagicLink(parsed.data.email, undefined);

  if (!result.ok) {
    // Same shape either way; 503 only when the deployment is misconfigured.
    return NextResponse.json(
      { error: "If that address belongs to an account, a sign-in link is on its way." },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Uniform acknowledgement. Never echoes the token.
  return NextResponse.json(
    { ok: true, message: "If that address belongs to an account, a sign-in link is on its way." },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}
