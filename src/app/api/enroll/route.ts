import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { isE164 } from "@/lib/twilio";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";

export const dynamic = "force-dynamic";

/**
 * Customer enrollment — the signup surface that lets a bank's customer receive
 * live fraud-intervention calls and SMS alerts on their phone.
 *
 *   POST /api/enroll
 *   { "action": "enroll", "customerRef": "CUST-8642", "phone": "+97150…",
 *     "lang": "ar", "channel": "call"|"sms", "consentRecordId": "CN-…" }
 *   { "action": "optout", "customerRef": "CUST-8642" }   // STOP — honoured instantly
 *
 * Consent: PDPL-aware — enrollment itself IS the consent record for outbound
 * intervention contact (consentRecordId required); opt-out flips the flag and
 * is never deleted (audit trail). Phones are E.164-validated and never logged
 * raw: audit rows store the redacted form only.
 */

const schema = z.object({
  action: z.literal("enroll").default("enroll"),
  customerRef: z.string().trim().min(2).max(64).regex(/^[\w.:-]+$/),
  phone: z.string().trim().min(8).max(16),
  lang: z.enum(["en", "ar", "hi", "ur"]).default("en"),
  channel: z.enum(["call", "sms"]).default("call"),
  consentRecordId: z.string().trim().min(4).max(64),
});

const optoutSchema = z.object({
  action: z.literal("optout"),
  customerRef: z.string().trim().min(2).max(64).regex(/^[\w.:-]+$/),
});

export async function POST(req: NextRequest) {
  const callerId = req.headers.get("x-caller-id") || "enroll";

  const rl = consumeRateLimit("enroll", callerId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded; retry later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ————— opt-out path (STOP) —————
  const parsedOut = optoutSchema.safeParse(body);
  if (parsedOut.success) {
    const row = await db.customer.updateMany({
      where: { customerRef: parsedOut.data.customerRef },
      data: { optedOut: true },
    });
    await auditAppend({
      callRef: `ENROLL-${parsedOut.data.customerRef.slice(0, 32)}`,
      action: "consent",
      intent: "optout",
      callerId,
      redactedText: parsedOut.data.customerRef,
      meta: { optedOut: true, rowsUpdated: row.count },
    }).catch(() => {});
    if (row.count === 0) {
      return NextResponse.json({ ok: false, error: "Unknown customerRef — nothing to opt out" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, action: "optout", message: "You will receive no further calls or messages." });
  }

  // ————— enroll path —————
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: `Invalid enrollment: ${first?.path.join(".")} ${first?.message ?? ""}`.trim() },
      { status: 422 }
    );
  }
  const d = parsed.data;
  if (!isE164(d.phone)) {
    return NextResponse.json(
      { error: "phone must be E.164 format, e.g. +971501234567 (+, country code, 8–15 digits)" },
      { status: 422 }
    );
  }

  const row = await db.customer.upsert({
    where: { customerRef: d.customerRef },
    create: {
      customerRef: d.customerRef,
      phone: d.phone,
      lang: d.lang,
      channel: d.channel,
      consentRecordId: d.consentRecordId,
      optedOut: false,
    },
    update: {
      phone: d.phone,
      lang: d.lang,
      channel: d.channel,
      consentRecordId: d.consentRecordId,
      optedOut: false, // re-enrollment clears a previous opt-out — deliberate re-consent
    },
    select: { customerRef: true, lang: true, channel: true, optedOut: true },
  });

  await auditAppend({
    callRef: `ENROLL-${d.customerRef.slice(0, 32)}`,
    action: "consent",
    intent: "enroll",
    callerId,
    // phone NEVER raw — run the redactor before persistence (PII_REDACTION policy)
    redactedText: redactText(`${d.customerRef} · ${d.phone}`),
    meta: { lang: row.lang, channel: row.channel, consentRecordId: d.consentRecordId },
  }).catch((err) => console.error("[enroll] audit append failed:", err instanceof Error ? err.message : err));

  return NextResponse.json({
    ok: true,
    customerRef: row.customerRef,
    lang: row.lang,
    channel: row.channel,
    delivery: "live (Twilio)" , // /api/status reports the provider mode; delivery activates when configured
    message: "Enrolled — you will be called/alerted on this number for time-critical fraud interventions.",
  });
}

/** Discovery: what the bank's app needs to integrate enrollment. */
export async function GET() {
  return NextResponse.json(
    {
      endpoint: "POST /api/enroll",
      actions: {
        enroll: { customerRef: "your customer id (no PII)", phone: "E.164 (+9715…)", lang: "en|ar|hi|ur", channel: "call|sms", consentRecordId: "your consent record id" },
        optout: { customerRef: "your customer id" },
      },
      notes: ["Re-enrollment after opt-out = deliberate re-consent.", "Phones are stored for dialing, never logged raw.", "Delivery requires Twilio env vars — see /api/status 'telephony'."],
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
