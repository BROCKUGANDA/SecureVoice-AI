import type { Metadata } from "next";
import { PublicPageLayout } from "@/components/shell/PublicPageLayout";
import { CheckoutLauncher } from "@/components/billing/CheckoutLauncher";
import { checkoutTransactionId } from "@/lib/checkout-link";

/**
 * `/checkout?_ptxn=txn_…` — the page Paddle's own `checkout.url` points at.
 *
 * Paddle returns the checkout link on the merchant's configured checkout domain
 * and expects the merchant to serve this path. The app had no route here, so
 * every link the platform handed a buyer (hosted-checkout response, an operator's
 * copy-paste, a manual invoice's payment link) resolved to a 404 while the
 * transaction waited in `draft`. The overlay on `/pricing` kept working, which is
 * why the gap was invisible: the path that starts a payment from our own page was
 * fine and the path that resumes one Paddle already created was not.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Complete your payment",
  // `noindex`, and it is not only SEO hygiene: the URL carries a transaction
  // token, and anyone holding the link can pay that transaction. A crawler that
  // indexed it would publish a payment capability for someone else's invoice.
  robots: { index: false, follow: false },
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CheckoutPage({ searchParams }: Props) {
  const resolved = checkoutTransactionId((await searchParams)._ptxn);

  if (!resolved.ok) {
    return (
      <PublicPageLayout current="/checkout">
        <section className="mx-auto max-w-lg px-6 py-16" aria-live="polite">
          <h1 className="text-xl font-semibold text-ink">This checkout link is incomplete</h1>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
            {resolved.reason === "absent"
              ? "No transaction was named in the link. Open the link your bank or our payment page sent you, or start a new payment from the pricing page."
              : "The transaction in this link is not one we can recognise. Use the link exactly as it was sent, or start a new payment from the pricing page."}
          </p>
          <a
            href="/pricing"
            className="mt-6 inline-flex rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-secondary"
          >
            Go to pricing
          </a>
        </section>
      </PublicPageLayout>
    );
  }

  return (
    <PublicPageLayout current="/checkout">
      <CheckoutLauncher transactionId={resolved.transactionId} />
    </PublicPageLayout>
  );
}
