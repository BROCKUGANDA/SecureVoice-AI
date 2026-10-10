import type { Metadata } from "next";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { Refund } from "@/views/Legal";

/**
 * The real, shareable, indexable Refund Policy URL.
 *
 * This document did not exist at all until now — the site had Terms and Privacy
 * and no refund policy, which is the gap the publication checklist names
 * explicitly. The content is deliberately specific (cancellation window, refund
 * currency, prepaid-credit rules, what is not refunded) because "contact us and
 * we'll see" satisfies nobody and is worse than publishing nothing.
 */
export const metadata: Metadata = {
  title: "Refund Policy",
  description:
    "SecureVoice AI refund policy: cancel a monthly subscription any time before renewal and the unused period is refunded pro rata with no cancellation fee. Unspent prepaid intervention credits are refundable in full; credits consumed by a completed intervention call are not. Enterprise deployments are governed by the signed agreement.",
  alternates: { canonical: "/refund" },
  openGraph: {
    title: "Refund Policy — SecureVoice AI",
    description:
      "Pro-rata refunds on monthly plans, no cancellation fee, full refund on unspent prepaid credits.",
    url: "/refund",
  },
};

export default function RefundPage() {
  return (
    <PublicPageLayout current="/refund">
      <Refund />
    </PublicPageLayout>
  );
}
