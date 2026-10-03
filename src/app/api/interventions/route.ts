import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { verifyProducerKey } from "@/lib/producer-keys";
import { validateOutboundUrl } from "@/lib/validation/ssrf";

export const dynamic = "force-dynamic";

/**
 * RETIRED — this endpoint no longer arms anything. Use `POST /v1/interventions`.
 *
 * This used to be a SECOND risk-signal ingest alongside the hardened one, and
 * it was the more dangerous of the two. It accepted a signed signal and then:
 *
 *   · placed the carrier call INSIDE the web request, synchronously, with a
 *     single retry and an SMS fallback — no durable queue, so a burst of
 *     signals was bounded only by the request timeout;
 *   · ran NO policy gate — `runPolicyGate` was never called, so consent-record
 *     currency, the destination-country allowlist, the per-destination
 *     cooldown, the org concurrency cap, the org spend ceiling and the credit
 *     reservation were all skipped;
 *   · ran NO abuse gate — `assertDialAllowed` was never called, so geography,
 *     the demo-tier verified-test-number restriction, the velocity breaker and
 *     the concurrency caps were all skipped;
 *   · created NO `Case` row. The dial worker reads its destination from the
 *     case row; with no row there is nothing for any downstream stage to join
 *     on, so the bank was told 202 and no case existed;
 *   · recorded NO credit reservation against the usage ledger — the one
 *     metered thing the platform bills for went unbilled.
 *
 * Any producer that could sign a request with WEBHOOK_SECRET, or hold a
 * `svb_…` producer key, could therefore place carrier calls to any enrolled
 * number at any rate, from any country, with no consent check and no billing.
 * That is a toll-fraud and unauthenticated-billing surface, and it was
 * reachable: `next.config.ts` rewrote the documented public path
 * `/v1/interventions` onto this handler.
 *
 * WHY A REFUSAL AND NOT A REDIRECT: a redirect would keep the ungated billing
 * surface one config edit away and would forward a bank-supplied destination
 * to a route whose contract this body does not satisfy (the v1 schema is
 * strict, requires an E.164 `phone`, integer-minor-unit `amount` and a
 * `consent_record_id`, and rejects unknown fields). Silently reshaping a
 * producer's signal is worse than telling it the endpoint moved.
 *
 * The authentication, rate-limit and callback-SSRF checks are kept so that a
 * caller discovers the move the same way it used to discover a bad request —
 * unauthenticated callers still get 401 rather than a free map of the
 * platform's internals — and so the refusal below is the FIRST thing a
 * correctly authenticated producer sees.
 */

const REPLAY_WINDOW_SEC = 300;

/** Kept solely to preserve the 401/422 behaviour callers already depend on. */
const schema = z.object({
  signal: z.object({
    caseId: z.string().trim().min(3).max(64),
    transactionId: z.string().trim().max(64).optional(),
    riskScore: z.number().min(0).max(1),
    channel: z.enum(["card", "login", "payment", "transfer", "remittance"]).default("card"),
    customer: z.object({
      ref: z.string().trim().min(2).max(64),
      lang: z.enum(["en", "ar", "hi", "ur", "fr", "sw"]).default("en"),
      consentRecordId: z.string().trim().min(4).max(64).optional(),
    }),
    transaction: z
      .object({
        amountAed: z.number().min(0).max(10_000_000).optional(),
        merchant: z.string().trim().max(120).optional(),
      })
      .optional(),
    callbackUrl: z
      .string()
      .url()
      .max(300)
      .refine((v) => v.startsWith("https://"), "callbackUrl must be a public https URL")
      .optional(),
    orgId: z.string().trim().min(2).max(64).optional(),
    notes: z.string().trim().max(600).optional(),
  }),
});

type ParseOutcome =
  | { kind: "ok"; data: z.infer<typeof schema> }
  | { kind: "malformed" }
  | { kind: "invalid"; message: string };

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
  // Required capture group of the regex above (exactly 64 lowercase hex chars), so
  // it cannot actually be undefined here. Asserted rather than branched on.
  const b = Buffer.from(v1!, "hex");
  return a.length === b.length && timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "Digest mismatch" };
}

export async function POST(req: NextRequest) {
  const rl = consumeRateLimit("ingest", rateLimitId(req, "ingest"));
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded; retry later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

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
    const sigHeader =
      req.headers.get("sv-signature") ||
      req.headers.get("SV-Signature") ||
      req.headers.get("x-securevoice-signature");
    const sig = verifySignature(rawBody, sigHeader, process.env.WEBHOOK_SECRET ?? "");
    if (!sig.ok) {
      return NextResponse.json(
        { error: `Signature verification failed: ${sig.reason}` },
        { status: 401 },
      );
    }
  }

  let outcome: ParseOutcome;
  try {
    const parsed = schema.safeParse(JSON.parse(rawBody));
    outcome = parsed.success
      ? { kind: "ok", data: parsed.data }
      : {
          kind: "invalid",
          message:
            `Invalid signal: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message ?? ""}`.trim(),
        };
  } catch {
    outcome = { kind: "malformed" };
  }
  if (outcome.kind === "malformed") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (outcome.kind === "invalid") {
    return NextResponse.json({ error: outcome.message }, { status: 422 });
  }
  // The SSRF verdict ran on this path while it was live; keep it ahead of the
  // refusal so a hostile callback is still reported as such rather than
  // disappearing behind the migration notice.
  if (outcome.data.signal.callbackUrl) {
    const verdict = await validateOutboundUrl(outcome.data.signal.callbackUrl);
    if (!verdict.ok) {
      return NextResponse.json(
        { error: `Invalid signal: signal.callbackUrl ${verdict.reason}` },
        { status: 422 },
      );
    }
  }

  void bearerAuth;
  return NextResponse.json(
    {
      error:
        "POST /api/interventions is retired and arms nothing. Post your risk signal to POST /v1/interventions (or POST /api/v1/interventions) instead.",
      code: "endpoint_retired",
      successor: "/v1/interventions",
      successorSchema: "GET /v1/interventions for the current contract",
      changed: [
        "the policy gate now runs (consent record, country allowlist, cooldown, concurrency, spend ceiling, credit reservation)",
        "the abuse gate now runs (geography, plan tier, velocity breaker, concurrency caps)",
        "money is an INTEGER in minor units and phone must be E.164",
        "consent_record_id is required",
        "an Idempotency-Key header is required",
        "a Case row is created and the dial is enqueued as a durable job instead of an in-request carrier call",
      ],
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

/** Discovery: what producers need to know to integrate. */
export async function GET() {
  return NextResponse.json(
    {
      retired: true,
      error: "POST /api/interventions is retired — it arms nothing.",
      successor: "POST /v1/interventions",
      successorDiscovery: "GET /v1/interventions",
      why: [
        "no policy gate and no abuse gate",
        "no Case row, so no downstream stage could join on the intervention",
        "the carrier call was placed inside the web request rather than on the durable queue",
        "no credit reservation, so the metered work went unbilled",
      ],
      auth: [
        "Authorization: Bearer svb_… (per-org producer key)",
        "SV-Signature: t={unix},v1={hmac_sha256(WEBHOOK_SECRET, '{t}.{rawBody}')}",
      ],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
