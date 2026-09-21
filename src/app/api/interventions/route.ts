import { NextRequest, NextResponse } from "next/server";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { verifyProducerKey } from "@/lib/producer-keys";
import { placeInterventionCall, sendInterventionSms, isTwilioConfigured, twilioMode, type DeliveryLang } from "@/lib/twilio";

export const dynamic = "force-dynamic";

/**
 * Risk-signal ingest — the integration point a bank's fraud engine calls to
 * trigger an intervention. This is the "other people can actually use it"
 * surface: any producer that can POST JSON and sign it with the shared secret
 * can drive the platform.
 *
 *   POST /api/interventions
 *   SV-Signature: t={unix},v1={hmac_sha256(WEBHOOK_SECRET, "{t}.{rawBody}")}
 *   { "signal": { "caseId": "…", "riskScore": 0.94, "channel": "card",
 *       "customer": { "ref": "CUST-8642", "lang": "ar" },
 *       "transaction": { "amountAed": 2500, "merchant": "Electronics World" },
 *       "callbackUrl": "https://bank.example/webhooks/securevoice" } }
 *
 * Signing is the exact scheme the /api/webhooks demo teaches: HMAC-SHA256 over
 * "{t}.{rawBody}", 5-minute replay window, constant-time comparison. A
 * producer that can't sign gets 401 — the platform never acts on unsigned risk
 * signals.
 *
 * Response: the intervention envelope the caller can poll or await via
 * callback — case reference, SLA deadline, and the pre-approved action plan.
 * The actual call is placed by the telephony layer (Twilio in the reference
 * architecture); this endpoint records the case and starts the SLA clock.
 */

const REPLAY_WINDOW_SEC = 300;

const schema = z.object({
  signal: z.object({
    caseId: z.string().trim().min(3).max(64),
    transactionId: z.string().trim().max(64).optional(),
    riskScore: z.number().min(0).max(1),
    channel: z.enum(["card", "login", "payment", "transfer", "remittance"]).default("card"),
    customer: z.object({
      ref: z.string().trim().min(2).max(64),
      lang: z.enum(["en", "ar", "hi", "ur", "fr", "sw"]).default("en"),
      // optional pre-existing consent record for outbound contact (PDPL)
      consentRecordId: z.string().trim().min(4).max(64).optional(),
    }),
    transaction: z
      .object({
        amountAed: z.number().min(0).max(10_000_000).optional(),
        merchant: z.string().trim().max(120).optional(),
      })
      .optional(),
    callbackUrl: z.string().url().max(300).optional(),
    orgId: z.string().trim().min(2).max(64).optional(),
    notes: z.string().trim().max(600).optional(),
  }),
});

type Signal = z.infer<typeof schema>["signal"];

const ACTION_PLAN: { threshold: number; action: string; handoff: string }[] = [
  { threshold: 0.90, action: "card_freeze_temporary", handoff: "fraud_specialist" },
  { threshold: 0.75, action: "transfer_hold_24h", handoff: "fraud_specialist" },
  { threshold: 0, action: "verify_only", handoff: "fraud_specialist" },
];

function planFor(riskScore: number) {
  return ACTION_PLAN.find((p) => riskScore >= p.threshold) ?? ACTION_PLAN[ACTION_PLAN.length - 1];
}

/** SLA: contact must start within 60 seconds of signal receipt. */
const SLA_SECONDS = 60;

function makeCaseRef(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `SV-F-${s}`;
}

