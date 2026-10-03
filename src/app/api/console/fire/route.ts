import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createHmac, randomUUID } from "crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSignedIn, deductCredit, refundCredit } from "@/lib/credits";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { env, SUPPORTED_LANGS } from "@/lib/config";
import { paymentRequired, upstreamError, parseJson } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/**
 * Operator Console — fire a risk signal through the REAL production path.
 *
 * Gates, in order:
 *   1. session (signed in)                        → 401
 *   2. Prepaid credits wallet: 1 credit per intervention → 402 when empty
 *   3. Rate limit per operator                          → 429
 *   4. The operator's own ENROLLED customer             → 409 when there is
 *      none, when it has opted out, or when it carries no consent record
 *
 * The WEBHOOK_SECRET never reaches a browser: this handler signs the exact
 * bytes a bank's fraud engine would send and POSTs them to
 * /api/v1/interventions — the canonical hardened ingest. So a judge's click
 * traverses every gate a real bank's signal does: signature → Idempotency-Key
 * → strict schema → the combined idempotency+consent check → runPolicyGate →
 * assertDialAllowed (geo, plan tier, cooldown, concurrency, velocity) →
 * createCase → transitionCase(SCREENED) → enqueueDialJob. The call is placed
 * by the dial worker; this handler never places one.
 *
 * It used to forward to /api/interventions, an older second ingest with NO
 * policy gate, NO abuse gate, NO Case row and NO durable queue, which placed
 * the carrier call inside the web request. That is why the previous docstring's
 * "the identical flow, provably end-to-end" was false.
 *
 * Money: the console collects MAJOR units (`amountAed`, what an operator types
 * into the form). The v1 ingest takes an INTEGER in minor units. The
 * conversion happens here, once, and never forwards a float.
 *
 * `channel` is accepted for the operator's runbook display and echoed back,
 * but it is deliberately NOT forwarded: the v1 schema is `.strict()` and
 * rejects unknown fields, so a channel that is not in the contract would be
 * answered 422 upstream. The hardened ingest models the decision from risk
 * score, amount, consent and policy — there is no channel in it.
 */

const schema = z.object({
  riskScore: z.number().min(0.5).max(0.99),
  channel: z.enum(["card", "login", "payment", "transfer", "remittance"]).default("card"),
  lang: z.enum(SUPPORTED_LANGS).default("en"),
  amountAed: z.number().min(0).max(1_000_000).optional(),
  merchant: z.string().trim().max(120).optional(),
});

/**
 * SLA: contact must start within 60 seconds of signal receipt. Carried here
 * (unchanged) because the Console view renders a countdown from it and the v1
 * envelope does not carry one — the response is `queued`, so the deadline is
 * the clock the operator watches, not a promise about the carrier.
 */
const SLA_SECONDS = 60;

/** ISO-4217. The console form collects AED, so the signal is AED. */
const CURRENCY = "AED";
/** AED minor unit = 1 fil = 1/100 major. */
const MINOR_UNITS_PER_MAJOR = 100;

/**
 * The band a signal always lands in when nothing higher matches — the lowest
 * threshold in ACTION_PLAN. Named so the lookup's fallback is a value the
 * compiler can prove exists, rather than a positional index into the table
 * that no guard covers. The table's terminal row IS this value, so the two
 * cannot drift apart.
 */
const TERMINAL_BAND = {
  threshold: 0,
  action: "verify_only",
  handoff: "fraud_specialist",
};

/**
 * The action bands the Console's runbook renders. Presentation only: what is
 * actually armed is decided upstream, by the policy gate, the abuse gate and
 * the case state machine — not from this table.
 */
const ACTION_PLAN: readonly { threshold: number; action: string; handoff: string }[] = [
  { threshold: 0.9, action: "card_freeze_temporary", handoff: "fraud_specialist" },
  { threshold: 0.75, action: "transfer_hold_24h", handoff: "fraud_specialist" },
  TERMINAL_BAND,
];

/**
 * Major units → INTEGER minor units. Named because the console form collects
 * major units and the v1 contract takes minor units: forwarding the form
 * value unchanged is a 100× error, and forwarding a float is a schema
 * rejection. The rounding happens once, here.
 */
function toMinorUnits(amountAed: number | undefined): number {
  if (amountAed === undefined) return 0;
  return Math.round(amountAed * MINOR_UNITS_PER_MAJOR);
}

/**
 * The customer reference the Console enrolls under and fires at: derived from
 * the signed-in operator's own email, identically in this handler and in
 * `selfRef()` in src/views/Console.tsx, which posts it to /api/enroll.
 */
