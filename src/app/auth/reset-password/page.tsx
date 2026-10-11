import type { Metadata } from "next";
import { COMPANY } from "@/lib/commercial";
import { ResetRequest } from "@/app/auth/auth-forms";

/**
 * `/auth/reset-password` — request a password-reset link.
 *
 * Server shell for the client request form. Like its magic-link sibling, the
 * acknowledgement it shows is identical whether or not the address has an
 * account, so the page cannot be used to enumerate staff addresses.
 */
export const metadata: Metadata = {
  title: `Reset your password — ${COMPANY.name}`,
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return <ResetRequest />;
}
