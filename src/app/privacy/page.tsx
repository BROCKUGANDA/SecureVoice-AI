import type { Metadata } from "next";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { Privacy } from "@/views/Legal";

/**
 * The real, shareable, indexable Privacy Policy URL.
 *
 * See the comment on /terms/page.tsx for why these documents are routes and not
 * only panels: a policy that exists solely behind a client-side click is not
 * publicly addressable, and this one names a controller and a processing
 * region — both of which are things a reader, a regulator or a counterparty
 * needs to be able to point at with a link.
 *
 * Renders the same component as the in-app panel, so there is one policy.
 */
export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How SecureVoice Technologies FZ-LLC handles personal data: what is collected through this website, lawful basis under UAE PDPL and EU GDPR, where data is stored and processed, sub-processors, retention, your rights, and how to contact us.",
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: "Privacy Policy — SecureVoice AI",
    description:
      "What we collect, why, where it lives, and your rights under UAE PDPL and the EU GDPR.",
    url: "/privacy",
  },
};

export default function PrivacyPage() {
  return (
    <PublicPageLayout current="/privacy">
      <Privacy />
    </PublicPageLayout>
  );
}
