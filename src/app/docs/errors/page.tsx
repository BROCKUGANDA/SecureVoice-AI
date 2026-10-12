import type { Metadata } from "next";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { ErrorCatalogue } from "@/views/ErrorCatalogue";

/**
 * `/docs/errors` — the index of the error catalogue every failure envelope links to.
 *
 * NOT on the indexing allowlist, on purpose. `src/proxy.ts` answers anything
 * unlisted with `X-Robots-Tag: noindex, nofollow`, and
 * `tests/surface/surface.test.ts` pins that allowlist as an exact set because the
 * same list is what keeps the console out of search engines. A reference index
 * reached from the OpenAPI contract and from `/docs` does not need to be
 * discoverable by a crawler, and joining it to that list would have been a
 * security-adjacent edit made for a documentation reason. Changing it later is a
 * one-line decision, and it should be a decision.
 */
export const metadata: Metadata = {
  title: "Error codes — SecureVoice AI API",
  description:
    "Every failure code the SecureVoice AI API returns, with its HTTP status, whether it is retryable, whether it carries Retry-After, and the exact body a caller receives.",
  alternates: { canonical: "/docs/errors" },
  openGraph: {
    title: "Error codes — SecureVoice AI API",
    description: "The complete failure vocabulary of the SecureVoice AI API.",
    url: "/docs/errors",
  },
};

export default function ErrorCataloguePage() {
  return (
    <PublicPageLayout current="/docs">
      <ErrorCatalogue />
    </PublicPageLayout>
  );
}
