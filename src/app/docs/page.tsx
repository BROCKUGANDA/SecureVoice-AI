import type { Metadata } from "next";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { Docs } from "@/views/Docs";

/**
 * The real, shareable, indexable documentation URL.
 *
 * This is the single most consequential of the non-legal routes. `/` renders
 * Docs as a panel behind a click, so the API surface — endpoints, request and
 * response shapes, webhook events, the signing scheme — was in no served HTML
 * document. A bank integrating against this platform, or an auditor checking
 * whether the signing scheme is documented, could only find it by already
 * knowing the app's navigation.
 *
 * Same component as the panel, so the two cannot drift. `Docs.tsx` performs no
 * `setView` navigation (checked), so nothing renders as a dead control here.
 */
export const metadata: Metadata = {
  title: "Documentation — API, webhooks and guardrails",
  description:
    "Developer documentation for the SecureVoice AI platform: the /v1/interventions ingest API with HMAC request signing, the SV-Signature webhook scheme, agent tool endpoints, voice and language support, and the compliance guardrails enforced on every turn.",
  alternates: { canonical: "/docs" },
  openGraph: {
    title: "Documentation — SecureVoice AI",
    description:
      "Ingest API, signed webhooks, agent tools and the guardrails enforced on every turn.",
    url: "/docs",
  },
};

export default function DocsPage() {
  return (
    <PublicPageLayout current="/docs">
      <Docs />
    </PublicPageLayout>
  );
}
