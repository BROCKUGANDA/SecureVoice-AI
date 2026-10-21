import type { Metadata } from "next";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { Refund } from "@/views/Legal";

/**
 * The real, shareable, indexable Refund Policy URL.
 *
 * This document did not exist at all until now — the site had Terms and Privacy
 * and no refund policy, which is the gap the publication checklist names
 * explicitly. The content is deliberately specific (prepaid-credit rules, the
 * 48-hour service-credit path, refund currency, what is not refunded, and the
 * Shariah treatment of fees and balances) because "contact us and we'll see"
 * satisfies nobody and is worse than publishing nothing.
 */
export const metadata: Metadata = {
  title: "Refund Policy",
  description:
    "SecureVoice AI refund policy for the prepaid credit wallet: purchased credits are non-refundable, and unused credits carry until they are spent or the account is closed rather than expiring on a system clock. A credit consumed by a SecureVoice infrastructure fault is returned automatically within 48 hours. Fees and credits are consideration for services (ujrah), not a loan, deposit or interest-bearing balance. Plans are billed in USD through Paddle as Merchant of Record.",
  alternates: { canonical: "/refund" },
  openGraph: {
    title: "Refund Policy — SecureVoice AI",
    description:
      "Prepaid credits, service credits for provider faults, and the Shariah treatment of fees and balances.",
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
