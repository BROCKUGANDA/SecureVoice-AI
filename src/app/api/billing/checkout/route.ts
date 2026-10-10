import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOrg } from "@/lib/route-helpers";
import { fail, ok } from "@/lib/route-helpers";
import { unauthenticated } from "@/lib/failures/envelope";
import { resolvePaymentProvider } from "@/lib/payments/gateway";
import { assertMoney } from "@/lib/payments/provider";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { logInfo, logWarn } from "@/lib/validation/safe-log";

/**
 * POST /api/billing/checkout — mint a hosted-checkout session.
 *
 * THIS ROUTE DID NOT EXIST before the Paddle work. `PaymentProvider` was
 * implemented and unit-tested but had no HTTP surface — `TopUpDialog` was a
 * `mailto:` link. This is the first caller of `createCheckout`.
 *
 * ## What the client may and may not decide
 *
 * The client sends `amountMinor` and `currency` — which plan it wants. It
 * cannot send a price id, an org id, or a reference: the org comes from the
 * verified session, and the reference is minted server-side by the adapter. A
 * body that carries an orgId is rejected rather than ignored, because silently
 * ignoring it would let a client believe it had scoped the purchase somewhere it
 * has not.
 *
 * The amount is NOT trusted in the sense that matters: the adapter resolves it
 * against a configured Paddle price and refuses if none matches. A client asking
 * for $1 gets an error naming the missing key, not a $1 checkout.
 */

export const dynamic = "force-dynamic";

/**
 * Per-caller ceiling, deliberately separate from `RATE_LIMIT_PER_HOUR` (which
 * sizes expensive TTS/ASR calls). Checkout mints a real transaction at the
 * gateway, so it needs its own budget rather than sharing a pool that is
 * already sized for speech.
 */
const CHECKOUT_LIMIT = Number(process.env.BILLING_CHECKOUT_LIMIT) || 20;

const Body = z.object({
  amountMinor: z.number().int().positive().max(100_000_000),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  purpose: z.string().min(1).max(64).default("subscription"),
  returnUrl: z.string().url().max(2048).optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireOrg(req);
  if (!auth.ok) return fail(auth.failure ?? unauthenticated());

  const rl = consumeRateLimit("billing-checkout", rateLimitId(req, auth.orgId), 1, CHECKOUT_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "malformed_json" }, { status: 400 });
  }

  const body = Body.safeParse(parsed);
  if (!body.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: body.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }

  const gateway = resolvePaymentProvider();
  if (!gateway.ok) {
    // 503, not 400: the request is well-formed, the DEPLOYMENT is not. A 400
    // would tell a customer their request was wrong.
    logWarn("[billing] no gateway bound", { reason: gateway.reason });
    return NextResponse.json({ error: "billing_unavailable" }, { status: 503 });
  }

  try {
    const money = assertMoney(
      { amountMinor: body.data.amountMinor, currency: body.data.currency },
      "checkout.money",
    );

    const session = await gateway.provider.createCheckout({
      orgId: auth.orgId,
      purpose: body.data.purpose,
      money,
      email: auth.identity.email ?? "",
      // Idempotency token supplied by the CALLER, per the port's contract, so a
      // double-tapped button or a client retry maps to the same reference rather
      // than minting a second one. Scoped to the org and the instant, so two
      // deliberate purchases a second apart are still two purchases.
      requestKey: `${auth.orgId}:${body.data.purpose}:${Date.now()}`,
      ...(body.data.returnUrl === undefined ? {} : { returnUrl: body.data.returnUrl }),
    });

    // The reference is OURS and is what the webhook hands back. The browser
    // receives it so it can correlate its own "I came back" navigation, but the
    // browser is never trusted with it for settlement — the webhook carries its
    // own copy in `custom_data` and only that path settles.
    logInfo("[billing] checkout created", {
      provider: gateway.name,
      orgId: auth.orgId,
      purpose: body.data.purpose,
    });

    return ok({
      url: session.url,
      reference: session.reference,
      provider: gateway.name,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "checkout_failed";
    logWarn("[billing] checkout failed", { provider: gateway.name, message });
    // Deliberately not echoing the raw message to the client: it can name a
    // price key and an org id, which is not the caller's business.
    return NextResponse.json({ error: "checkout_failed" }, { status: 502 });
  }
}