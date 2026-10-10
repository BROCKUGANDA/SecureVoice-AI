import type { Metadata } from "next";
import { headers } from "next/headers";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { Pricing } from "@/views/Pricing";
import { countryFromHeaders } from "@/lib/geo";
import { auth } from "@/lib/better-auth";

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
 *
 * ## Why this route is DYNAMIC now
 *
 * It reads a request header to resolve the buyer's country for localised
 * pricing, and reads the session to prefill the buyer's email. Both make it
 * per-request — the alternative was to render the prices server-side from our
 * own figures, which is exactly the "price maths on the frontend" failure the
 * client deliberately avoids. Dynamic is the correct cost here: the page still
 * prerenders its markup, and only the price block depends on the request.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing — Plans from $99/month",
  description:
    "SecureVoice AI pricing: Starter $99/month or $990/year (500 interventions included), Growth $499/month or $4,990/year (2,500 included), and Enterprise $2,000/month or $20,000/year (10,000 included) with in-VPC deployment, BYOK and a CBUAE audit pack. Billed through Paddle as Merchant of Record, with regional prices in GBP, EUR and AUD.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing — SecureVoice AI",
    description:
      "Starter $99/month · Growth $499/month · Enterprise $2,000/month. Annual billing is two months free.",
    url: "/pricing",
  },
};

export default async function PricingPage() {
  const requestHeaders = await headers();

  // Null when Caddy could not tell us. Paddle's PricePreview resolves from the
  // visitor's own IP instead, which is more accurate — see src/lib/geo.ts.
  const country = countryFromHeaders(requestHeaders);

  // Prefill the email only for a session we actually resolved. The pricing page
  // is public; a session is a bonus, not a requirement.
  let customerEmail: string | undefined;
  try {
    const session = await auth.api.getSession({ headers: requestHeaders });
    customerEmail = session?.user?.email ?? undefined;
  } catch {
    // A session lookup failure must never break the public pricing page.
    customerEmail = undefined;
  }

  return (
    <PublicPageLayout current="/pricing">
      <Pricing country={country} customerEmail={customerEmail} />
    </PublicPageLayout>
  );
}
