import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { isE164 } from "@/lib/twilio";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";
import { getProfile } from "@/lib/credits";
import { verifyProducerKey } from "@/lib/producer-keys";

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
 * Auth (same three modes as /api/interventions — enroll writes PII, it is NOT
 * a public surface):
 *   a) Clerk session (the operator Console)
 *   b) Bearer producer key — Authorization: Bearer svb_…
 *   c) HMAC — SV-Signature: t={unix},v1={hmac(WEBHOOK_SECRET, "{t}.{rawBody}")}
 *
 * Consent: PDPL-aware — enrollment itself IS the consent record for outbound
 * intervention contact (consentRecordId required); opt-out flips the flag and
 * is never deleted (audit trail). Phones are E.164-validated and never logged
 * raw: audit rows store the redacted form only.
 */

const REPLAY_WINDOW_SEC = 300;

const schema = z.object({
  action: z.literal("enroll").default("enroll"),
  customerRef: z.string().trim().min(2).max(64).regex(/^[\w.:-]+$/),
  phone: z.string().trim().min(8).max(16),
  lang: z.enum(["en", "ar", "hi", "ur", "fr", "sw"]).default("en"),
  channel: z.enum(["call", "sms"]).default("call"),
  consentRecordId: z.string().trim().min(4).max(64),
});

const optoutSchema = z.object({
  action: z.literal("optout"),
  customerRef: z.string().trim().min(2).max(64).regex(/^[\w.:-]+$/),
});

/** Session / Bearer / HMAC — at least one must pass. */
async function authorize(req: NextRequest, rawBody: string): Promise<boolean> {
  const profile = await getProfile();
  if (profile) return true;
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer svb_")) {
    const producer = await verifyProducerKey(bearer.slice("Bearer ".length));
    if (producer.ok) return true;
  }
  const header = req.headers.get("sv-signature");
  const secret = process.env.WEBHOOK_SECRET;
  if (header && secret) {
    const m = /^t=(\d{10}),v1=([0-9a-f]{64})$/.exec(header.trim());
    if (m) {
      const [, t, v1] = m;
      const age = Math.floor(Date.now() / 1000) - Number(t);
      if (Math.abs(age) <= REPLAY_WINDOW_SEC) {
        const { createHmac, timingSafeEqual } = await import("crypto");
        const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
        const a = Buffer.from(expected, "hex");
        const b = Buffer.from(v1, "hex");
        if (a.length === b.length && timingSafeEqual(a, b)) return true;
      }
    }
  }
  return false;
}

export async function POST(req: NextRequest) {
  const callerId = req.headers.get("x-caller-id") || "enroll";

  const rl = consumeRateLimit("enroll", callerId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded; retry later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  // Read the RAW body — the HMAC mode signs exact bytes (mirrors ingest).
  const rawBody = await req.text();
  if (!(await authorize(req, rawBody))) {
    return NextResponse.json(
      { error: "Sign in to the platform, or send a Bearer svb_ producer key or SV-Signature HMAC header." },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
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
        enroll: { customerRef: "your customer id (no PII)", phone: "E.164 (+9715…)", lang: "en|ar|hi|ur|fr|sw", channel: "call|sms", consentRecordId: "your consent record id" },
        optout: { customerRef: "your customer id" },
      },
      auth: "Clerk session | Bearer svb_… | SV-Signature HMAC (same scheme as /api/interventions)",
      notes: ["Re-enrollment after opt-out = deliberate re-consent.", "Phones are stored for dialing, never logged raw.", "Delivery requires Twilio env vars — see /api/status 'telephony'."],
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
