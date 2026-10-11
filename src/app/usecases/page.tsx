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
  title: "Use Cases — Five regulated conversations",
  description:
    "Five regulated fraud-intervention conversations on one guardrailed engine: card and transfer fraud for banks, claims and policy fraud for insurers. Per-language outreach, protective actions that require human sign-off, and an audit trail for every step.",
  alternates: { canonical: "/usecases" },
  openGraph: {
    title: "Use Cases — SecureVoice AI",
    description:
      "Card fraud, transfer fraud, claims fraud, policy fraud and card-not-present — one engine, one audit trail.",
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
