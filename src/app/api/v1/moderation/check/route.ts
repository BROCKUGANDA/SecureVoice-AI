import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import { verifyProducerKey } from "@/lib/producer-keys";
import { consume as consumeRateLimit, rateLimitHeaders, rateLimitId } from "@/lib/ratelimit";
import {
  makeFailure,
  type Failure,
  type FailureCode,
  type FailureInit,
} from "@/lib/failures/envelope";
import { env } from "@/lib/config";
import { moderateContent } from "@/lib/qwen3guard/moderate";
import { MODERATION_STAGES } from "@/lib/qwen3guard/template";

export const dynamic = "force-dynamic";

/**
 * POST /v1/moderation/check — the bank-facing moderation contract.
 *
 * A producer (or the platform console) submits content for classification at
 * a declared lifecycle boundary; the platform runs Qwen3Guard-Gen and returns
 * the verdict. The result row is persisted as evidence and retrievable from
 * GET /v1/moderation/results/{id}.
 *
 *   Authorization: Bearer svb_…           (a producer key; the key names the tenant)
 *   or SV-Signature: t={unix},v1={hmac}   (shared-secret ingest; no tenant)
 *
 * THE SECURITY CONTRACT, restated where integrators will read it: a `safe`
 * verdict from this endpoint authorises nothing by itself. It is a classifier
 * opinion at one lifecycle stage. Tool authorization, consent, credits and
 * the deterministic compliance gates are separate, independent mechanisms.
 * A `source` other than "model" (degraded / kill_switch / flag_off) is
 * returned verbatim and is NEVER reported as safe — integrators must branch
 * on `source`, not only on `verdict`.
 *
 * Size limits, rate limiting and the strict schema follow the /v1
 * conventions (see /v1/interventions).
 */

function respond(f: Failure): NextResponse {
  return NextResponse.json(f.body, {
    status: f.status,
    headers: { ...f.headers, "Cache-Control": "no-store" },
  });
}

function failure(code: FailureCode, init: FailureInit = {}): NextResponse {
  return respond(makeFailure(code, init));
}

const schema = z
  .object({
    text: z.string().min(1).max(6_000),
    stage: z.enum(MODERATION_STAGES),
    case_ref: z.string().min(3).max(64).optional(),
    conversation_id: z.string().min(3).max(128).optional(),
    language: z.string().trim().min(2).max(7).optional(),
    org_id: z.string().min(1).max(64).optional(),
  })
  .strict();

const REPLAY_WINDOW_SEC = 300;

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
  const b = Buffer.from(v1 as string, "hex");
  return a.length === b.length && timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "Digest mismatch" };
}

export async function POST(req: NextRequest) {
  const callerId = rateLimitId(req, "ingest");

  const rl = await consumeRateLimit("ingest", callerId);
  if (!rl.ok) {
    return failure("rate_limited", {
      retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
      headers: rateLimitHeaders(rl),
    });
  }

  const rawBody = await req.text();
  if (rawBody.length > 32_768) {
    return failure("payload_too_large", { detail: "request body exceeds 32 KiB" });
  }

  const bearerHeader = req.headers.get("authorization");
  let orgId: string | null = null;
  if (bearerHeader?.startsWith("Bearer svb_")) {
    const producer = await verifyProducerKey(bearerHeader.slice("Bearer ".length));
    if (!producer.ok) {
      return failure("unauthenticated", { detail: "producer key is invalid or revoked" });
    }
    orgId = producer.orgId;
  } else {
    const sigHeader =
      req.headers.get("sv-signature") ||
      req.headers.get("SV-Signature") ||
      req.headers.get("x-securevoice-signature");
    // Platform-internal signature may name a tenant; the shared producer
    // secret may not. Same rule as /v1/interventions, verbatim.
    const internal = verifySignature(rawBody, sigHeader, env.consoleIngestSecret ?? "");
    if (!internal.ok) {
      const shared = verifySignature(rawBody, sigHeader, env.webhookSecret ?? "");
      if (!shared.ok) {
        return failure("unauthenticated", {
          detail: "request must carry a producer key or a valid SV-Signature",
        });
      }
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return failure("malformed_request", { detail: "Invalid JSON body" });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return failure("semantically_invalid", {
      detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
  }

  // A signed producer may not name another tenant: org_id in the body is only
  // honoured for the platform-internal credential, which by construction does
  // not arrive via a producer key. Producer-key callers always act as their
  // own tenant.
  const effectiveOrgId = orgId ?? null;

  const started = Date.now();
  const outcome = await moderateContent({
    stage: parsed.data.stage,
    text: parsed.data.text,
    orgId: effectiveOrgId,
    caseRef: parsed.data.case_ref ?? null,
    conversationId: parsed.data.conversation_id ?? null,
    persist: "await",
  });

  return NextResponse.json(
    {
      ok: true,
      id: outcome.id ?? null,
      verdict: outcome.verdict,
      categories: outcome.categories,
      refusal: outcome.refusal,
      source: outcome.source,
      stage: outcome.stage,
      model: outcome.model,
      template_version: outcome.templateVersion,
      latency_ms: Date.now() - started,
      reason: outcome.reason ?? null,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
