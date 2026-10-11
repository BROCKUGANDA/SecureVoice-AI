import type { Metadata } from "next";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { Security } from "@/views/Security";

/**
 * The real, shareable, indexable security page.
 *
 * A security questionnaire or a procurement review asks for this page by name.
 * It was previously reachable only by clicking through the app, which means it
 * answered the question "do they have a security page" with "not one you can
 * link to".
 *
 * Same component as the panel. `Security.tsx` polls live status headers and
 * performs no `setView` navigation, so nothing here renders as a dead control.
 */
export const metadata: Metadata = {
  title: "Security — Controls, encryption and the audit chain",
  description:
    "How SecureVoice AI secures bank data: TLS 1.3 in transit, AES-256 at rest, tamper-evident hash-chained audit trail, multi-tenant isolation, least-privilege access, PII redaction before persistence, and the rules that make it structurally impossible for the voice agent to request a PIN, OTP or full card number.",
  alternates: { canonical: "/security" },
  openGraph: {
    title: "Security — SecureVoice AI",
    description:
      "TLS 1.3, AES-256, a tamper-evident audit chain, and an agent that structurally cannot ask for a PIN.",
    url: "/security",
  },
};

export default function SecurityPage() {
  return (
    <PublicPageLayout current="/security">
      <Security />
    </PublicPageLayout>
  );
}
