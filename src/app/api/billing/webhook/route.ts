import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { settlePayment } from "@/lib/payments/provider";
import { handlePaddleEvent, paddleClient } from "@/lib/payments/paddle-events";
import { logInfo, logWarn } from "@/lib/validation/safe-log";

/**
 * POST /api/billing/webhook — the ONLY place money becomes credits.
 *
 * ## The signature, and why it is the SDK's and not ours
 *
 * `paddle.webhooks.unmarshal(rawBody, secret, signatureHeader)`. It owns the
 * `Paddle-Signature` header format, the replay tolerance and the constant-time
 * compare, and it THROWS on anything wrong — a value a caller could ignore is the
 * one failure mode a verifier must not have.
 *
 * THE RAW BODY. `await req.text()`, once, and never `JSON.parse`d. The digest is
 * over those exact bytes; a body the framework has already parsed changes key
 * order and whitespace and every signature fails. There is no `req.json()` call
 * anywhere in this file, and no body-parsing middleware is permitted in front of it.
 *
 * The secret is the NOTIFICATION SIGNING SECRET (`ntfs_...`), NOT the API key.
 * They are different values from different parts of the dashboard; using the API
 * key makes every delivery a `digest_mismatch` that looks exactly like an attack.
 *
 * ## Response codes, because Paddle retries on them
 *
 *   2xx — accepted, or deliberately ignored. Paddle stops retrying.
 *   4xx — will never succeed; retrying is noise.
 *   5xx — transient; Paddle SHOULD retry.
 *
 * Returning 2xx for a failed verification is the specific bug the brief warns
 * about: it tells Paddle the delivery succeeded and the retry never comes.
 *
 * ## Idempotency
 *
 * Deliveries are at-least-once and may arrive out of order. Settlement is
 * `settlePayment`, idempotent on `(reference, eventId)`; the subscription mirror
 * upserts on the Paddle id. A replay writes nothing.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: NextRequest) {
  const client = paddleClient();
  if (!client) {
    // 503, not 400: the REQUEST is fine, the DEPLOYMENT is not, and Paddle should
    // keep retrying until the operator fixes it.
    logWarn("[billing-webhook] no Paddle client", { reason: "PADDLE_API_KEY unset" });
    return NextResponse.json({ error: "billing_unavailable" }, { status: 503 });
  }

  const secret = process.env.PADDLE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    logWarn("[billing-webhook] no webhook secret", { reason: "PADDLE_WEBHOOK_SECRET unset" });
    return NextResponse.json({ error: "webhook_secret_unset" }, { status: 503 });
  }

  // The RAW bytes. Once.
  const rawBody = await req.text();
  const signature = req.headers.get("paddle-signature") ?? "";

  /**
   * VERIFY, THEN PARSE — in that order, and not with `unmarshal`.
   *
   * `unmarshal` looks like the right call and is a trap: it verifies the
   * signature and THEN constructs a typed entity, and the entity constructors
   * dereference nested fields (`timePeriod.interval`, …) that a real event may
   * legitimately omit. So a correctly-signed event can make `unmarshal` throw,
   * and a route that treats every throw as "bad signature" returns 400 — telling
   * Paddle to stop retrying a genuine payment it failed to deliver. Silent money
   * loss, with a log line that says `digest_mismatch`.
   *
   * Measured, not theorised: `unmarshal` threw `undefined is not an object
   * (evaluating 'timePeriod.interval')` on a payload whose signature the SDK's own
   * `isSignatureValid` had already accepted.
   *
   * So the two halves are separated. `isSignatureValid` is the vendor's verifier
   * and returns a clean boolean (throwing only on a malformed header, which is
   * also a rejection). The payload is parsed with `JSON.parse` on bytes we have
   * just proved came from Paddle — and if it does not parse, that is OUR bug and
   * a 500, not the sender's.
   *
   * `unmarshal` is deliberately NOT used anywhere. Its entity layer is a
   * convenience this route cannot afford.
   */
  let signatureOk = false;
  try {
    signatureOk = await client.webhooks.isSignatureValid(rawBody, secret, signature);
  } catch {
    // A malformed `Paddle-Signature` header throws out of the header parser.
    signatureOk = false;
  }
  if (!signatureOk) {
    logWarn("[billing-webhook] signature verification failed", { bodyBytes: rawBody.length });
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  // The bytes are authenticated from here. Parse them ourselves rather than let
  // a typed constructor decide what is valid.
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("payload is not an object");
    }
    payload = parsed as Record<string, unknown>;
  } catch (e) {
    // 500, not 400: the signature was GOOD, so Paddle is not the problem.
    logWarn("[billing-webhook] authenticated body did not parse", {
      message: e instanceof Error ? e.message : "unknown",
      bodyBytes: rawBody.length,
    });
    return NextResponse.json({ error: "malformed_payload" }, { status: 500 });
  }

  const eventType = typeof payload.event_type === "string" ? payload.event_type : "";
  const data =
    payload.data && typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>)
      : {};

  if (eventType === "") {
    return NextResponse.json({ error: "missing_event_type" }, { status: 400 });
  }

  // OUR organization for this customer. Paddle has no notion of our tenancy, so
  // it is decoded from the reference we minted at checkout and carried in
  // `custom_data`. An event that does not carry one is ignored with 200 — we
  // cannot attribute it, but Paddle did nothing wrong by sending it.
  const orgId = decodeOrgId(data);

  // A transaction is settled even without an org id when it carries our
  // reference; that is what `settlePayment` keys on. An org is required for the
  // MIRROR, because a mirror row without one is an orphan.
  if (eventType === "transaction.completed") {
    return settle(data, orgId);
  }

  if (orgId === null) {
    logInfo("[billing-webhook] event without an attributable org — ignored", { eventType });
    return NextResponse.json({ received: true, mirrored: false }, { status: 200 });
  }

  try {
    const result = await handlePaddleEvent(eventType, data, { orgId });    if (!result.handled) {
      // 200 with `mirrored: false`. An event type we do not support is Paddle
      // behaving correctly; a 4xx would have it retried forever.
      return NextResponse.json({ received: true, mirrored: false }, { status: 200 });
    }
    return NextResponse.json({ received: true, mirrored: true }, { status: 200 });
  } catch (e) {
    // 500 so Paddle retries. A mirrored subscription that failed transiently must
    // come back; a 200 here would silently drop the paid entitlement.
    logWarn("[billing-webhook] handler failed", {
      eventType,
      message: e instanceof Error ? e.message : "unknown",
    });
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}

