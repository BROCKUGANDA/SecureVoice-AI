import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { recordSpanAndPersist } from "@/lib/telemetry/store";
import { append as auditAppend } from "@/lib/audit-chain";
import { transcript as redactText } from "@/lib/redact";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { verifyProducerKey } from "@/lib/producer-keys";
import { createHash } from "node:crypto";
import { sanitizeUntrusted, sanitizeDynamicVariables } from "@/lib/sanitize-untrusted";
import { runPolicyGate } from "@/lib/policy-gate";
import { assertDialAllowed, releaseDialSlot } from "@/lib/abuse/guards";
import { validateOutboundUrl } from "@/lib/validation/ssrf";
import { planTierFor } from "@/lib/abuse/tiers";
import { enqueueDialJob } from "@/lib/scale/queue";
import { admitOrDegrade } from "@/lib/admission";
import { makeFailure, type FailureCode, type FailureInit } from "@/lib/failures/envelope";

import { notifyRealtime } from "@/lib/realtime";
import { createCase, transitionCase } from "@/lib/case-state-machine";

/**
 * One error shape for the whole bank-facing surface: `{ code, message,
 * retryable, requestId, docsUrl }`.
 *
 * Previously every refusal here returned a bare `{ error: string }`, which is
 * not the envelope this project already ships and tests (455 chaos checks
 * against `src/lib/failures/**`). A bank integrating against this endpoint got
 * no machine-readable code, no `retryable` flag to branch on, and no
 * correlation id to quote in a support ticket.
 */

function failure(code: FailureCode, init: FailureInit = {}): NextResponse {
  const f = makeFailure(code, init);
  return NextResponse.json(f.body, {
    status: f.status,
    headers: { ...f.headers, "Cache-Control": "no-store" },
  });
}
export const dynamic = "force-dynamic";

/**
 * POST /v1/interventions â€” the canonical bank-facing risk-signal ingest.
 *
 * A bank's fraud engine POSTs a signed risk signal; the platform runs a
 * deterministic policy gate and, if it passes, places an outbound call via
 * the ElevenLabs Agents Platform. The conversation_id returned by the
 * provider is persisted against the case â€” it is the join key for the
 * post-call webhook (WP-4).
 *
 *   Idempotency-Key: <required> â€” replay returns the stored response
 *   SV-Signature: t={unix},v1={hmac_sha256(WEBHOOK_SECRET, "{t}.{rawBody}")}
 *   or: Authorization: Bearer svb_â€¦
 *
 * Strict schema â€” unknown fields rejected, no type coercion. Money is an
 * integer in minor units; phone is E.164; currency is ISO-4217; language is
 * BCP-47.
 *
 * Latency: the idempotency check and the policy gate's consent check run
 * as ONE raw SQL round-trip (the remote DB's ~1.2 s/round-trip dominates
 * the budget). The response is stored fire-and-forget. Total critical
 * path: one DB round-trip + the (dry-run) call placement.
 */

const REPLAY_WINDOW_SEC = 300;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const schema = z
  .object({
    transaction_ref: z.string().trim().min(3).max(64),
    risk_score: z.number().min(0).max(1),
    language: z.string().trim().min(2).max(7),
    phone: z.string().regex(/^\+[1-9]\d{1,14}$/, "phone must be E.164"),
    currency: z.string().regex(/^[A-Z]{3}$/, "currency must be ISO-4217"),
    amount: z.number().int().min(0, "amount must be a non-negative integer in minor units"),
    merchant: z.string().trim().max(120).optional(),
    consent_record_id: z.string().trim().min(4).max(64),
    callback_url: z
      .string()
      .url()
      .max(300)
      // Shape only; the SSRF verdict needs DNS and is applied in the handler.
      .refine((v) => v.startsWith("https://"), "callback_url must be a public https URL")
      .optional(),
    org_id: z.string().trim().min(2).max(64).optional(),
  })
  .strict();

type Signal = z.infer<typeof schema>;

function makeCaseRef(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `SV-F-${s}`;
}

