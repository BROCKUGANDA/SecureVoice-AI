import type { Metadata } from "next";
import { LegalPageLayout } from "@/components/shell/LegalPageLayout";
import { Terms } from "@/views/Legal";

/**
 * The real, shareable, indexable Terms of Service URL.
 *
 * A Terms of Conditions that a customer has to find by navigating a client-side
 * panel is not "clearly accessible" — it is reachable, by a person, on a good
 * day. This route makes it a URL that can be linked, cited and bookmarked, and
 * it is listed in sitemap.xml and allowlisted in src/proxy.ts.
 *
 * The component renders the same text as the in-app panel, so there is one set
 * of terms, not two that can drift.
 *
 * `metadata.title` is set so the document has its own name; `layout.tsx`'s title
 * template appends the brand.
 */
export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms governing use of the SecureVoice AI website and any evaluation access to the platform, operated by SecureVoice Technologies FZ-LLC. Covers acceptable use, demo data, automated decisions, intellectual property, limitation of liability and governing law (Dubai, UAE). Production use by a financial institution is governed by a separate signed agreement.",
  alternates: { canonical: "/terms" },
  openGraph: {
    title: "Terms of Service — SecureVoice AI",
    description:
      "The agreement governing this website and any evaluation access to the SecureVoice AI platform, operated by SecureVoice Technologies FZ-LLC.",
    url: "/terms",
  },
};

export default function TermsPage() {
  return (
    <LegalPageLayout current="/terms">
      <Terms />
    </LegalPageLayout>
  );
}
