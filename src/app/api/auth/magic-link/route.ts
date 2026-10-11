import { NextResponse } from "next/server";
import { z } from "zod";
import { issueMagicLink } from "@/lib/auth/magic-link";
import { deliverMagicLink, isEmailConfigured } from "@/lib/email/resend";

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
 * The link itself is delivered by the Resend sender (src/lib/email/resend.ts).
 * When RESEND_API_KEY is unset the endpoint refuses rather than leaks: a login
 * endpoint that echoes a usable token back to whoever asked is an open door.
 */
const requestSchema = z.object({
  email: z.string().trim().min(3).max(254),
});

/**
 * Delivery. Delegates to the Resend sender, which is the single place that
 * talks to the mail provider (src/lib/email/resend.ts).
 *
 * The gate is `isEmailConfigured()` — a real capability check against
 * RESEND_API_KEY — rather than the old `SV_MAGIC_LINK_MAILER === "configured"`
 * flag, which could be set on a deployment with no key behind it and would
 * then mint tokens that could never be delivered.
 *
 * `deliverMagicLink` THROWS when Resend rejects the message. That propagates to
 * the catch below: the client gets 503, not a cheerful 202 promising a link
 * that was never sent. The uniform acknowledgement in the 202 path is
 * preserved exactly — an attacker still cannot learn whether an address has an
 * account, and a provider outage still does not become an account oracle.
 */
const MAILER_CONFIGURED = isEmailConfigured();

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

  let result: Awaited<ReturnType<typeof issueMagicLink>>;
  if (MAILER_CONFIGURED) {
    try {
      result = await issueMagicLink(parsed.data.email, deliverMagicLink);
    } catch {
      // The token is already stored at this point (issueMagicLink writes
      // BEFORE it delivers), so a failed send leaves a live-but-unreachable
      // token. It is short-lived and single-use, so the cost of the outage is
      // one wasted row, not a credential. Report the outage so the client
      // retries and a fresh token supersedes this one.
      console.error("[auth] magic-link delivery failed");
      return NextResponse.json(
        { error: "Sign-in email could not be sent. Please try again shortly." },
        { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" } },
      );
    }
  } else {
    result = await issueMagicLink(parsed.data.email, undefined);
  }

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
