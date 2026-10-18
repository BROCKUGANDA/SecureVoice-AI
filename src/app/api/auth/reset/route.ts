import { NextResponse } from "next/server";
import { z } from "zod";
import { issuePasswordReset } from "@/lib/auth/password-reset";
import { getIdentityByEmail } from "@/lib/auth/identity";
import { isValidEmail } from "@/lib/auth/password";
import { enqueueAndSendEmail } from "@/lib/email/queue";
import { AUTH_AUDIT_INTENTS, auditAuthEvent } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/reset — request a password-reset link.
 *
 * Body: { email }
 * Response: 202 ALWAYS, with the SAME body whether or not the address has an
 * account. Answering differently turns this into an account oracle: "that
 * address is not registered" tells an attacker which addresses are bank staff.
 * This mirrors the magic-link route's contract exactly.
 *
 * Minting + delivery:
 *   · Only an address that HAS an account gets a token and an email.
 *   · The neutral 202 is returned either way, so nothing leaks.
 *   · Delivery is enqueue-then-attempt (src/lib/email/queue.ts); a provider
 *     failure is logged and retried by the drain worker, and STILL answered
 *     with the neutral 202 — a transient outage must not become a second
 *     enumeration oracle by producing a different status code.
 */
const requestSchema = z.object({
  // `isValidEmail`, not just a length: the 422 below says "a valid email is
  // required", and until now it accepted `nope`. Malformed input is refused
  // identically for a registered and an unregistered address, so this does not
  // create an enumeration channel — the neutral 202 still covers every address
  // that is shaped like an email, known or not.
  email: z.string().trim().min(3).max(254).refine(isValidEmail, "not an email address"),
});

const NEUTRAL = "If that address belongs to an account, a password reset link is on its way.";

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

  const identity = await getIdentityByEmail(parsed.data.email);

  // No account (or no mailer configured): no token, no email, and the caller
  // cannot tell this apart from a success.
  if (identity) {
    try {
      await issuePasswordReset(identity.email, async (input) => {
        const result = await enqueueAndSendEmail({
          kind: "password_reset",
          toEmail: input.email,
          subject: "Reset your SecureVoice password",
          token: input.token,
          props: { expiresAt: input.expiresAt, name: identity.name },
        });
        if (!result.ok) {
          throw new Error(`password-reset enqueue failed (${result.reason}): ${result.detail}`);
        }
      });
      await auditAuthEvent({
        intent: AUTH_AUDIT_INTENTS.passwordResetIssued,
        actorId: identity.accountId,
        orgId: identity.orgId,
        note: "password reset link issued",
      });
    } catch {
      // A provider outage must not change this endpoint's answer, or it becomes
      // an oracle: "registered address → 503" would enumerate staff addresses.
      console.error("[auth] password-reset enqueue failed");
    }
  }

  return NextResponse.json(
    { ok: true, message: NEUTRAL },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}
