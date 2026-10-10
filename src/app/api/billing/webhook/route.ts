import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { resolvePaymentProvider } from "@/lib/payments/gateway";
import { settlePayment } from "@/lib/payments/provider";
import { logInfo, logWarn } from "@/lib/validation/safe-log";

/**
 * POST /api/billing/webhook — the ONLY place money becomes credits.
 *
 * THIS ROUTE DID NOT EXIST before the Paddle work.
 *
 * ## The shape of the trust boundary
 *
 *   1. `verifyWebhook` proves the bytes came from the gateway. That is all it
 *      proves. Everything below runs only after it returns `ok`.
 *   2. `settlePayment` is the single writer of a successful `PaymentRecord` and
 *      the single bridge from money to prepaid units. It is idempotent on
 *      `(reference, eventId)`, so Paddle retrying a webhook — which it does,
 *      with backoff — settles exactly once.
 *   3. The browser never settles anything. A return from Paddle's checkout is
 *      not a signal; only this route is.
 *
 * ## Why the raw bytes matter
 *
 * The signature is computed over `ts:<raw body>`. This route reads the body ONCE
 * as text and hands those exact bytes to the adapter. It must never
 * `JSON.parse` and re-serialise, and must never let a framework parse it first —
 * key order or whitespace would change and every signature would fail. There is
 * no `req.json()` call anywhere in this file.
 *
 * ## Response codes Paddle retries on
 *
 * 2xx = settled or deliberately ignored. 4xx = this will never succeed, retrying
 * is pointless. 5xx = transient, Paddle retries. A malformed body is 400 (Paddle
 * will not fix it by retrying); a gateway misconfiguration is 503 (it might).
 */

export const dynamic = "force-dynamic";

/** Never cache, never let anything sit in front of this. */
export const revalidate = 0;

export async function POST(req: NextRequest) {
  const gateway = resolvePaymentProvider();
  if (!gateway.ok) {
    logWarn("[billing-webhook] no gateway bound", { reason: gateway.reason });
    return NextResponse.json({ error: "billing_unavailable" }, { status: 503 });
  }

  // The RAW bytes. Read once, never re-serialised — see the file header.
  const rawBody = await req.text();

  const verification = await gateway.provider.verifyWebhook({
    rawBody,
    headers: Object.fromEntries(req.headers.entries()),
  });

  if (!verification.ok) {
    logWarn("[billing-webhook] rejected", {
      provider: gateway.name,
      reason: verification.reason,
    });
    // 400 for anything the sender can fix (bad signature, stale, malformed),
    // because Paddle retrying an unsigned event is pure noise.
    return NextResponse.json({ error: verification.reason }, { status: 400 });
  }

  const event = verification.event;

  if (event.kind !== "charge.succeeded") {
    // A failed charge and a refund are recorded but never credited. Returning
    // 200 is deliberate: the event was authentic and we have dealt with it, so
    // the sender should stop retrying.
    logInfo("[billing-webhook] non-crediting event", {
      kind: event.kind,
      eventId: event.eventId,
    });
    return NextResponse.json({ received: true, credited: false }, { status: 200 });
  }

  const transactionId =
    typeof event.metadata?.["paddleTransactionId"] === "string"
      ? event.metadata["paddleTransactionId"]
      : "";

  const orgId = referenceOrgId(event.reference);
  if (orgId === null) {
    // `decodePaddleEvent` already refuses a reference that is not ours, so this
    // is unreachable in practice. It is asserted anyway because it is the one
    // condition under which we would credit money to the wrong tenant, and a
    // settlement is not somewhere to rely on a two-function invariant holding.
    logWarn("[billing-webhook] reference did not parse", { eventId: event.eventId });
    return NextResponse.json({ error: "unsupported_reference" }, { status: 400 });
  }

  try {
    // The Paddle transaction id is carried on an entitlement's metadata, which
    // is where `PaddleProvider.refund` looks it up. Without it a later refund
    // cannot be routed back to the gateway at all.
    const result = await settlePayment({
      provider: gateway.provider.id,
      orgId,
      reference: event.reference,
      money: event.money,
      status: "success",
      eventId: event.eventId,
      entitlements: [
        {
          key: "paddle_transaction",
          ...(transactionId === "" ? {} : { metadata: { paddleTransactionId: transactionId } }),
        },
      ],
    });

    // NOTE: deliberately NOT appended to `audit-chain`. That chain is a
    // tamper-evident record of CALL actions and its `action` union is
    // "tts" | "asr" | "agent" | "freeze" | "handoff" | "consent" — there is no
    // billing action, and shoehorning one in as "agent" would put a payment into
    // a chain a regulator reads to audit what the agent said to a customer.
    // The financial record is `PaymentRecord` + `UsageLedger`, both written by
    // `settlePayment` in the transaction above; `logInfo` carries the searchable
    // trace.

    logInfo("[billing-webhook] settled", {
      applied: result.applied,
      duplicate: result.duplicate,
      units: result.unitsCredited,
    });
    return NextResponse.json({ received: true, credited: result.applied }, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "settle_failed";
    logWarn("[billing-webhook] settlement failed", { message, eventId: event.eventId });
    // 500 so Paddle retries. A settlement that failed transiently must be
    // retried; returning 200 here would lose a real payment.
    return NextResponse.json({ error: "settlement_failed" }, { status: 500 });
  }
}

/**
 * The org is encoded in OUR reference, which only we mint — so this is a parse
 * of a value we generated, not a value the gateway or a client supplied.
 */
function referenceOrgId(reference: string): string | null {
  const m = /^org_([A-Za-z0-9_-]{1,40})_[A-Za-z0-9_-]{1,24}_[0-9A-Z]{26}$/.exec(reference);
  return m ? m[1]! : null;
}