function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string,
): { ok: true } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: "Ingest not configured: set WEBHOOK_SECRET" };
  if (!header) return { ok: false, reason: "Missing SV-Signature header" };
  const m = /^t=(\d{10}),v1=([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return { ok: false, reason: "Malformed SV-Signature" };
  const [, t, v1] = m;
  const age = Math.floor(Date.now() / 1000) - Number(t);
  if (age > REPLAY_WINDOW_SEC) return { ok: false, reason: "Timestamp too old" };
  if (age < -REPLAY_WINDOW_SEC) return { ok: false, reason: "Timestamp in the future" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  // `v1` is a required capture group of the regex above (exactly 64 lowercase hex
  // chars), so it can never actually be undefined here — the match either fails
  // and we returned above, or it carries both captures. The assertion records that
  // invariant for the type checker instead of adding a branch that cannot run.
  const b = Buffer.from(v1!, "hex");
  return a.length === b.length && timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "Digest mismatch" };
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  const callerId = rateLimitId(req, "ingest");

  const rl = consumeRateLimit("ingest", callerId);
  if (!rl.ok) {
    return failure("rate_limited", { retryAfterSec: Math.ceil(rl.retryAfterMs / 1000) });
  }

  const rawBody = await req.text();
  const bearerHeader = req.headers.get("authorization");
  let bearerAuth: { callerId: string; orgId: string | null } | null = null;
  if (bearerHeader?.startsWith("Bearer svb_")) {
    const producer = await verifyProducerKey(bearerHeader.slice("Bearer ".length));
    if (!producer.ok) {
      return failure("unauthenticated", { detail: "producer key is invalid or revoked" });
    }
    bearerAuth = { callerId: producer.callerId, orgId: producer.orgId };
  } else {
    const sigHeader =
      req.headers.get("sv-signature") ||
      req.headers.get("SV-Signature") ||
      req.headers.get("x-securevoice-signature");
    const sig = verifySignature(rawBody, sigHeader, process.env.WEBHOOK_SECRET ?? "");
    if (!sig.ok) {
      return failure("unauthenticated", { detail: `signature rejected: ${sig.reason}` });
    }
  }

  const idemKey = req.headers.get("idempotency-key");
  if (!idemKey || idemKey.trim().length < 8) {
    return failure("malformed_request", {
      detail: "Idempotency-Key header is required, min 8 characters",
    });
  }

  let parsed: ReturnType<typeof schema.safeParse>;
  try {
    parsed = schema.safeParse(JSON.parse(rawBody));
  } catch {
    return failure("malformed_request", { detail: "request body is not valid JSON" });
  }
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return failure("semantically_invalid", {
      detail: `${first?.path.join(".")} ${first?.message ?? ""}`.trim(),
    });
  }
  const signal: Signal = parsed.data;

  // SSRF verdict on the callback URL â€” resolved, not pattern-matched. The
  // removed string check only recognised IP literals and a few suffixes, so a
  // name that resolves into the private network (a cloud metadata endpoint in
  // particular) passed every regex. Runs before the DB round-trip so a
  // hostile callback never becomes a stored value a later step would fetch.
  if (signal.callback_url) {
    const verdict = await validateOutboundUrl(signal.callback_url);
    if (!verdict.ok) {
      return failure("semantically_invalid", {
        detail: `callback_url rejected: ${verdict.reason}`,
      });
    }
  }
  const orgId = bearerAuth?.orgId ?? signal.org_id ?? null;
  const effectiveCallerId = bearerAuth?.callerId ?? callerId;
  const idemHash = hashKey(idemKey.trim());

  // â”€â”€ Combined check: idempotency + consent in ONE DB round-trip â”€â”€
  // The remote DB's ~1.2 s/round-trip dominates the latency budget, so the
  // two reads that used to be sequential are now a single raw query.
  const combined = await db.$queryRaw<
    { idem_response: string | null; consent_opted_out: boolean | null }[]
  >`
    SELECT
      (SELECT response FROM "IdempotencyKey"
       WHERE scope = 'interventions' AND key = ${idemHash} AND "callerId" = ${effectiveCallerId}
       AND "expiresAt" > NOW() AND response != ''
       LIMIT 1) as idem_response,
      (SELECT "optedOut" FROM "Customer"
       WHERE "consentRecordId" = ${signal.consent_record_id}
       LIMIT 1) as consent_opted_out
  `;

  // Replay: the idempotency key already has a stored response.
  if (combined[0]?.idem_response) {
    try {
      const stored = JSON.parse(combined[0].idem_response);
      return NextResponse.json(
        { ...stored.envelope, duplicate: true },
        { status: 202, headers: { "Cache-Control": "no-store", "X-Idempotent-Replay": "true" } },
      );
    } catch {
      // Corrupt stored response â€” fall through to re-execute.
    }
  }

  // Consent: the customer has opted out.
  if (combined[0]?.consent_opted_out === true) {
    const caseRef = makeCaseRef();
    void auditAppend(
      {
        callRef: caseRef,
        action: "freeze",
        intent: "policy_consent_opted_out",
        callerId: effectiveCallerId,
        meta: { reason: "customer has opted out", code: "consent_opted_out" },
        orgId: orgId ?? undefined,
      },
      { fast: true },
    ).catch(() => {});
    // Consent refusal is a POLICY decision, not a fault. 409, never 5xx.
    return failure("policy_precondition", { detail: "consent_opted_out" });
  }

  // â”€â”€ Execute: policy gate + call placement â”€â”€
  try {
    const { envelope, acceptedAt } = await armAndDial(
      signal,
      orgId,
      effectiveCallerId,
      started,
      idemHash,
      idemKey.trim(),
    );
    // Store the response fire-and-forget, deferred until after the response
    // is sent so it never competes with the next signal's combined check for
    // a connection from the pool.
    setImmediate(() => {
      void db.idempotencyKey
        .create({
          data: {
            scope: "interventions",
            key: idemHash,
            callerId: effectiveCallerId,
            response: JSON.stringify({ envelope }),
            statusCode: 202,
            expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
          },
        })
        .catch(() => {});
    });
    // Latency instrumentation (WP-7). Two spans, both measured on real
    // executions of this path â€” never synthesised:
    //   signal received -> accepted            (target 300 ms)
    //   signal accepted -> provider accepted   (target 1.5 s)
    //
    // `started` is stamped when the request arrives and `accepted` when the
    // deterministic gate has passed, so the first span measures intake only and
    // the second measures everything the caller is actually waiting on.
    const spanCaseRef = typeof envelope.caseRef === "string" ? envelope.caseRef : null;
    // `armAndDial` stamps `acceptedAt` the moment the deterministic gate passes
    // and returns it alongside the envelope. It is real elapsed work; a span
    // that faked the boundary would report 0 ms and quietly prove nothing.
    const accepted = acceptedAt > 0 ? acceptedAt : started;
    recordSpanAndPersist({
      span: "signal_received_to_accepted",
      startedAtMs: started,
      endedAtMs: accepted,
      interventionId: spanCaseRef,
      caseRef: spanCaseRef,
    });
    recordSpanAndPersist({
      span: "signal_accepted_to_provider_accepted",
      startedAtMs: accepted,
      endedAtMs: Date.now(),
      interventionId: spanCaseRef,
      caseRef: spanCaseRef,
    });

    return NextResponse.json(envelope, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // A policy or abuse refusal arrives as a TYPED failure: `armAndDial` sets
    // `status` and `code` on it and throws. This catch used to flatten every
    // one of those into `upstreamError(...)`, which defaults to **503** â€” so a
    // bank whose signal was correctly refused for consent, geography or quota
    // received "Service Unavailable". That reads as "our fault, retry later",
    // and a bank that retries an invitation refusal re-dials a customer it
    // was told not to contact. A refusal is not an outage and must not wear
    // an outage's status code.
    const typed = err as { status?: unknown; code?: unknown; message?: unknown };
    if (typeof typed.status === "number" && typeof typed.code === "string") {
      const status = typed.status;
      const detail = typeof typed.message === "string" ? typed.message : typed.code;
      return failure(
        status >= 400 && status < 500 ? "policy_precondition" : "dependency_unavailable",
        {
          detail: `${typed.code}: ${detail}`,
        },
      );
    }
    console.error("[v1/interventions] arming failed:", err instanceof Error ? err.message : err);
    return failure("dependency_unavailable", { detail: "case recording failed" });
  }
}

/**
 * What `armAndDial` hands back: the wire envelope, plus the internal gate
 * timestamp used for latency spans.
 *
 * `acceptedAt` is deliberately NOT a property of `envelope` - it must never be
 * serialised into the 202 a bank receives, nor into the stored idempotent replay
 * response. Keeping it on a sibling key makes that structural instead of a
 * matter of remembering to strip it.
 */
type ArmResult = {
  envelope: {
    ok: boolean;
    caseRef: string;
    transactionRef: string;
    status: string;
    receivedAt: string;
    [k: string]: unknown;
  };
  /** Epoch ms at which the deterministic gate passed. 0 when never stamped. */
  acceptedAt: number;
};

async function armAndDial(
  signal: Signal,
  orgId: string | null,
  effectiveCallerId: string,
  started: number,
  idemHash: string,
  idemKey: string,
): Promise<ArmResult> {
  const caseRef = makeCaseRef();
  let dialSlot: number | null = null;
  // Stamped the moment the deterministic gate passes, so the provider span
  // measures what the caller actually waits on rather than collapsing to 0.
  let acceptedAt = 0;

  // Policy gate â€” deterministic, fail-fast, audited either way.
  const gate = await runPolicyGate({
    orgId,
    phone: signal.phone,
    consentRecordId: signal.consent_record_id,
    caseRef,
    callerId: effectiveCallerId,
  });
  if (!gate.ok) {
    void auditAppend(
      {
        callRef: caseRef,
        action: "freeze",
        intent: `policy_rejected_${gate.code}`,
        callerId: effectiveCallerId,
        meta: { reason: gate.reason, code: gate.code, transactionRef: signal.transaction_ref },
        orgId: orgId ?? undefined,
      },
      { fast: true },
    ).catch(() => {});
    const err = new Error(gate.reason) as Error & { status: number; code: string };
    err.status = 409;
    err.code = gate.code;
    throw err;
  }

  // Abuse gate (WP-14): geography, demo-tier test-number restriction,
  // per-destination cooldown, per-org and global concurrency caps, and the
  // velocity breaker â€” evaluated in ONE typed decision before any carrier call.
  // Runs after the consent/policy gate because consent is the legal
  // precondition and this is the cost-and-abuse precondition. A refusal is a
  // typed 409, audited, never a 500 â€” the same discipline as the policy gate.
  // An org-less signal shares one conservative bucket rather than bypassing the
  // gate: country, tier, cooldown and the global cap still apply.
  //
  // The tier MUST be resolved for the org, not left to the guard's `demo`
  // default. `assertDialAllowed` defaults an unset `planTier` to the strictest
  // tier so it fails closed â€” correct for the guard, but a route that never
  // passes one therefore evaluated every live bank signal as a DEMO tenant and
  // refused it with `demo_tier_requires_test_number`. That refuses legitimate
  // production dials. `planTierFor` resolves the org's real tier and still
  // lands on `demo` when nothing declares one, so the fail-closed default is
  // unchanged for an unconfigured deployment.
  const abuseOrg = orgId ?? "unscoped";
  const abuse = assertDialAllowed({
    orgId: abuseOrg,
    e164: signal.phone,
    planTier: planTierFor(abuseOrg),
  });
  if (!abuse.allowed) {
    void auditAppend(
      {
        callRef: caseRef,
        action: "freeze",
        intent: `abuse_rejected_${abuse.reason}`,
        callerId: effectiveCallerId,
        meta: {
          reason: abuse.reason,
          detail: abuse.detail,
          country: abuse.country,
          controls: abuse.controls.map((c) => ({ control: c.control, ok: c.ok, reason: c.reason })),
          transactionRef: signal.transaction_ref,
        },
        orgId: orgId ?? undefined,
      },
      { fast: true },
    ).catch(() => {});
    const err = new Error(abuse.detail) as Error & { status: number; code: string };
    err.status = 409;
    err.code = abuse.reason;
    throw err;
  }
  dialSlot = abuse.slot;
  acceptedAt = Date.now();

  // Persist the case BEFORE the dial job is enqueued.
  //
  // The case row is what every downstream stage joins on: the dial worker
  // looks the case up by caseRef to read the destination and the dynamic
  // variables (without it the worker has no phone and the job is dead-lettered
  // as "case has no phone number"), and the post-call webhook and the bank
  // outbox correlate on the same row. Minting a caseRef and never writing the
  // row means no call is ever placed.
  //
  // The gates above have passed, so this is RECEIVED -> SCREENED through the
  // single writer. The dial worker then owns SCREENED -> DIALING.
  const merchant = signal.merchant ? sanitizeUntrusted(signal.merchant) : undefined;
  await createCase({
    caseRef,
    orgId,
    transactionRef: signal.transaction_ref,
    riskScore: signal.risk_score,
    language: signal.language,
    phone: signal.phone,
    merchant,
    amountMinor: signal.amount,
    currency: signal.currency,
    consentRecordId: signal.consent_record_id,
  });
  await transitionCase(caseRef, "SCREENED");

  // Audit: signal received + policy passed (single append, fire-and-forget).
  void auditAppend(
    {
      callRef: caseRef,
      action: "freeze",
      intent: "signal_received",
      callerId: effectiveCallerId,
      redactedText: redactText(
        `${signal.transaction_ref} Â· ${signal.phone.replace(/\d(?=\d{4})/g, "*")} Â· ${signal.risk_score}`,
      ),
      meta: {
        transactionRef: signal.transaction_ref,
        riskScore: signal.risk_score,
        language: signal.language,
        currency: signal.currency,
        amountMinor: signal.amount,
        policy: "passed",
        orgId: orgId ?? undefined,
        latencyMs: Date.now() - started,
      },
      orgId: orgId ?? undefined,
    },
    { fast: true },
  ).catch(() => {});

  // Admission control â€” capacity is a policy decision, and it is audited like
  // one. Runs AFTER the policy gate (a case we must not call should never
  // consume a voice slot) and BEFORE the dial. A shed case still gets an
  // outcome: it falls back to SMS/app push and the decision is in the chain.
  const admission = await admitOrDegrade({
    callRef: caseRef,
    orgId,
    callerId: effectiveCallerId,
    riskScore: signal.risk_score,
    amountMinor: signal.amount ?? 0,
  });
  if (!admission.admitted) {
    const fallback = admission.fallback ?? "sms";
    void auditAppend(
      {
        callRef: caseRef,
        action: "handoff",
        intent: "degraded_to_async",
        callerId: effectiveCallerId,
        redactedText: `capacity ${admission.band}; fallback=${fallback}`,
        meta: {
          band: admission.band,
          reason: admission.reason,
          fallback,
          expectedLoss: admission.expectedLoss,
          activeConversations: admission.activeConversations,
        },
        orgId: orgId ?? undefined,
      },
      { fast: true },
    ).catch(() => {});
    const envelope = {
      ok: true,
      caseRef,
      transactionRef: signal.transaction_ref,
      status: "degraded_to_async",
      degraded: {
        band: admission.band,
        reason: admission.reason,
        fallback,
        expectedLoss: admission.expectedLoss,
      },
      receivedAt: new Date().toISOString(),
    };
    // Same internal-only telemetry hand-off as the queued path below.
    return { envelope, acceptedAt };
  }

  // Sanitise every bank-supplied string before it becomes a dynamic variable.
  const dynamicVariables = sanitizeDynamicVariables({
    merchant: merchant ?? "",
    amount: signal.amount,
    currency: signal.currency,
    case_id: caseRef,
    transaction_ref: signal.transaction_ref,
  });

  // Durable queue (S-1). The request handler ENQUEUES and returns; the call is
  // placed by a worker that claims the job. Placing it inline would make the
  // bank's fraud engine the rate limiter of our telephony account, leave a
  // carrier call holding a web request, and give a campaign burst nowhere to
  // go but a rate-limit response.
  //
  // The reservation taken above is released immediately: the worker takes its
  // own slot at placement time, when the call actually happens.
  releaseDialSlot(dialSlot);

  let delivery: Record<string, unknown>;
  try {
    const job = await enqueueDialJob({
      caseId: caseRef,
      caseRef,
      orgId,
      attemptNo: 1,
      // Expected-loss triage: a higher-value alert is dialled first when the
      // queue is draining faster than the provider allows.
      priority: Math.round(
        ((Number.isFinite(signal.risk_score) ? Math.min(Math.max(signal.risk_score, 0), 1) : 0) *
          (signal.amount ?? 0)) /
          100,
      ),
      // Sanitised dial inputs only â€” never transcript content (invariant I-10).
      payload: {
        to: redactText(signal.phone),
        language: signal.language,
        merchant: merchant ?? "",
        amount: signal.amount ?? 0,
        currency: signal.currency ?? "",
        transaction_ref: signal.transaction_ref,
      },
    });
    delivery = {
      channel: "queued",
      provider: "elevenlabs",
      to: redactText(signal.phone),
      jobId: job.id,
      jobState: job.state,
      duplicate: !job.created,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void auditAppend(
      {
        callRef: caseRef,
        action: "handoff",
        intent: "enqueue_failed",
        callerId: effectiveCallerId,
        meta: { error: msg.slice(0, 200) },
        orgId: orgId ?? undefined,
      },
      { fast: true },
    ).catch(() => {});
    throw err;
  }

  // Persist the conversation_id against the case â€” the join key for WP-4.
  void auditAppend(
    {
      callRef: caseRef,
      action: "handoff",
      intent: "delivery_call",
      callerId: effectiveCallerId,
      redactedText: redactText(signal.phone),
      meta: { delivery, conversationId: delivery.conversationId, latencyMs: Date.now() - started },
      orgId: orgId ?? undefined,
    },
    { fast: true },
  ).catch(() => {});

  // Emit case.queued on the realtime channel. The state is QUEUED, not DIALING â€”
  // the call has not been placed yet, and a console that claims otherwise is
  // lying to the operator watching it.
  notifyRealtime({
    orgId: orgId ?? undefined,
    callRef: caseRef,
    payload: {
      type: "case.queued",
      caseRef,
      state: "QUEUED",
      jobId: delivery.jobId,
      language: signal.language,
      riskScore: signal.risk_score,
      ts: new Date().toISOString(),
    },
  });

  const envelope = {
    ok: true,
    caseRef,
    transactionRef: signal.transaction_ref,
    status: "queued",
    jobId: delivery.jobId,
    language: signal.language,
    riskScore: signal.risk_score,
    delivery,
    receivedAt: new Date().toISOString(),
  };
  // `acceptedAt` is INTERNAL telemetry plumbing, deliberately NOT part of the wire
  // envelope. It is returned alongside so the POST handler can measure a real
  // gate boundary, and so it is never serialised into the 202 a bank receives
  // nor into the stored idempotent replay response.
  return { envelope, acceptedAt };
}

/** Discovery: what producers need to know to integrate. */
export async function GET() {
  return NextResponse.json(
    {
      endpoint: "POST /v1/interventions",
      auth: [
        "Authorization: Bearer svb_â€¦ (per-org producer key)",
        "SV-Signature: t={unix},v1={hmac_sha256(WEBHOOK_SECRET, '{t}.{rawBody}')}",
      ],
      idempotencyKey: "required â€” replay returns the stored response, creates nothing",
      schema: {
        transaction_ref: "string (3-64) â€” your transaction reference",
        risk_score: "number 0-1",
        language: "BCP-47 (en, ar, hi)",
        phone: "E.164 (+9715â€¦)",
        currency: "ISO-4217 (AED, USD, â€¦)",
        amount: "integer minor units (fils/cents)",
        merchant: "string? â€” sanitised before it becomes a dynamic variable",
        consent_record_id: "string (4-64) â€” required for outbound contact",
        callback_url: "https URL? â€” post-call outcome delivery",
      },
      response: "202 Accepted â€” { caseRef, conversationId, status: 'dialing' }",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
