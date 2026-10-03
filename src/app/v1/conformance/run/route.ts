import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { verifyProducerKey } from "@/lib/producer-keys";
import { safeFetch, validateOutboundUrl } from "@/lib/validation/ssrf";
import { makeFailure } from "@/lib/failures/envelope";
import {
  handleConformanceRun,
  MAX_BUDGET_MS,
  MIN_BUDGET_MS,
  type ConformanceTransport,
  type TransportRequest,
  type TransportResponse,
} from "@/lib/contracts/conformance";

export const dynamic = "force-dynamic";

/**
 * POST /v1/conformance/run — the self-serve checker (WP-17).
 *
 * A bank's receiver is customer code. "Our receiver verifies the signature" is a
 * claim the vendor cannot check by shipping a fix, so this endpoint makes it
 * checkable: five signed probes are POSTed to a receiver the bank nominates and
 * the answers are graded into a scored report the bank can attach to their
 * change record.
 *
 * ── The security posture, and why it is this shape ─────────────────────────
 *
 *   · **Producer key required.** An unauthenticated caller must not be able to
 *     make our deployment POST to a URL of their choosing. The HMAC secret is not
 *     accepted here: the secret in this request is the *bank's own* receiver
 *     secret, which we never had, so accepting the shared ingest secret here
 *     would authenticate the wrong thing.
 *   · **SSRF verdict before any socket.** `validateOutboundUrl` (https only,
 *     port 443, no credentials, every resolved address public) runs inside
 *     `handleConformanceRun` before the transport is touched. A blocked target
 *     returns 422 and issues zero probes.
 *   · **`safeFetch`, not `fetch`.** Redirects are followed manually with
 *     `redirect: "manual"` and every hop is re-validated, so a receiver that
 *     302s to `http://169.254.169.254/` never gets dialled. A validated URL that
 *     redirects somewhere else was never validated.
 *   · **Rate limited.** Each run is five outbound posts to a customer-controlled
 *     URL, so the budget is small and `Retry-After` is returned.
 *   · **The secret is never persisted and never reported.** It is used to sign
 *     the probes and appears in no log line, no report field and no error message.
 *
 * ── Status semantics ────────────────────────────────────────────────────────
 *
 * 200 means THE RUN COMPLETED. It does not mean the receiver passed: read
 * `score.verdict`. A failing grade is a successful run, which is what makes the
 * report safe to attach to a change record.
 */

const CONFORMANCE_BUDGET_PER_HOUR = 12;
const PROBE_TIMEOUT_MS = 5_000;

function json(body: unknown, status: number, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

/**
 * A refusal, rendered in the SAME envelope the canonical ingest returns.
 *
 * `makeFailure` derives the status from `STATUS_DISCIPLINE`, so a code can never
 * be paired with the wrong status, and it emits `x-request-id` plus `Retry-After`
 * where the discipline requires it. The conformance endpoint deliberately shares
 * the ingest's error vocabulary (`malformed_request`, `unauthenticated`,
 * `semantically_invalid`, `rate_limited`) instead of minting a `conformance_*`
 * namespace — a producer's retry logic must not have to care which endpoint it
 * is talking to.
 */
function refuse(
  code: Parameters<typeof makeFailure>[0],
  detail: string,
  retryAfterSec?: number,
): NextResponse {
  const failure = makeFailure(code, {
    detail,
    ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
  });
  return json(failure.body, failure.status, failure.headers);
}

/** Header bag as a plain lowercase-keyed record, which is what the transport contract uses. */
function headersToRecord(headers: Headers): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * The real transport. Measured here rather than in the checker so a fake
 * transport can assert a latency without sleeping: the checker grades whatever
 * number the transport returns.
 */
const realTransport: ConformanceTransport = async (
  request: TransportRequest,
): Promise<TransportResponse> => {
  const startedAt = Date.now();
  const response = await safeFetch(request.url, {
    method: request.method,
    headers: request.headers as Record<string, string>,
    body: request.body,
  });
  const body = await response.text();
  return {
    status: response.status,
    headers: headersToRecord(response.headers),
    body,
    latencyMs: Date.now() - startedAt,
  };
};

export async function POST(req: NextRequest) {
  const authorization = req.headers.get("authorization");

  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    return refuse("malformed_request", "request body must be a JSON object");
  }

  const outcome = await handleConformanceRun(
    {
      receiver_url: payload.receiver_url,
      secret: payload.secret,
      budget_ms: typeof payload.budget_ms === "number" ? payload.budget_ms : undefined,
      org_id: payload.org_id,
    },
    {
      transport: realTransport,
      validateUrl: (raw) => validateOutboundUrl(raw),
      authenticate: async () => {
        const token = authorization?.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : null;
        const auth = await verifyProducerKey(token);
        return auth.ok
          ? { ok: true as const, callerId: auth.callerId, orgId: auth.orgId }
          : { ok: false as const, reason: "missing, unknown or revoked producer key" };
      },
      rateLimit: (callerId) => {
        const result = consumeRateLimit(
          "conformance",
          // The authenticated caller id, not the request IP: a bank runs this
          // from shared egress behind NAT, so an IP-keyed budget would hand one
          // team member's runs to another's.
          callerId,
          1,
          CONFORMANCE_BUDGET_PER_HOUR,
        );
        return result.ok
          ? { ok: true as const }
          : {
              ok: false as const,
              retryAfterSec: Math.max(1, Math.ceil(result.retryAfterMs / 1000)),
            };
      },
    },
  );

  if (outcome.kind === "refused") {
    return refuse(outcome.refusal.code, outcome.refusal.detail, outcome.refusal.retryAfterSec);
  }

  const report = outcome.report;
  return json(
    {
      ...report,
      notes: [
        ...report.notes,
        `Probe timeout ${PROBE_TIMEOUT_MS}ms per hop; latencies are wall-clock at our edge, so a slow answer may be a slow network rather than a slow handler.`,
        `Budget clamped to ${MIN_BUDGET_MS}–${MAX_BUDGET_MS}ms. This grades YOUR receiver; it is not a SecureVoice SLA and must not be cited as one.`,
      ],
    },
    200,
  );
}

/** Cheap liveness for the checker itself, without firing a probe. */
export async function GET() {
  return json(
    {
      endpoint: "POST /v1/conformance/run",
      auth: [
        "Authorization: Bearer svb_… (org-scoped producer key; the shared HMAC secret is NOT accepted)",
      ],
      body: {
        receiver_url:
          "https URL of your receiver — SSRF-validated (https, port 443, public addresses only)",
        secret: "the signing secret YOUR receiver verifies with; never stored, never returned",
        budget_ms: `optional ${MIN_BUDGET_MS}–${MAX_BUDGET_MS}ms latency budget for the fast_2xx check`,
        org_id: "optional; echoed as org_id on every probe",
      },
      checks: [
        "signature_verified",
        "idempotency_honoured",
        "fast_2xx",
        "replay_handled",
        "rejects_malformed",
      ],
      semantics:
        "200 means the run completed. Read score.verdict: a failing grade is a successful run. A blocked target returns 422 with zero probes issued.",
      rateLimit: { perHour: CONFORMANCE_BUDGET_PER_HOUR, retryAfter: true },
      contract: "GET /openapi, GET /asyncapi, docs/INTEGRATION-CONTRACT.md",
    },
    200,
  );
}
