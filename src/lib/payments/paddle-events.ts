import "server-only";

/**
 * Typed handlers for the Paddle events this system fulfils on.
 *
 * ONE handler per event type, each idempotent. The router (`handlePaddleEvent`)
 * returns `handled` for a known event and `ignored` for anything else — and both
 * return 200 to Paddle, because a 4xx for an event we do not support would make
 * Paddle retry it forever.
 *
 * ## Why unmarshal, not a hand-rolled HMAC
 *
 * The first cut verified the `Paddle-Signature` header by hand: parse
 * `ts=…;h1=…`, HMAC-SHA256 over `ts:<raw>`, compare. That is the correct
 * algorithm and it is tested. It is still the wrong implementation, because it
 * duplicates the vendor's parsing in our code — header shapes change, tolerances
 * move, and every such change is a silent digest_mismatch on live traffic.
 *
 * `paddle.webhooks.unmarshal` is the SDK's own verifier: it owns the header
 * format, the tolerance window and the constant-time compare, and it THROWS on a
 * bad signature rather than returning a value a caller could ignore. Its signature
 * is `(rawBody, secret, signatureHeader)`.
 *
 * The raw body must never be parsed first — see the route header.
 */

import { Environment, Paddle } from "@paddle/paddle-node-sdk";
import { mirrorCustomer, mirrorSubscription } from "@/lib/payments/mirror";
import { logInfo, logWarn } from "@/lib/validation/safe-log";

export type PaddleEventKind =
  | "subscription.created"
  | "subscription.updated"
  | "subscription.canceled"
  | "customer.created"
  | "customer.updated"
  | "transaction.completed";

const HANDLED: ReadonlySet<string> = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.canceled",
  "customer.created",
  "customer.updated",
  "transaction.completed",
]);

export function isHandledEvent(eventType: string): eventType is PaddleEventKind {
  return HANDLED.has(eventType);
}

/** The SDK, or null when the environment is not configured. */
export function paddleClient(): Paddle | null {
  const key = process.env.PADDLE_API_KEY?.trim();
  if (!key) return null;
  const sandbox = key.startsWith("pdl_sdbx_");
  return new Paddle(key, {
    environment: sandbox ? Environment.sandbox : Environment.production,
  });
}

export type HandleResult =
  { handled: true; kind: PaddleEventKind } | { handled: false; reason: string };

/**
 * Route one verified event to its handler.
 *
 * `orgId` is OUR organization for this customer, resolved by the caller. It is a
 * parameter rather than read from the event because Paddle has no notion of our
 * tenancy: the event's `custom_data.reference` is ours, and only we can decode it.
 */
export async function handlePaddleEvent(
  eventType: string,
  data: Record<string, unknown>,
  ctx: { orgId: string },
): Promise<HandleResult> {
  if (!isHandledEvent(eventType)) {
    return { handled: false, reason: "unsupported_event_type" };
  }

  switch (eventType) {
    case "customer.created":
    case "customer.updated":
      await onCustomer(eventType, data, ctx);
      break;
    case "subscription.created":
    case "subscription.updated":
    case "subscription.canceled":
      await onSubscription(eventType, data, ctx);
      break;
    case "transaction.completed":
      // Settlement is `settlePayment`'s job in the route, not here — this
      // handler only records that the event was seen, so the mirror and the
      // ledger cannot disagree about what arrived.
      logInfo("[paddle-event] transaction.completed", { orgId: ctx.orgId });
      break;
  }

  return { handled: true, kind: eventType };
}

async function onCustomer(
  eventType: string,
  data: Record<string, unknown>,
  ctx: { orgId: string },
): Promise<void> {
  const customerId = str(data.id);
  if (customerId === "") {
    logWarn("[paddle-event] customer event without an id", { eventType });
    return;
  }
  await mirrorCustomer({
    customerId,
    orgId: ctx.orgId,
    email: str(data.email),
    name: typeof data.name === "string" ? data.name : null,
  });
}

async function onSubscription(
  eventType: string,
  data: Record<string, unknown>,
  ctx: { orgId: string },
): Promise<void> {
  const subscriptionId = str(data.id);
  const customerId = str(data.customer_id) || str(data.customerId);
  if (subscriptionId === "" || customerId === "") {
    logWarn("[paddle-event] subscription event without ids", { eventType });
    return;
  }

  const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
  const first = items[0] ?? {};
  const price = first.price as Record<string, unknown> | undefined;
  const product = first.product as Record<string, unknown> | undefined;

  const scheduled = data.scheduled_change as Record<string, unknown> | undefined;
  const period = (data.current_billing_period ?? data.currentBillingPeriod) as
    Record<string, unknown> | undefined;

  await mirrorSubscription({
    subscriptionId,
    customerId,
    orgId: ctx.orgId,
    status: str(data.status) || "unknown",
    priceId: str(price?.id) || str(first.price_id),
    productId: str(product?.id) || str(first.product_id),
    scheduledChangeAction: typeof scheduled?.action === "string" ? scheduled.action : null,
    scheduledChangeAt: iso(scheduled?.effective_at ?? scheduled?.effectiveAt),
    currentPeriodEnd: iso(period?.ends_at ?? period?.endsAt),
  });

  logInfo("[paddle-event] subscription mirrored", {
    eventType,
    subscriptionId,
    status: str(data.status),
    // Logged because a scheduled cancel must NOT look like a terminal one, and
    // the difference is invisible in a status field.
    scheduled: typeof scheduled?.action === "string" ? scheduled.action : null,
  });
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function iso(v: unknown): Date | null {
  if (typeof v !== "string" || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