function selfCustomerRef(email: string): string {
  // `String.prototype.split` always returns at least one element, so this
  // fallback is unreachable in practice; it exists so the handler cannot
  // throw on a malformed address, and preserves today's behaviour if it ever
  // could.
  const local = email.split("@")[0] ?? email;
  return `SELF-${local.replace(/\W/g, "").slice(0, 24) || "operator"}`;
}

export async function POST(req: NextRequest) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return guard.status === 401
      ? NextResponse.json({ error: guard.error }, { status: 401 })
      : NextResponse.json({ error: guard.error }, { status: 403 });
  }
  const profile = guard.profile;

  // Prepaid wallet — CLAIM the credit BEFORE any upstream cost is incurred.
  // A check-then-deduct-afterwards pair lets N concurrent fires all pass the
  // guard on a 1-credit wallet; deductCredit's atomic decrement makes the
  // claim itself the gate. It is refunded on EVERY path where the
  // intervention was not accepted — including the refusals below and the rate
  // limit, which are not upstream failures but are equally "nothing was
  // armed", so the operator must not pay for them.
  const claimed = await deductCredit(profile.userId);
  if (claimed < 0) {
    return paymentRequired(
      "Insufficient credits — your wallet is empty. Contact your administrator to top up.",
      { credits: 0 },
    );
  }

  /**
   * Every exit that armed nothing returns the operator's credit — and says so
   * in the body. The Console reads `creditsRemaining` to redraw its wallet
   * (src/views/Console.tsx:352), so a refusal that omitted it would leave the
   * operator staring at a balance one lower than reality.
   */
  const refundAnd = async (
    payload: Record<string, unknown>,
    status: number,
  ): Promise<NextResponse> => {
    const creditsRemaining = await refundCredit(profile.userId);
    return NextResponse.json({ ...payload, creditsRemaining }, { status });
  };

  const rl = consumeRateLimit("console-fire", profile.userId);
  if (!rl.ok) {
    return refundAnd({ error: "Rate limit exceeded; retry later." }, 429);
  }

  const body = await parseJson(req);
  if (body === null) return refundAnd({ error: "Invalid JSON body" }, 400);

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return refundAnd(
      {
        error: `Invalid signal: ${first?.path.join(".")} ${first?.message ?? ""}`.trim(),
        code: "invalid_payload",
      },
      422,
    );
  }

  const secret = env.webhookSecret;
  if (!secret) {
    return refundAnd(
      { error: "WEBHOOK_SECRET not configured — ingest is unarmed (see /api/status)." },
      503,
    );
  }

  const d = parsed.data;

  // ── Resolve the destination, TENANT-SCOPED ──
  //
  // This is the exact expression /api/interventions issues for the same
  // question (WP-12 isolation matrix): a tenant-bound caller may only resolve
  // its own customer, and an org-less caller only the shared rows. A signal
  // that named another org's customerRef must resolve to NOTHING here, never
  // to that org's phone number — this is the field that becomes a dialled
  // number, so an unscoped read here is a cross-tenant dial.
  const customerRef = selfCustomerRef(profile.email);
  const orgId = profile.orgId;
  const enrolled = orgId
    ? await db.customer.findFirst({ where: { customerRef, orgId } })
    : await db.customer.findFirst({
        where: { customerRef, OR: [{ orgId: null }, { orgId: "default" }] },
      });

  // No enrolled customer: there is no phone to call and no consent record to
  // cite. A typed refusal is the honest answer. Fabricating a number here
  // would put an unconsented call on a stranger's phone, and falling back to
  // the ungated legacy ingest would reintroduce the bypass this route exists
  // to close.
  if (!enrolled) {
    return refundAnd(
      {
        error: `No enrolled customer for ${customerRef} in this workspace. Step 1 of the Console — "Connect your phone" — enrolls one; the platform will not invent a destination.`,
        code: "customer_not_enrolled",
        customerRef,
      },
      409,
    );
  }

  // PDPL: an opt-out is honoured before anything else, and re-enrollment never
  // silently reverses it (that needs the explicit re-consent flag on
  // /api/enroll). The v1 route enforces this too; refusing here means the
  // operator is told why instead of receiving an opaque upstream 409.
  if (enrolled.optedOut) {
    return refundAnd(
      {
        error:
          "This customer has opted out of outbound contact. No signal was armed and no credit was spent.",
        code: "consent_opted_out",
        customerRef,
      },
      409,
    );
  }

  // The consent record is a REQUIRED field of the v1 contract, not an
  // optional one. A row without one cannot produce a lawful signal, and
  // inventing an id here would defeat the exact check the gate performs.
  const consentRecordId = enrolled.consentRecordId;
  if (!consentRecordId) {
    return refundAnd(
      {
        error:
          "This enrollment carries no consent record, so the platform cannot cite one for outbound contact. Re-enroll with a consent record id.",
        code: "consent_record_missing",
        customerRef,
      },
      409,
    );
  }

  // E.164 is a hard requirement of the v1 schema. Refuse here so the operator
  // gets the reason rather than an upstream 422 they cannot act on.
  if (!/^\+[1-9]\d{7,14}$/.test(enrolled.phone)) {
    return refundAnd(
      {
        error:
          "The enrolled phone number is not E.164. Re-enroll with a number like +971501234567.",
        code: "customer_phone_invalid",
        customerRef,
      },
      422,
    );
  }

  // ── Build the v1 signal ──
  //
  // A stable, unique transaction reference for this fire. The same value is
  // the Idempotency-Key, so a retried POST of the SAME signal replays the
  // stored response instead of arming a second case and dialling twice.
  const transactionRef = `CONSOLE-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
  const signal = {
    transaction_ref: transactionRef,
    risk_score: d.riskScore,
    language: d.lang,
    phone: enrolled.phone,
    currency: CURRENCY,
    // INTEGER minor units — the console's major-unit form value, converted.
    amount: toMinorUnits(d.amountAed),
    ...(d.merchant ? { merchant: d.merchant } : {}),
    consent_record_id: consentRecordId,
    ...(orgId ? { org_id: orgId } : {}),
  };
  const rawBody = JSON.stringify(signal);
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");

  // Forward over the exact same wire a bank producer uses — same signature
  // scheme, same endpoint, same validation, same audit trail, same gates.
  let upstream: Response;
  try {
    upstream = await fetch(`${req.nextUrl.origin}/api/v1/interventions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "SV-Signature": `t=${t},v1=${v1}`,
        // Required by the v1 ingest (min 8 chars); tied to the transaction
        // reference so it is stable for this fire and unique across fires.
        "Idempotency-Key": `console:${transactionRef}`,
        "x-caller-id": `console:${profile.userId.slice(0, 40)}`,
      },
      body: rawBody,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // Network/timeout before a verdict — the claimed credit is refunded.
    await refundCredit(profile.userId);
    console.error("[console-fire] upstream unreachable:", err instanceof Error ? err.message : err);
    return upstreamError(
      "Intervention path unreachable — credit refunded, nothing was armed.",
      503,
    );
  }
  const data = (await upstream
    .json()
    .catch(() => ({ error: "unparseable upstream response" }))) as Record<string, unknown>;

  // The credit was claimed before the upstream call; a non-accepted
  // intervention costs the operator nothing — refund it atomically.
  if (upstream.status !== 202) {
    const credits = await refundCredit(profile.userId);
    return NextResponse.json(
      {
        ...data,
        creditsRemaining: credits,
        signedSignal: signal,
        channel: d.channel,
        notes:
          "Rejected upstream — the policy, consent or abuse gate refused this signal. No case was armed.",
      },
      { status: upstream.status },
    );
  }

  // Accepted. `receivedAt` is the v1 route's own stamp, so the SLA clock the
  // operator sees is anchored to when the hardened ingest accepted the signal
  // rather than to when this handler happened to forward it.
  const receivedAtMs = Date.parse(String(data.receivedAt ?? "")) || Date.now();
  // Deterministic action band for the runbook. Presentation only — what is
  // actually armed was decided upstream, from consent, policy, amount and
  // the abuse controls, not from this table.
  const plan = ACTION_PLAN.find((p) => d.riskScore >= p.threshold) ?? TERMINAL_BAND;
  return NextResponse.json(
    {
      ...data,
      caseRef: data.caseRef,
      status: data.status ?? "queued",
      delivery: data.delivery,
      slaDeadline: new Date(receivedAtMs + SLA_SECONDS * 1000).toISOString(),
      plan: {
        action: plan.action,
        handoff: plan.handoff,
        verification:
          "bank-approved challenge flow (merchant/amount/date) — no PIN, no OTP, no password",
      },
      // The exact object that was signed and forwarded. Display only.
      signedSignal: signal,
      channel: d.channel,
      notes:
        d.riskScore >= 0.9
          ? "High-risk signal accepted: the case is SCREENED and a dial job is queued. The protective action is staged by the agent on the call, after the customer verifies the transaction."
          : "Verification-only path: the case is SCREENED and a dial job is queued; no irreversible action without human approval.",
      creditsRemaining: claimed,
    },
    { status: 202 },
  );
}
