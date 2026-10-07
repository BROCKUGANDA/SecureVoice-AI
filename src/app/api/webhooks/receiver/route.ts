import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifySignature, WEBHOOK_SIGNATURE_HEADER } from "@/lib/outbox";
import { payload as redactPayload } from "@/lib/redact";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/receiver — the bank side of the contract, hosted in our
 * own app so the demo never depends on a third-party webhook inspector (venue
 * networks block those, and showing our own verifier is the stronger moment).
 *
 * It performs exactly what we tell the bank to perform:
 *   1. read the RAW body bytes,
 *   2. verify SV-Signature over {timestamp}.{body},
 *   3. record the delivery for /inspector.
 *
 * The secret is the same one that signs, so a mismatch here is exactly the
 * failure a bank would see.
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const header = req.headers.get(WEBHOOK_SIGNATURE_HEADER);
  const secret = process.env.BANK_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "receiver_unconfigured" }, { status: 503 });
  }

  const verdict = verifySignature(header, body, secret);
  let parsed: { event_id?: string; event_type?: string; case_ref?: string | null } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (!verdict.ok) {
    return NextResponse.json({ ok: false, error: verdict.reason }, { status: 401 });
  }

  // Redact the body before storing. The bank's webhook payload may contain PII
  // (customer names, transaction details, etc.). Storing the raw body would
  // violate PDPL/GDPR. The redact module masks known PII patterns.
  let redactedBody: string;
  try {
    const parsedBody = JSON.parse(body);
    redactedBody = JSON.stringify(redactPayload(parsedBody));
  } catch {
    // If the body isn't valid JSON, store a redacted string version
    redactedBody = body.replace(
      /[<>&'"]/g,
      (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
    );
  }

  await db.inboundBankEvent.upsert({
    where: { eventId: String(parsed.event_id ?? "") },
    create: {
      eventId: String(parsed.event_id ?? ""),
      eventType: String(parsed.event_type ?? "unknown"),
      caseRef: parsed.case_ref ?? null,
      signatureValid: true,
      signatureHeader: header,
      body: redactedBody,
    },
    // A redelivery updates nothing that matters: the payload is byte-identical
    // for the same event_id because the signature covers it.
    update: {},
  });

  return NextResponse.json({ ok: true, event_id: parsed.event_id ?? null, verified: true });
}

/** GET returns the most recent deliveries for the /inspector view. */
export async function GET() {
  const rows = await db.inboundBankEvent.findMany({
    orderBy: { receivedAt: "desc" },
    take: 25,
  });
  return NextResponse.json(
    { ok: true, events: rows },
    { headers: { "Cache-Control": "no-store" } },
  );
}
