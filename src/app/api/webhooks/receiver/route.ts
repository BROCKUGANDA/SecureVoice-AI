import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePlatformOperator } from "@/lib/credits";
import { db } from "@/lib/db";
import { verifySignature, WEBHOOK_SIGNATURE_HEADER } from "@/lib/outbox";
import { payload as redactPayload } from "@/lib/redact";
import { validateBankWebhook } from "@/lib/validation/webhook-schema";
import { logWarn } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/receiver — the bank side of the contract, hosted in our
 * own app so the demo never depends on a third-party webhook inspector (venue
 * networks block those, and showing our own verifier is the stronger moment).
 *
 * It performs exactly what we tell the bank to perform:
 *   1. read the RAW body bytes,
 *   2. verify SV-Signature over {timestamp}.{body},
 *   3. validate the shape against the contract `buildBankEvent` emits,
 *   4. record the delivery for /inspector.
 *
 * The secret is the same one that signs, so a mismatch here is exactly the
 * failure a bank would see.
 *
 * ── Order is load-bearing ─────────────────────────────────────────────────────
 * Verification runs FIRST, before any parsing. It used to run third: the body
 * was `JSON.parse`d and the three fields pulled out before the signature was
 * checked. The parsing result was then discarded on a 401, so the only effect of
 * the old order was to hand an unauthenticated caller a JSON parser — and to
 * spend the server's time and stack on a body whose authenticity had not been
 * established. Nothing is now read out of the body until the HMAC over those
 * exact bytes has verified.
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const header = req.headers.get(WEBHOOK_SIGNATURE_HEADER);
  const secret = process.env.BANK_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "receiver_unconfigured" }, { status: 503 });
  }

  const verdict = verifySignature(header, body, secret);
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: verdict.reason }, { status: 401 });
  }

  // Authenticated. Only now is the body worth parsing.
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const shape = validateBankWebhook(parsed);
  if (!shape.ok) {
    logWarn("bank webhook rejected", { detail: shape.error, issues: shape.issues.slice(0, 5) });
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 422 });
  }
  const event = shape.event;

  // Redact the body before storing. The bank's webhook payload may contain PII
  // (customer names, transaction details, etc.). Storing the raw body would
  // violate PDPL/GDPR. The redact module masks known PII patterns.
  //
  // `parsed` is known to be a plain object by this point — `validateBankWebhook`
  // parsed it — so the fallback branch below is only reachable for a body that
  // is valid JSON but not an object, which the schema has already excluded.
  const redactedBody = JSON.stringify(redactPayload(parsed));

  await db.inboundBankEvent.upsert({
    where: { eventId: event.event_id },
    create: {
      eventId: event.event_id,
      eventType: event.event_type,
      caseRef: event.case_ref ?? null,
      signatureValid: true,
      signatureHeader: header,
      body: redactedBody,
    },
    // A redelivery updates nothing that matters: the payload is byte-identical
    // for the same event_id because the signature covers it.
    update: {},
  });

  return NextResponse.json({ ok: true, event_id: event.event_id, verified: true });
}

/** GET returns the most recent deliveries for the /inspector view. */
export async function GET() {
  // The rows are signed bank payloads with no tenant predicate (the event
  // table predates tenant attribution), so the read is gated to a platform
  // operator. It was previously unauthenticated: anyone could list the last 25
  // bank notifications the deployment had received.
  const guard = await requirePlatformOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const rows = await db.inboundBankEvent.findMany({
    orderBy: { receivedAt: "desc" },
    take: 25,
  });
  return NextResponse.json(
    { ok: true, events: rows },
    { headers: { "Cache-Control": "no-store" } },
  );
}
