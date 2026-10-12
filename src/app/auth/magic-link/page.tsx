import type { Metadata } from "next";
import { COMPANY } from "@/lib/commercial";
import { siteOrigin } from "@/lib/site-origin";
import { MagicLinkRequest } from "@/app/auth/auth-forms";

/**
 * `/auth/magic-link` — request a sign-in link. The primary operator path.
 *
 * A Server Component so it can export `metadata` (which a Client Component
 * cannot) and resolve the deployment origin on the server. The interactive form
 * lives in the colocated client module.
 *
 * `force-dynamic` is required because the client form reads the query string
 * with `useSearchParams()`: a statically rendered route cannot, and the emailed
 * link lands here carrying its token.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Sign in — ${COMPANY.name}`,
  robots: { index: false, follow: false },
};

export default function MagicLinkPage() {
  return <MagicLinkRequest origin={siteOrigin()} />;
}
