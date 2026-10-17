import type { Metadata } from "next";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { UseCases } from "@/views/UseCases";

/**
 * The real, shareable, indexable use-cases URL.
 *
 * Use cases is the page that answers "does this fit a bank / an insurer", so it
 * is the one most likely to be linked from a pitch deck or a procurement thread.
 * As a panel behind a click it had no URL to paste.
 *
 * Same component as the panel. `UseCases.tsx` DOES call `launchDemo` and
 * `setView`, which are inert on a standalone route — it reads `useStandalone()`
 * from the layout and swaps both for real anchors. See src/views/UseCases.tsx.
 */
export const metadata: Metadata = {
  title: "Use Cases — Seven regulated conversations",
  description:
    "Seven regulated fraud-intervention conversations on one guardrailed engine: card, transfer and collections fraud for banks; claims fraud, policy servicing and provider pre-authorisation for insurers. Per-language outreach, protective actions that require human sign-off, and an audit trail for every step.",
  alternates: { canonical: "/usecases" },
  openGraph: {
    title: "Use Cases — SecureVoice AI",
    description:
      "Card fraud, transfer fraud and collections for banks; claims fraud, policy servicing and pre-authorisation for insurers. One engine, one audit trail.",
    url: "/usecases",
  },
};

export default function UseCasesPage() {
  return (
    <PublicPageLayout current="/usecases">
      <UseCases />
    </PublicPageLayout>
  );
}