/**
 * Settle a completed transaction.
 *
 * Only `charge.succeeded`-shaped events reach here — `transaction.completed` is
 * Paddle's success event — and only when the payload carries our reference.
 */
async function settle(data: Record<string, unknown>, orgId: string | null): Promise<NextResponse> {
  const custom = data.custom_data as Record<string, unknown> | undefined;
  const reference = typeof custom?.reference === "string" ? custom.reference : "";
  if (reference === "") {
    // A transaction we did not mint (a Paddle-native purchase, or another
    // tenant's). Accepting it with 200 is correct: Paddle delivered, we read it,
    // we are not the buyer.
    logInfo("[billing-webhook] transaction without our reference — ignored", {});
    return NextResponse.json({ received: true, credited: false }, { status: 200 });
  }

  const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
  const unit = (items[0]?.unit_price ?? {}) as { amount?: unknown; currency_code?: unknown };
  const amountMinor = Number(unit.amount);
  const currency = typeof unit.currency_code === "string" ? unit.currency_code : "";

  if (
    orgId === null ||
    !Number.isInteger(amountMinor) ||
    amountMinor <= 0 ||
    !/^[A-Za-z]{3}$/.test(currency)
  ) {
    logWarn("[billing-webhook] transaction not settleable", { reference, amountMinor, currency });
    return NextResponse.json({ error: "unsettleable_transaction" }, { status: 400 });
  }

  try {
    const result = await settlePayment({
      provider: "paddle",
      orgId,
      reference,
      money: { amountMinor, currency: currency.toUpperCase() },
      status: "success",
      // The Paddle event id is the dedupe token. `data.id` is the TRANSACTION id,
      // which is stable across retries of the same event — which is exactly what
      // makes a replay idempotent.
      eventId: typeof data.id === "string" ? data.id : reference,
      entitlements: [
        {
          key: "paddle_transaction",
          metadata: { paddleTransactionId: typeof data.id === "string" ? data.id : "" },
        },
      ],
    });

    logInfo("[billing-webhook] settled", {
      applied: result.applied,
      duplicate: result.duplicate,
      units: result.unitsCredited,
    });
    return NextResponse.json({ received: true, credited: result.applied }, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "settle_failed";
    logWarn("[billing-webhook] settlement failed", { message, reference });
    return NextResponse.json({ error: "settlement_failed" }, { status: 500 });
  }
}

/** Decode our org out of `custom_data.reference`, which only we mint. */
function decodeOrgId(data: Record<string, unknown>): string | null {
  const custom = data.custom_data as Record<string, unknown> | undefined;
  const reference = typeof custom?.reference === "string" ? custom.reference : "";
  const m = /^org_([A-Za-z0-9_-]{1,40})_[A-Za-z0-9_-]{1,24}_[0-9A-Z]{26}$/.exec(reference);
  return m ? m[1]! : null;
}
