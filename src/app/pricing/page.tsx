import type { Metadata } from "next";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { Pricing } from "@/views/Pricing";

/**
 * The real, shareable, indexable pricing URL.
 *
 * The same `Pricing` component also renders as a panel inside the SPA at `/`.
 * This route exists because of what a crawler can actually reach: the in-app
 * panel is behind a click, so its text is not in the HTML that `/` serves, and
 * "pricing is published" is not a claim a crawler can verify. See the comment on
 * `INDEXABLE_PATHS` in src/app/sitemap.ts.
 *
 * Metadata is declared here rather than inherited so this document can carry a
 * commercial query in its <title> and its canonical URL. `layout.tsx`'s
 * `title.template` appends the brand, so `title` here is just the lead-in.
 */
export const metadata: Metadata = {
  title: "Pricing — Plans from $10/month",
  description:
    "SecureVoice AI pricing: Starter $10/month or $100/year (1,000 interventions, 1 bank entity, 7-day free trial), Pro $40/month or $400/year (5,000 interventions, 5 entities, 99.9% SLA), and Advanced $120/month or $1,200/year with negotiated volume, in-VPC deployment, BYOK and a CBUAE audit pack. Billed through Paddle as Merchant of Record, with regional prices in GBP, EUR and AUD.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing — SecureVoice AI",
    description:
      "Starter $10/month · Pro $40/month · Advanced $120/month. 7-day free trial on every monthly plan; annual billing is two months free.",
    url: "/pricing",
  },
};

export default function PricingPage() {
  return (
    <PublicPageLayout current="/pricing">
      <Pricing />
    </PublicPageLayout>
  );
}
