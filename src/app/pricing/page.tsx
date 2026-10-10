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
  title: "Pricing — Plans from $490/month",
  description:
    "SecureVoice AI pricing: Starter $490/month (1,000 interventions, 1 bank entity), Pro $1,490/month (5,000 interventions, 5 entities, 99.9% SLA), and Enterprise quoted per deployment with in-VPC deployment, BYOK and a CBUAE audit pack. Feature comparison, what's included on every plan, and a custom enterprise pricing sheet.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing — SecureVoice AI",
    description:
      "Starter $490/month · Pro $1,490/month · Enterprise quoted per deployment. Every plan includes the tamper-evident audit chain.",
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
