import type { Metadata } from "next";
import { COMPANY } from "@/lib/commercial";
import { ResetConfirm } from "@/app/auth/auth-forms";

/**
 * `/auth/reset-password/confirm` — consume a password-reset token.
 *
 * This is the page the reset EMAIL links to (src/lib/email/resend.ts builds the
 * URL; the template prints it in full so an operator can compare the origin
 * before using it).
 *
 * A Server Component so it can export `metadata`; the interactive form lives in
 * the colocated client module. `force-dynamic` because the client reads the
 * token from the query string with `useSearchParams()` — a statically rendered
 * route cannot.
 *
 * The token is never rendered into the HTML and never logged. It is submitted
 * once to POST /api/auth/reset/confirm, which consumes it and revokes every
 * other session for the identity.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Set a new password — ${COMPANY.name}`,
  robots: { index: false, follow: false },
};

export default function ResetConfirmPage() {
  return <ResetConfirm />;
}
