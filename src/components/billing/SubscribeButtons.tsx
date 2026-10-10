"use client";

import { useCallback, useEffect, useState } from "react";
import { getPaddle } from "@/lib/paddle-browser";
import { SUPPORT_EMAIL } from "@/lib/public-config";

/**
 * Subscribe buttons for one tier, driven by `Paddle.PricePreview()`.
 *
 * ## No price maths on the client
 *
 * Every figure rendered here comes from `formattedTotals` as Paddle returns it.
 * No `Intl.NumberFormat`, no rounding, no arithmetic, no `* 12`. The reason is
 * not purity: Paddle applies the country's tax, its own rounding rules and the
 * local currency's minor units, and a frontend that re-derives the total from a
 * monthly figure will disagree with the invoice the moment any of those differ
 * from the assumption. Displaying Paddle's own string cannot drift from what the
 * buyer is charged.
 *
 * ## The country is a hint, not an override
 *
 * `country` is `null` when the server could not resolve one, and `null` is passed
 * through as "no country" — `PricePreview` then resolves from the visitor's IP,
 * which is more accurate than anything inferred from a header. An internal
 * sentinel is never sent to Paddle as a country code.
 */

export type SubscribeTier = {
  id: string;
  name: string;
  description: string;
  features: string[];
  /** Paddle price ids. `null` where an interval is not offered. */
  priceId: { month: string | null; year: string | null };
};

type Interval = "month" | "year";

export function SubscribeButtons({
  tier,
  country,
  customerEmail,
}: {
  tier: SubscribeTier;
  /** ISO-3166-1 alpha-2, or null to let Paddle resolve from the visitor's IP. */
  country: string | null;
  /** Prefilled from the session when the buyer is signed in. */
  customerEmail?: string;
}) {
  const [interval, setInterval] = useState<Interval>("month");
  const [totals, setTotals] = useState<Record<Interval, string | null>>({
    month: null,
    year: null,
  });
  const [error, setError] = useState<string | null>(null);

  const priceId = tier.priceId[interval];

  // Fetch a preview for BOTH intervals once, so toggling is instant and only one
  // preview is in flight rather than one per click.
  useEffect(() => {
    let alive = true;
    const priceIds = [tier.priceId.month, tier.priceId.year].filter(Boolean) as string[];
    if (priceIds.length === 0) return;

    void (async () => {
      try {
        const paddle = await getPaddle();
        if (!paddle || !alive) return;
        const preview = await paddle.PricePreview({
          items: priceIds.map((id) => ({ priceId: id, quantity: 1 })),
          ...(country ? { address: { countryCode: country } } : {}),
        });
        if (!alive) return;
        const formatted = (preview as unknown as { formattedTotals?: Record<string, string> })
          .formattedTotals;
        if (!formatted) return;
        setTotals({
          month: formatted[tier.priceId.month ?? ""] ?? null,
          year: formatted[tier.priceId.year ?? ""] ?? null,
        });
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Price preview unavailable");
      }
    })();

    return () => {
      alive = false;
    };
  }, [tier.priceId.month, tier.priceId.year, country]);

  const openCheckout = useCallback(async () => {
    setError(null);
    try {
      const paddle = await getPaddle();
      if (!paddle) throw new Error("Paddle is not initialised");
      const id = tier.priceId[interval];
      if (!id) throw new Error("No price configured for this interval");

      paddle.Checkout.open({
        items: [{ priceId: id, quantity: 1 }],
        // Overlay, one page — the shape the brief asks for. `displayMode`
        // "inline" would embed the checkout in the page, which is wrong for a
        // hosted flow and keeps the app on the hook for card handling.
        settings: {
          displayMode: "overlay",
          variant: "one-page",
          // Paddle's own redirect on success. `/welcome` is deliberately dumb
          // about what happened — the webhook is what credits.
          successUrl: `${window.location.origin}/welcome`,
        },
        // Prefilled only when the session actually has an email. Paddle accepts
        // customer data here; it does NOT accept a customerId from the client,
        // and sending one would let a buyer attach the purchase to someone
        // else's account.
        ...(customerEmail ? { customer: { email: customerEmail } } : {}),
        ...(country ? { address: { countryCode: country } } : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout could not open");
    }
  }, [interval, tier.priceId, customerEmail, country]);

  if (!priceId) {
    return (
      <p className="text-[12.5px] text-ink-3">
        This plan is quoted directly — email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
    );
  }

  return (
    <div className="mt-5">
      <div
        role="group"
        aria-label="Billing interval"
        className="inline-flex rounded-full border border-line bg-white p-0.5"
      >
        {(["month", "year"] as Interval[]).map((i) => (
          <button
            key={i}
            type="button"
            onClick={() => setInterval(i)}
            aria-pressed={interval === i}
            className={
              interval === i
                ? "rounded-full bg-primary px-3.5 py-1.5 text-[12px] font-semibold text-white"
                : "rounded-full px-3.5 py-1.5 text-[12px] font-semibold text-ink-2"
            }
          >
            {i === "month" ? "Monthly" : "Annual"}
          </button>
        ))}
      </div>

      <p className="mt-3 min-h-[28px]">
        {totals[interval] ? (
          // Paddle's own string, rendered verbatim.
          <span className="font-display text-[22px] font-semibold">{totals[interval]}</span>
        ) : (
          <span className="text-[12.5px] text-ink-3">Loading localised price…</span>
        )}
      </p>

      <button
        type="button"
        onClick={() => void openCheckout()}
        className="mt-2 w-full rounded-xl bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep"
      >
        Subscribe
      </button>

      {error && (
        <p role="alert" className="mt-2 text-[11.5px] text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
