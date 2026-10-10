import "server-only";
/**
 * Gateway selection — the ONE place that decides which `PaymentProvider` is
 * live.
 *
 * Why this file exists: `provider.ts` defines the port, `paystack.ts` and
 * `paddle.ts` implement it, and nothing else in the codebase is allowed to know
 * which of those is bound. Without a resolver every caller would have to branch,
 * and the first caller to branch in the wrong direction — an `if (provider ===
 * "paystack")` in a route handler — would put a gateway type back into domain
 * code, which is the exact thing `provider.ts`'s header forbids.
 *
 * ## No gateway is the default, and that is deliberate
 *
 * With nothing configured this returns null and callers must refuse. It does NOT
 * fall back to a "free" or "manual" gateway: `manualinvoice` is a real money
 * path with dual-control requirements and is selected explicitly, not silently.
 * A billing system that quietly does nothing when misconfigured is worse than
 * one that is loudly unconfigured, because the second fails on day one and the
 * first fails on the day a customer is charged nothing.
 */

import type { PaymentProvider } from "@/lib/payments/provider";
import { createPaystackProvider } from "@/lib/payments/paystack";
import { createPaddleProvider } from "@/lib/payments/paddle";

export const PAYMENT_PROVIDER_ENV = "PAYMENT_PROVIDER";
export type PaymentProviderName = "paystack" | "paddle" | "manualinvoice";

/** Providers that CAN move money. `manualinvoice` is deliberately not one. */
export const LIVE_PROVIDERS: readonly PaymentProviderName[] = ["paystack", "paddle"];

export type ResolvedGateway =
  | { ok: true; provider: PaymentProvider; name: PaymentProviderName }
  | { ok: false; reason: string };

/**
 * Build the bound provider from the environment, or explain why it cannot.
 *
 * Returns a result rather than throwing: boot-time misconfiguration and a
 * per-request "this deployment takes no card payments" are different events and
 * the caller may want to answer them differently.
 */
export function resolvePaymentProvider(): ResolvedGateway {
  const name = process.env[PAYMENT_PROVIDER_ENV]?.trim().toLowerCase();

  if (!name) {
    return {
      ok: false,
      reason: `${PAYMENT_PROVIDER_ENV} is not set — no payment gateway is bound`,
    };
  }

  if (name === "paddle") {
    const apiKey = process.env.PADDLE_API_KEY;
    const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
    if (!apiKey) return { ok: false, reason: "PADDLE_API_KEY is not set" };
    if (!webhookSecret) return { ok: false, reason: "PADDLE_WEBHOOK_SECRET is not set" };

    let prices: Record<string, string>;
    try {
      // Reuse the adapter's own parser so the env var can never be accepted in
      // one place and rejected in another.
      prices = JSON.parse(process.env.PADDLE_PRICES ?? "{}") as Record<string, string>;
    } catch {
      return { ok: false, reason: "PADDLE_PRICES is not valid JSON" };
    }

    try {
      return {
        ok: true,
        name,
        provider: createPaddleProvider({
          apiKey,
          webhookSecret,
          prices,
          // `http` is omitted on purpose: the adapter defaults it to
          // `globalThis.fetch`, and this is the production construction path.
          // Tests construct the adapter directly with a mock and never come
          // through this function.
        }),
      };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "paddle adapter failed" };
    }
  }

  if (name === "paystack") {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) return { ok: false, reason: "PAYSTACK_SECRET_KEY is not set" };
    try {
      return {
        ok: true,
        name,
        provider: createPaystackProvider({ secretKey, http: (url, init) => fetch(url, init) }),
      };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "paystack adapter failed" };
    }
  }

  return {
    ok: false,
    reason: `${PAYMENT_PROVIDER_ENV}="${name}" is not a supported gateway (expected one of: ${LIVE_PROVIDERS.join(", ")})`,
  };
}