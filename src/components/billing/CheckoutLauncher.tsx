"use client";

import { useEffect, useState } from "react";
import { getPaddle } from "@/lib/paddle-browser";

/**
 * Opens the Paddle overlay for a transaction Paddle has already created.
 *
 * Deliberately not a form of our own: the card fields, the 3DS challenge and the
 * saved-customer identity all belong to Paddle's iframe, and re-implementing any
 * of it here would be a new way to lose money or leak a PAN.
 *
 * `getPaddle()` is allowed to THROW — `paddle-browser.ts` refuses a client token
 * that does not match `NEXT_PUBLIC_PADDLE_ENVIRONMENT`, because initialising the
 * live environment with a sandbox token produces an overlay that loads and then
 * rejects every card. A throw here is therefore a deployment fault, not a user
 * fault, and it is surfaced as a retryable message rather than a blank page: the
 * buyer standing at this URL has already been sent a payment link.
 */
export function CheckoutLauncher({ transactionId }: { transactionId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const paddle = await getPaddle();
        if (cancelled) return;
        if (!paddle) {
          setError(
            "The payment provider could not be reached. Try again, or use the pricing page.",
          );
          return;
        }
        paddle.Checkout.open({ transactionId });
        setOpened(true);
      } catch (err) {
        if (cancelled) return;
        // The vendor's reason is logged for the operator, not shown to the buyer:
        // it names configuration variables, and a customer on a payment page has
        // no use for that — an incident responder does.
        console.error("[checkout] Paddle could not open", err);
        setError(
          "This checkout could not be started on this device. Try again, or use the pricing page.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transactionId]);

  return (
    <section className="mx-auto max-w-lg px-6 py-16" aria-live="polite">
      <h1 className="text-xl font-semibold text-ink">Secure payment</h1>
      {error ? (
        <>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-3">{error}</p>
          <p className="mt-2 text-xs text-ink-3/70">Reference: {transactionId}</p>
          <a
            href="/pricing"
            className="mt-6 inline-flex rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-secondary"
          >
            Start a new payment
          </a>
        </>
      ) : (
        <>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
            {opened
              ? "The payment window is open. If you closed it, this page can reopen it."
              : "Opening Paddle's secure payment window…"}
          </p>
          <p className="mt-2 text-xs text-ink-3/70">Reference: {transactionId}</p>
          <button
            type="button"
            onClick={() => {
              void getPaddle()
                .then((paddle) => paddle?.Checkout.open({ transactionId }))
                .catch(() => setError("The payment window could not be reopened."));
            }}
            className="mt-6 inline-flex rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-secondary"
          >
            Reopen the payment window
          </button>
        </>
      )}
    </section>
  );
}
