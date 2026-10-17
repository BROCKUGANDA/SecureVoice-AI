import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createHmac, randomUUID } from "crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSignedIn } from "@/lib/credits";
import { claimRun, refundRun } from "@/lib/billing/charge-mode";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import {
  billingRefusal,
  makeFailure,
  type FailureCode,
  type FailureInit,
} from "@/lib/failures/envelope";
import { env, SUPPORTED_LANGS, slaSeconds } from "@/lib/config";
import { logError, parseJson } from "@/lib/validation/safe-log";

function failure(code: FailureCode, init: FailureInit = {}): NextResponse {
  const f = makeFailure(code, init);
  return NextResponse.json(f.body, {
    status: f.status,
    headers: { ...f.headers, "Cache-Control": "no-store" },
  });
}

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
 * SLA: contact must start within N seconds of signal receipt. Carried here
 * (unchanged) because the Console view renders a countdown from it and the v1
 * envelope does not carry one — the response is `queued`, so the deadline is
 * the clock the operator watches, not a promise about the carrier.
 *
 * Bounded so a misconfigured env value cannot park a fraud call indefinitely.
 */
const SLA_SECONDS = slaSeconds();

/** ISO-4217 currency for the signal, env-driven. */
const CURRENCY = env.interventionCurrency;
/** Minor units per major unit, env-driven. */
const MINOR_UNITS_PER_MAJOR = env.minorUnitsPerMajor;

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
function toMinorUnits(amount: number | undefined): number {
  if (amount === undefined) return 0;
  return Math.round(amount * MINOR_UNITS_PER_MAJOR);
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
    return failure(guard.status === 401 ? "unauthenticated" : "not_found", {detail: guard.error});
  }
  const profile = guard.profile;

  // Meter the run BEFORE any upstream cost is incurred.
  //
  // A check-then-deduct-afterwards pair lets N concurrent fires all pass the
  // guard on a 1-credit wallet; claimRun's atomic decrement makes the claim
  // itself the gate. It is refunded on EVERY path where the intervention was
  // not accepted — including the refusals below and the rate limit, which are not
  // upstream failures but are equally "nothing was armed", so the operator must
  // not pay for them.
  //
  // WHAT IS CLAIMED depends on who is running (src/lib/billing/charge-mode.ts):
  //
  //   · A DEMO session claims nothing and is not refused. There is no customer to
  //     invoice, and the demo credential is published in the client bundle, so a
  //     demo seat that drained a wallet made the free-tier claim on the pricing
  //     page untrue. The run is still audited — "free, and here's why" is the
  //     record that makes the demo budget defensible.
  //   · A PAID session claims one unit from the tenant's wallet AND reserves it
  //     in the UsageLedger, in one transaction. Before this, the two were
  //     disjoint: this route moved the wallet and wrote no ledger row, while the
  //     v1 bank ingest wrote ledger rows and never moved the wallet — so
  //     "credits remaining" meant two different numbers depending on the door.
  const claim = await claimRun({
    userId: profile.userId,
    email: profile.email,
    orgId: profile.orgId,
  });
  if (!claim.ok) {
    const refusal = billingRefusal({
      ok: false,
      code: "credits_exhausted",
      reason:
        claim.reason === "ledger_refused"
          ? "Billing ledger unavailable — the intervention was not armed and no credit was taken."
          : "Insufficient credits — your plan's allowance is used up. Contact your administrator to top up.",
    });
    return NextResponse.json(
      { ...refusal.body, credits: 0, chargeReason: claim.decision.reason },
      { status: refusal.status, headers: { ...refusal.headers, "Cache-Control": "no-store" } },
    );
  }

  /**
   * Every exit that armed nothing returns the operator's credit — and says so
   * in the body. The Console reads `creditsRemaining` to redraw its wallet
   * (src/views/Console.tsx:352), so a refusal that omitted it would leave the
   * operator staring at a balance one lower than reality. The refund goes back
   * to the SAME wallet the claim came from.
   *
   * On a demo run the refund is a no-op returning null, and the body carries
   * `chargeMode: "demo"` so the client can say "free demo run" rather than
   * rendering a balance that was never touched.
   */
  const refundAnd = async (
    code: FailureCode,
    detail: string,
  ): Promise<NextResponse> => {
    const creditsRemaining = await refundRun({
      userId: profile.userId,
      email: profile.email,
      orgId: profile.orgId,
      decision: claim.decision,
    });
    const f = makeFailure(code, {detail});
    return NextResponse.json(
      { ...f.body, creditsRemaining, chargeMode: claim.decision.mode },
      { status: f.status, headers: { ...f.headers, "Cache-Control": "no-store" } },
    );
  };

  const rl = await consumeRateLimit("console-fire", profile.userId);
  if (!rl.ok) {
    return refundAnd("rate_limited", "Rate limit exceeded; retry later.");
  }

  const body = await parseJson(req);
  if (body === null) return refundAnd("malformed_request", "Invalid JSON body");

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return refundAnd("semantically_invalid", `Invalid signal: ${first?.path.join(".")} ${first?.message ?? ""}`.trim());
  }

  const secret = env.webhookSecret;
  if (!secret) {
    return refundAnd("dependency_unavailable", "WEBHOOK_SECRET not configured — ingest is unarmed (see /api/status).");
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
      "state_conflict",
      `No enrolled customer for ${customerRef} in this workspace. Step 1 of the Console — "Connect your phone" — enrolls one; the platform will not invent a destination. (customer_not_enrolled)`,
    );
  }

  // PDPL: an opt-out is honoured before anything else, and re-enrollment never
  // silently reverses it (that needs the explicit re-consent flag on
  // /api/enroll). The v1 route enforces this too; refusing here means the
  // operator is told why instead of receiving an opaque upstream 409.
  if (enrolled.optedOut) {
    return refundAnd(
      "state_conflict",
      "This customer has opted out of outbound contact. No signal was armed and no credit was spent. (consent_opted_out)",
    );
  }

  // The consent record is a REQUIRED field of the v1 contract, not an
  // optional one. A row without one cannot produce a lawful signal, and
  // inventing an id here would defeat the exact check the gate performs.
  const consentRecordId = enrolled.consentRecordId;
  if (!consentRecordId) {
    return refundAnd(
      "state_conflict",
      "This enrollment carries no consent record, so the platform cannot cite one for outbound contact. Re-enroll with a consent record id. (consent_record_missing)",
    );
  }

  // E.164 is a hard requirement of the v1 schema. Refuse here so the operator
  // gets the reason rather than an upstream 422 they cannot act on.
  if (!/^\+[1-9]\d{7,14}$/.test(enrolled.phone)) {
    return refundAnd(
      "semantically_invalid",
      "The enrolled phone number is not E.164. Re-enroll with a number like +971501234567. (customer_phone_invalid)",
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
      signal: AbortSignal.timeout(env.dialProbeTimeoutMs),
    });
  } catch (err) {
    // Network/timeout before a verdict — the claimed credit is refunded.
    await refundRun({
      userId: profile.userId,
      email: profile.email,
      orgId: profile.orgId,
      decision: claim.decision,
    });
    logError("[console-fire] upstream unreachable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return failure("dependency_unavailable", {
      detail: "Intervention path unreachable — credit refunded, nothing was armed.",
      retryAfterSec: 1,
    });
  }
  const data = (await upstream
    .json()
    .catch(() => ({ error: "unparseable upstream response" }))) as Record<string, unknown>;

  // The credit was claimed before the upstream call; a non-accepted
  // intervention costs the operator nothing — refund it atomically.
  if (upstream.status !== 202) {
    const credits = await refundRun({
      userId: profile.userId,
      email: profile.email,
      orgId: profile.orgId,
      decision: claim.decision,
    });
    return NextResponse.json(
      {
        ...data,
        creditsRemaining: credits,
        chargeMode: claim.decision.mode,
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
      creditsRemaining: claim.remaining,
      chargeMode: claim.decision.mode,
    },
    { status: 202 },
  );
}
