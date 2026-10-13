import type { Metadata } from "next";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { Faq } from "@/views/Faq";
import { FaqJsonLd } from "@/components/seo/JsonLd";

/**
 * The real, shareable, indexable FAQ URL.
 *
 * The answers in `@/lib/commercial` had been published as `FAQPage` structured
 * data for the site's whole life without ever being rendered anywhere a person
 * could read them. That is the specific failure this route exists to close: a
 * page an answer engine can quote, that a human cannot open.
 *
 * Same component as any panel would render, wrapped in the public shell, for the
 * same reasons `/pricing` and `/usecases` are — a crawler reads HTML, and text
 * behind a click in `/` is not in the served document.
 *
 * ## Why this is not in `PATH_FOR_VIEW`
 *
 * `PATH_FOR_VIEW` is the *shell* map: it drives the signed-in console's URL
 * sync, and every entry in it becomes a `SHELL_PATHS` entry that
 * `tests/surface/console-routes.test.ts` asserts is `noindex`. A public,
 * indexable marketing page in that map would be stamped `noindex` by its own
 * test. Public views navigate by their real route instead — see
 * `PUBLIC_ROUTE_FOR_VIEW` in `@/lib/console-routes`.
 */
export const metadata: Metadata = {
  title: "FAQ — What banks ask before they buy",
  description:
    "How SecureVoice AI works, what it costs, who handles VAT, whether the agent ever asks for a PIN, UAE Central Bank alignment, where data is stored, and how refunds work.",
  alternates: { canonical: "/faq" },
  openGraph: {
    title: "FAQ — SecureVoice AI",
    description:
      "Pricing, compliance, data residency, refunds, and the questions a bank's procurement team actually asks.",
    url: "/faq",
  },
};

export default function FaqPage() {
  return (
    <PublicPageLayout current="/faq">
      {/*
        The FAQ schema, on the page that renders the FAQ. This is the pairing the
        root-layout mount never had: the `FAQPage` node and the visible Q&A are
        now emitted from the same `FAQ` array on the same URL, so they cannot
        describe different things.
      */}
      <FaqJsonLd />
      <Faq />
    </PublicPageLayout>
  );
}