import type { Metadata } from "next";
import { COMPANY } from "@/lib/commercial";
import { MagicLinkVerify } from "@/app/auth/auth-forms";

/**
 * `/auth/magic-link/verify` — redeem the token carried by a sign-in link.
 *
 * Server shell for the client verifier: the redemption must run in the browser,
 * because the session it establishes is an HttpOnly cookie the API sets on the
 * response. The token is read from the query string and never rendered.
 *
 * `force-dynamic` because the client reads the query string with
 * `useSearchParams()`.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Signing in — ${COMPANY.name}`,
  robots: { index: false, follow: false },
};

export default function MagicLinkVerifyPage() {
  return <MagicLinkVerify />;
}