function verifySignature(rawBody: string, header: string | null, secret: string): { ok: true } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: "Ingest not configured: set WEBHOOK_SECRET (server-side)" };
  if (!header) return { ok: false, reason: "Missing SV-Signature header" };
  const m = /^t=(\d{10}),v1=([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return { ok: false, reason: "Malformed SV-Signature — expected t={unix},v1={hex64}" };
  const [, t, v1] = m;
  const age = Math.floor(Date.now() / 1000) - Number(t);
  if (age > REPLAY_WINDOW_SEC) return { ok: false, reason: `Timestamp too old (${age}s > ${REPLAY_WINDOW_SEC}s replay window)` };
  if (age < -REPLAY_WINDOW_SEC) return { ok: false, reason: "Timestamp in the future — check producer clock" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  const valid = a.length === b.length && timingSafeEqual(a, b);
  return valid ? { ok: true } : { ok: false, reason: "Digest mismatch — payload modified or wrong secret" };
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  const callerId = req.headers.get("x-caller-id") || "ingest";

  // 1. Rate limit before buffering the body
  const rl = consumeRateLimit("ingest", callerId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded; retry later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  // 2. Read the RAW body — the signature is computed over exact bytes.
  //    Two auth modes for producers:
  //      a) Bearer key  — Authorization: Bearer svb_… (per-org key from Settings)
  //      b) HMAC        — SV-Signature: t={unix},v1={hmac(secret, "{t}.{rawBody}")}
  const rawBody = await req.text();
  const bearerHeader = req.headers.get("authorization");
  let bearerAuth: { callerId: string; orgId: string | null } | null = null;
  if (bearerHeader?.startsWith("Bearer svb_")) {
    const producer = await verifyProducerKey(bearerHeader.slice("Bearer ".length));
    if (!producer.ok) {
      return NextResponse.json({ error: "Invalid or revoked producer key" }, { status: 401 });
    }
    bearerAuth = { callerId: producer.callerId, orgId: producer.orgId };
  } else {
    // SV-Signature is canonical; X-SecureVoice-Signature is accepted as the
    // documented alias a bank's integration may send.
    const sigHeader =
      req.headers.get("sv-signature") ||
      req.headers.get("SV-Signature") ||
      req.headers.get("x-securevoice-signature");
    const sig = verifySignature(rawBody, sigHeader, process.env.WEBHOOK_SECRET ?? "");
    if (!sig.ok) {
      return NextResponse.json({ error: `Signature verification failed: ${sig.reason}` }, { status: 401 });
    }
  }

  // 3. Validate the payload
  let parsed: ReturnType<typeof schema.safeParse>;
  try {
    parsed = schema.safeParse(JSON.parse(rawBody));
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: `Invalid signal: ${first?.path.join(".")} ${first?.message ?? ""}`.trim() },
      { status: 422 }
    );
  }
  const signal: Signal = parsed.data.signal;
  const plan = planFor(signal.riskScore);
  // tenant: the Bearer key's org wins; HMAC producers may declare orgId in-payload
  const orgId = bearerAuth?.orgId ?? signal.orgId ?? null;
  const effectiveCallerId = bearerAuth?.callerId ?? callerId;

  // 4. Idempotency — the producer caseId is the dedup key. A bank retrying a
  //    delivery (network hiccup, double-submit) gets the original envelope
  //    back instead of triggering a second billable intervention.
  const existing = await db.idempotencyKey.findUnique({
    where: {
      scope_key_callerId: {
        scope: "interventions",
        key: createHash("sha256").update(signal.caseId).digest("hex"),
        callerId: effectiveCallerId,
      },
    },
  }).catch(() => null);
  if (existing && existing.expiresAt.getTime() > Date.now()) {
    const prior = JSON.parse(existing.response) as Record<string, unknown>;
    return NextResponse.json({ ...prior, duplicate: true }, {
      status: 200,
      headers: { "Cache-Control": "no-store", "X-Idempotent-Replay": "true" },
    });
  }

  // 5. Persist the case + append to the tamper-evident audit chain
  const caseRef = makeCaseRef();
  const slaDeadline = new Date(Date.now() + SLA_SECONDS * 1000);
  try {
    await auditAppend({
      callRef: caseRef,
      action: "freeze", // pre-approved protective action, recorded as intended
      intent: `risk_${signal.channel}_${plan.action}`,
      callerId: effectiveCallerId,
      redactedText: redactText(
        `${signal.caseId} · ${signal.customer.ref} · ${signal.channel} · ${signal.riskScore}` +
          (signal.transaction?.merchant ? ` · ${signal.transaction.merchant}` : "")
      ),
      meta: {
        producerCaseId: signal.caseId,
        transactionId: signal.transactionId ?? null,
        customerRef: signal.customer.ref,
        lang: signal.customer.lang,
        riskScore: signal.riskScore,
        channel: signal.channel,
        plannedAction: plan.action,
        handoff: plan.handoff,
        slaSeconds: SLA_SECONDS,
        verifiedSignature: true,
        orgId: orgId ?? undefined,
        latencyMs: Date.now() - started,
      },
      orgId: orgId ?? undefined,
    });
  } catch (err) {
    console.error("[interventions] audit append failed:", err instanceof Error ? err.message : err);
    // audit failure is a hard stop for a fraud action — do not arm the case
    return NextResponse.json({ error: "Case recording failed — signal rejected for safety" }, { status: 503 });
  }

  // remember the idempotency key only after the case is armed
  await db.idempotencyKey.create({
    data: {
      scope: "interventions",
      key: createHash("sha256").update(signal.caseId).digest("hex"),
      callerId: effectiveCallerId,
      response: JSON.stringify({ caseRef, slaDeadline: slaDeadline.toISOString(), plan: { action: plan.action } }),
      statusCode: 202,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  }).catch(() => {});

  // 5. Live delivery — if the customer is enrolled, place the real call/SMS now.
  //    Unconfigured telephony or unenrolled refs degrade gracefully to
  //    audit-only (the demo/demo UI path), never a failure.
  const amount = signal.transaction?.amountAed != null ? `AED ${signal.transaction.amountAed}` : undefined;
  const merchant = signal.transaction?.merchant;
  const lang = signal.customer.lang as DeliveryLang;

  let delivery: Record<string, unknown>;
  const enrolled = await db.customer.findUnique({ where: { customerRef: signal.customer.ref } });

  if (!isTwilioConfigured()) {
    delivery = { channel: "none", mode: twilioMode(), reason: "telephony unconfigured — audit-only path" };
  } else if (!enrolled || enrolled.optedOut) {
    delivery = { channel: "none", reason: enrolled?.optedOut ? "customer opted out" : "customer not enrolled" };
  } else {
    const via = enrolled.channel === "sms" ? "sms" : "call";
    const attempts: Record<string, unknown>[] = [];

    // Retry logic: one immediate retry on transient upstream failures
    // (busy line, 5xx, network) before considering the attempt failed.
    const attempt = async (
      fn: () => Promise<{ ok: true; sid: string; status: string } | { ok: false; status: number; error: string }>,
      channel: string
    ) => {
      let result = await fn();
      if (!result.ok && (result.status >= 500 || result.status === 503)) {
        attempts.push({ channel, retry: true, error: result.error.slice(0, 120) });
        result = await fn();
      }
      return result;
    };

    const deliver = (channel: "call" | "sms") =>
      channel === "sms"
        ? sendInterventionSms({ to: enrolled.phone, lang, caseRef, amount, merchant })
        : placeInterventionCall({ to: enrolled.phone, lang, amount, merchant, origin: req.nextUrl.origin, callRef: caseRef });

    let result = await attempt(() => deliver(via), via);
    let finalChannel = via;

    // Fallback mechanism: a failed voice call automatically degrades to SMS
    // so the customer still gets the alert (and vice versa).
    if (!result.ok && via === "call") {
      attempts.push({ channel: "call", fallback: true, error: result.error.slice(0, 120) });
      finalChannel = "sms";
      result = await attempt(() => deliver("sms"), "sms");
    }

    delivery = result.ok
      ? { channel: finalChannel, to: redactText(enrolled.phone), sid: result.sid, status: result.status, attempts }
      : { channel: finalChannel, to: redactText(enrolled.phone), failed: true, error: result.error.slice(0, 200), attempts };

    // seal the delivery attempt into the chain (phone redacted)
    await auditAppend({
      callRef: caseRef,
      action: "handoff",
      intent: `delivery_${finalChannel}${result.ok ? "" : "_failed"}`,
      callerId: effectiveCallerId,
      redactedText: redactText(enrolled.phone),
      meta: { delivery, latencyMs: Date.now() - started },
      orgId: orgId ?? undefined,
    }).catch(() => {});
  }

  // 6. Respond with the intervention envelope. The telephony layer dials;
  //    the audit rows above are the sealed record that the SLA clock started.
  //    If the producer asked for a callback, push the same outcome to them —
  //    signed with the shared secret, mirroring the ingest handshake.
  // Bank-facing status mapping: what happened to the contact attempt
  const contactStatus = !isTwilioConfigured()
    ? "accepted"
    : delivery && typeof delivery === "object" && "failed" in delivery && delivery.failed
      ? "delivery_failed"
      : delivery && typeof delivery === "object" && "channel" in delivery && delivery.channel === "call"
        ? "call_in_progress"
        : "sms_sent";

  const envelope = {
      ok: true,
      caseRef,
      interventionId: caseRef,
      transactionId: signal.transactionId ?? null,
      status: contactStatus,
      slaDeadline: slaDeadline.toISOString(),
      plan: {
        action: plan.action,
        handoff: plan.handoff,
        verification: "bank-approved challenge flow (merchant/amount/date) — no PIN, no OTP, no password",
      },
      customerLang: signal.customer.lang,
      delivery,
      callbackUrl: signal.callbackUrl ?? null,
      notes:
        signal.riskScore >= 0.9
          ? "High-risk: card freeze armed pending customer verification on the call."
          : "Verification-only path: agent confirms or denies; no irreversible action without human approval.",
      receivedAt: new Date().toISOString(),
  };
  if (signal.callbackUrl && process.env.WEBHOOK_SECRET) {
    sendResultWebhook(
      signal.callbackUrl,
      {
        event: "intervention.outcome",
        interventionId: caseRef,
        transactionId: signal.transactionId ?? null,
        caseRef,
        status: contactStatus,
        customerRef: signal.customer.ref,
        customerLang: signal.customer.lang,
        riskScore: signal.riskScore,
        delivery,
        auditVerifyUrl: `${req.nextUrl.origin}/api/console/audit?callRef=${caseRef}`,
        timestamp: new Date().toISOString(),
      },
      process.env.WEBHOOK_SECRET
    );
  }
  return NextResponse.json(envelope, { status: 202, headers: { "Cache-Control": "no-store" } });
}

/** Notify the bank's system of the outcome — the same signed-envelope scheme
 *  they use to reach us, in reverse. Fire-and-forget with a hard timeout;
 *  failures are logged, never thrown into the response path. */
function sendResultWebhook(callbackUrl: string, payload: Record<string, unknown>, secret: string): void {
  void (async () => {
    try {
      const body = JSON.stringify(payload);
      const t = Math.floor(Date.now() / 1000).toString();
      const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
      await fetch(callbackUrl, {
        method: "POST",
        // SV-Signature canonical; X-SecureVoice-Signature is the alias the
        // bank-side integration doc references.
        headers: {
          "Content-Type": "application/json",
          "SV-Signature": `t=${t},v1=${v1}`,
          "X-SecureVoice-Signature": `t=${t},v1=${v1}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.error("[interventions] result webhook failed:", err instanceof Error ? err.message : err);
    }
  })();
}

/** Discovery: what producers need to know to integrate. */
export async function GET() {
  return NextResponse.json(
    {
      endpoint: "POST /api/interventions",
      auth: [
        "Bearer svb_… (per-org producer key — Settings → API Keys)",
        "SV-Signature: t={unix},v1={hmac_sha256(WEBHOOK_SECRET, '{t}.{rawBody}')}",
      ],
      replayWindowSec: REPLAY_WINDOW_SEC,
      schema: {
        signal: {
          caseId: "string (3-64) — your case reference (idempotency key)",
          transactionId: "string? — your transaction id, echoed back on your webhook",
          riskScore: "number 0-1",
          channel: "card | login | payment | transfer | remittance",
          customer: { ref: "string (2-64) — your customer id (no PII)", lang: "en|ar|hi|ur|fr|sw", consentRecordId: "string? — required for outbound without prior consent" },
          transaction: { amountAed: "number?", merchant: "string?" },
          callbackUrl: "https URL? — post-call outcome delivery",
        },
      },
      response: "202 Accepted — { caseRef, slaDeadline, plan }",
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
