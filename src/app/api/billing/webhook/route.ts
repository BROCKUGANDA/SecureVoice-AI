import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { settlePayment, type StoredEntitlement } from "@/lib/payments/provider";
import { auditMoney } from "@/lib/payments/audit";
import { handlePaddleEvent, paddleClient } from "@/lib/payments/paddle-events";
import { orgIdForPaddleCustomer } from "@/lib/payments/mirror";
import { validatePaddleWebhook } from "@/lib/validation/webhook-schema";
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

  // The declared shape is checked on every authenticated delivery and gates
  // nothing.
  //
  // WHY IT DOES NOT GATE: the header above documents what happens when a typed
  // constructor decides what is valid on this path — a field Paddle legitimately
  // omits becomes a refusal, Paddle stops retrying, and a completed payment is
  // never credited. `unmarshal` was rejected for exactly that reason and a strict
  // schema here is the same trap wearing a different hat.
  //
  // WHY IT RUNS ANYWAY: `webhook-schema` is the contract this integration is
  // documented against, and a contract with no caller drifts in silence. Checked on
  // live traffic, a vendor shape change names the field in a log line while there is
  // still a retry window to widen the schema; unchecked, the first anyone hears is
  // settlement reading a field that is no longer there.
  const shape = validatePaddleWebhook(payload);
  if (!shape.ok) {
    logWarn("[billing-webhook] delivery does not match the declared shape", {
      eventType,
      issues: shape.issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`),
    });
  }

  // OUR organization for this customer. Paddle has no notion of our tenancy.
  //
  // Two sources, in order of trust:
  //
  //   1. the reference WE minted at checkout, echoed back in `custom_data`;
  //   2. failing that, the `PaddleCustomer` row WE wrote — attribution by the
  //      vendor's customer id, reading OUR org rather than accepting a claimed one.
  //
  // (2) exists because the state the dial gate reads is often written where (1)
  // cannot see it: a pause or a resume made in the Paddle portal carries the
  // subscription's `customer_id` and not necessarily our `custom_data`. Reference-only
  // attribution answers that delivery with 200 + "unattributable", the mirror keeps
  // saying `active`, and the tenant goes on calling bank customers on an account it
  // stopped being billed for.
  //
  // An event neither source can place is ignored with 200 — we cannot attribute it,
  // and Paddle did nothing wrong by sending it.
  const orgId = await attributeOrg(data);

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
    const result = await handlePaddleEvent(eventType, data, { orgId });
    if (!result.handled) {
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
    // Chained, unlike the "not our reference" ignores below. `reference` is a
    // token WE minted at checkout, so this delivery is about our money and the
    // decision is that we will not credit it — a 400 stops Paddle retrying, which
    // makes this row the only surviving evidence that a completed charge exists
    // and was refused.
    //
    // The two ignore paths under this one do NOT chain, and that is the boundary
    // rather than an oversight: they fire on deliveries carrying no reference of
    // ours, and minting a chain row per third-party event would let traffic we do
    // not control grow the tamper-evident log that every real record shares a
    // writer lock with.
    await auditMoney({
      reference,
      ...(orgId === null ? {} : { orgId }),
      actor: "gateway:paddle",
      intent: "settlement_refused",
      detail: `delivery not settleable; nothing credited`,
      meta: {
        amountMinor: Number.isInteger(amountMinor) ? amountMinor : String(amountMinor),
        currency,
        orgAttributed: orgId !== null,
        transactionId: typeof data.id === "string" ? data.id : "",
      },
    });
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
      // The entitlements minted at checkout ride back in `custom_data` — the
      // `plan:<name>` token settlement resolves into the plan's allowance.
      // They are validated as an array of { key, units?, metadata? } objects
      // because they arrive from an external payload and are read by
      // settlement's unit logic. The gateway-record marker is always appended
      // so the refund path can still recover the Paddle transaction id.
      entitlements: [
        ...mintedEntitlements(custom),
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
      auditRecorded: result.auditRecorded,
    });

    // Money moved, but its tamper-evident record did not. 500, deliberately.
    //
    // The settlement is already committed and will not roll back, so this is not
    // a claim that nothing happened — it is a claim that we are not finished.
    // Paddle retries a 5xx, the retry re-enters `settlePayment`, hits the
    // duplicate guard, credits NOTHING a second time, and gets the chain row
    // written on the way out. Answering 200 here tells the gateway to stop
    // delivering, and the one mechanism that could still have recorded the
    // payment is gone: the product would hold customer money whose movement
    // appears only in a log line that rotates.
    if (!result.auditRecorded) {
      logWarn("[billing-webhook] settled but not chained — requesting redelivery", {
        reference,
        applied: result.applied,
      });
      return NextResponse.json(
        { error: "audit_record_incomplete", reference },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }

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

/**
 * Attribute an event to OUR org, then fall back to the mirrored customer.
 *
 * Both sources are read even when the first answers, because their DISAGREEMENT is
 * the signal worth having: a minted reference for one tenant carrying another
 * tenant's customer id means either a checkout we mis-minted or a vendor-side mixup,
 * and either way the mirror row that follows is about to be wrong for someone. The
 * reference wins — it is the token minted for this specific checkout, and a
 * `PaddleCustomer` row can be re-pointed by a later `customer.updated` — but it wins
 * loudly.
 *
 * Covered by `tests/e2e/paddle-pause-webhook.test.ts`, which signs its payloads the
 * way Paddle does and so exercises this through the same door the vendor uses rather
 * than calling it directly.
 */
async function attributeOrg(data: Record<string, unknown>): Promise<string | null> {
  const fromReference = decodeOrgId(data);
  const customerId =
    typeof data.customer_id === "string"
      ? data.customer_id
      : typeof data.customer === "string"
        ? data.customer
        : "";
  const fromCustomer = await orgIdForPaddleCustomer(customerId);
  if (fromReference && fromCustomer && fromReference !== fromCustomer) {
    logWarn("[billing-webhook] attribution conflict — minted reference wins", {
      referenceOrg: fromReference,
      mirroredCustomerOrg: fromCustomer,
      customerId,
    });
  }
  return fromReference ?? fromCustomer ?? null;
}

/**
 * Entitlements we minted at checkout, read back from `custom_data`.
 *
 * Validated to the port's `StoredEntitlement` shape — `key` is required and a
 * non-empty string, `units` must be a non-negative integer when present — and
 * anything malformed is dropped rather than trusted: this arrives from an
 * external gateway payload and feeds settlement's unit arithmetic. An empty
 * array is a valid answer (a checkout with no plan token) and means
 * settlement credits nothing, which is correct for a charge rather than a
 * purchase of units.
 */
function mintedEntitlements(custom: Record<string, unknown> | undefined): StoredEntitlement[] {
  const raw = custom?.entitlements;
  if (!Array.isArray(raw)) return [];
  const out: StoredEntitlement[] = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const key = rec.key;
    if (typeof key !== "string" || key === "" || key.length > 64) continue;
    const units = rec.units;
    if (units !== undefined && (typeof units !== "number" || !Number.isInteger(units) || units < 0))
      continue;
    const metadata = rec.metadata;
    if (
      metadata !== undefined &&
      (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
    )
      continue;
    out.push({
      key,
      ...(units === undefined ? {} : { units }),
      ...(metadata === undefined ? {} : { metadata: metadata as Record<string, unknown> }),
    });
  }
  return out;
}
