import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";
import { requireSignedIn } from "@/lib/credits";

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
 *
 * ── AUTHENTICATED, AND NOT DERIVED FROM THE PRODUCTION SECRET ────────────────
 * Two independent changes, because either one alone leaves a disclosure:
 *
 * 1. The handler is behind `requireOperator()`. It was anonymous, and its whole
 *    job is to emit a working signature — i.e. it was an open signing oracle.
 *
 * 2. The demo secret is NO LONGER DERIVED FROM `WEBHOOK_SECRET`. It previously
 *    was, and the response echoed it back. `WEBHOOK_SECRET` is the live inbound
 *    ingest secret — the one `api/interventions` and `api/v1/interventions`
 *    verify producer signatures against — so that made the endpoint publish 128
 *    bits of HMAC output derived from it, and the `action:"verify"` branch gave
 *    anyone an oracle to test guesses against it remotely.
 *
 * Gating alone would have left an operator session able to pull production-
 * derived key material out over HTTP, which is the same finding with a login in
 * front. Derivation alone would have left the oracle open. Both are removed.
 *
 * The demo keeps its value because it never needed the production secret to
 * teach the SCHEME: `sign` and `verify` are both evaluated against this same
 * ephemeral secret, so a developer can still exercise a receiver end to end.
 * Set `WEBHOOK_DEMO_SECRET` to keep samples stable across restarts (and
 * replicas); unset, it is per-process and rotates on boot, which is the right
 * default for a credential that is published by design.
 */

// Demo signing secret. Deliberately NOT `WEBHOOK_SECRET`, and not derived from
// it: this value is returned in the response body, so whatever feeds it must be
// safe to publish. Optional override for stable samples; random per boot
// otherwise.
const DEMO_SECRET =
  process.env.WEBHOOK_DEMO_SECRET || `whsec_demo_${randomBytes(24).toString("hex")}`;

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
  // Authenticated sessions only. This handler's purpose is to mint a valid
  // signature and to echo the secret that minted it, so an anonymous caller gets
  // both — an oracle with no guesswork required.
  //
  // `requireSignedIn` rather than `requireOperator` deliberately: the Command
  // Center's webhook panel is visible to demo-role users under the Demo Mode
  // badge, and the operator gate would 403 that flow, trading a real
  // regression for a control this route does not need. What matters is that the
  // caller has a session at all — the secret returned is an ephemeral demo value
  // (see the header), not production material, so an authenticated member of
  // the platform holding it is not a disclosure. The session is resolved
  // server-side; there is no client-supplied identity to spoof.
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

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
