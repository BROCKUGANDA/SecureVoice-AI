import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * Live webhook signing demo — the same construction used for real deliveries:
 *
 *   signing secret   whsec_… (server-side only, never sent to consumers)
 *   signed input     "{t}.{rawBody}"  (t = unix seconds)
 *   signature        HMAC-SHA256(secret, "{t}.{rawBody}")
 *   header format    t={t},v1={hex}
 *
 * The consumer recomputes the HMAC over the RAW bytes it received; any single
 * changed character invalidates the signature. That is what "signed webhooks"
 * means in practice — demonstrated here with the exact node:crypto primitives.
 */

// Demo signing secret: derived from the deployment secret when one exists so
// signatures stay stable across replicas and restarts; random per boot
// otherwise (the demo teaches the SCHEME, persistence doesn't matter there).
const DEMO_SECRET = process.env.WEBHOOK_SECRET
  ? `whsec_demo_${createHmac("sha256", process.env.WEBHOOK_SECRET).update("sv-webhook-demo").digest("hex").slice(0, 32)}`
  : `whsec_${randomBytes(24).toString("hex")}`;

const EVENTS = new Set([
  "intervention.started",
  "identity.verified",
  "account.frozen",
  "customer.confirmed",
  "case.closed",
  "escalated.human",
]);

const signSchema = z.object({
  action: z.literal("sign"),
  event: z.string().regex(/^[a-z_.]{3,40}$/),
});

const verifySchema = z.object({
  action: z.literal("verify"),
  payload: z.string().min(2).max(20_000),
  header: z.string().min(3).max(2_000),
});

function hmac(t: string, payload: string): string {
  return createHmac("sha256", DEMO_SECRET).update(`${t}.${payload}`).digest("hex");
}

const SAMPLES: Record<string, (id: string, created: string) => Record<string, unknown>> = {
  "intervention.started": (id, created) => ({
    event: "intervention.started",
    id,
    created,
    case_id: "FRAUD-2026-08612",
    trigger: "risk_score>=0.90",
    channel: "telephony",
    language_detected: "en",
  }),
  "identity.verified": (id, created) => ({
    event: "identity.verified",
    id,
    created,
    case_id: "FRAUD-2026-08612",
    method: "transaction_challenge",
    score: "2of3",
    pin_otp_requested: false,
  }),
  "account.frozen": (id, created) => ({
    event: "account.frozen",
    id,
    created,
    case_id: "FRAUD-2026-08612",
    endpoint: { type: "card", last4: "4417" },
    reason_code: "FRAUD_CONFIRMED_BY_CUSTOMER",
    risk_score: 0.94,
  }),
  "customer.confirmed": (id, created) => ({
    event: "customer.confirmed",
    id,
    created,
    case_id: "FRAUD-2026-08612",
    transaction: "TRX-99127",
    action_taken: "none",
    review_closed: true,
  }),
  "case.closed": (id, created) => ({
    event: "case.closed",
    id,
    created,
    case_id: "FRAUD-2026-08612",
    outcome: "fraud_confirmed",
    action_taken: "card_freeze",
    prevented_loss_aed: 2500,
    audit_hash: "b7f2e91c",
  }),
  "escalated.human": (id, created) => ({
    event: "escalated.human",
    id,
    created,
    case_id: "FRAUD-2026-08612",
    reason: "customer_request",
    handoff_sla_seconds: 30,
    specialist: "fraud_desk_02",
  }),
};

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsedSign = signSchema.safeParse(body);
  if (parsedSign.success) {
    const { event } = parsedSign.data;
    if (!EVENTS.has(event)) {
      return NextResponse.json({ error: `Unknown event "${event}"` }, { status: 422 });
    }
    const t = Math.floor(Date.now() / 1000).toString();
    const id = `evt_${randomBytes(6).toString("hex")}`;
    const created = new Date().toISOString();
    const payload = JSON.stringify(SAMPLES[event](id, created));
    const v1 = hmac(t, payload);
    return NextResponse.json({
      ok: true,
      event,
      payload,
      t,
      v1,
      header: `t=${t},v1=${v1}`,
      secret: DEMO_SECRET,
      scheme: "HMAC-SHA256 over `{timestamp}.{raw_body}`",
    });
  }

  const parsedVerify = verifySchema.safeParse(body);
  if (parsedVerify.success) {
    const { payload, header } = parsedVerify.data;
    const m = /^t=(\d{10}),v1=([0-9a-f]{64})$/.exec(header.trim());
    if (!m) {
      return NextResponse.json(
        { valid: false, reason: "Malformed signature header — expected t={unix},v1={hex64}" },
        { status: 200 },
      );
    }
    const [, t, v1] = m;
    // replay protection: reject deliveries older than 5 minutes
    const age = Math.floor(Date.now() / 1000) - Number(t);
    if (age > 300) {
      return NextResponse.json({
        valid: false,
        reason: `Timestamp too old (${age}s > 300s replay window)`,
      });
    }
    const expected = hmac(t, payload);
    // constant-time comparison — same discipline as production verification
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(v1, "hex");
    const valid = a.length === b.length && timingSafeEqual(a, b);
    return NextResponse.json({
      valid,
      reason: valid
        ? "Digest matches — payload intact, origin authentic"
        : "Digest mismatch — payload was modified, or signed with a different secret",
    });
  }

  return NextResponse.json(
    { error: "action must be sign{event} or verify{payload,header}" },
    { status: 422 },
  );
}
