import type { Metadata } from "next";
import { COMPANY } from "@/lib/commercial";
import { AcceptInvite } from "@/app/auth/auth-forms";

/**
 * `/auth/invites/accept` — the page an invitation email links to, and the only
 * way a new account is created.
 *
 * Server shell for the client form, which validates the token with
 * `HEAD /api/auth/invites` before showing the name/password fields, then
 * `POST /api/auth/invites/accept`. The token comes from the query string.
 *
 * `force-dynamic` because the client reads the query string with
 * `useSearchParams()`.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Accept your invitation — ${COMPANY.name}`,
  robots: { index: false, follow: false },
};

export default function AcceptInvitePage() {
  return <AcceptInvite />;
}
