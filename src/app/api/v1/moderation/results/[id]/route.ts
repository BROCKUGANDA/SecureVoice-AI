import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyProducerKey } from "@/lib/producer-keys";
import { consume as consumeRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { gatewayFailure, gatewayJson } from "@/lib/gateway";
import { env } from "@/lib/config";
import { createHmac, timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";

/**
 * GET /v1/moderation/results/{id} — poll a moderation decision.
 *
 * Returns the evidence row POST /v1/moderation/check created. TENANCY: a
 * producer key resolves the tenant, and a row from another tenant returns the
 * SAME 404 as a row that does not exist, so the endpoint cannot be used to
 * learn which moderation ids exist elsewhere. Platform-internal callers
 * (CONSOLE_INGEST_SECRET signature) may read any row — the same privilege
 * split as the check route.
 *
 * The `sample` field is the redacted, truncated content prefix that was
 * stored at decision time — never the full classified text.
 */

const REPLAY_WINDOW_SEC = 300;

function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string,
): { ok: true } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: "not configured" };
  if (!header) return { ok: false, reason: "missing" };
  const m = /^t=(\d{10}),v1=([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return { ok: false, reason: "malformed" };
  const [, t, v1] = m;
  const age = Math.floor(Date.now() / 1000) - Number(t);
  if (age > REPLAY_WINDOW_SEC || age < -REPLAY_WINDOW_SEC) return { ok: false, reason: "stale" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1 as string, "hex");
  return a.length === b.length && timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "digest mismatch" };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-z0-9]{20,40}$/i.test(id)) {
    // Same code as "not found": a malformed id is not a different answer.
    return gatewayFailure("not_found", req);
  }

  const bearer = req.headers.get("authorization");
  let orgId: string | null | undefined; // undefined = platform-internal
  if (bearer?.startsWith("Bearer svb_")) {
    const auth = await verifyProducerKey(bearer.slice("Bearer ".length));
    if (!auth.ok) {
      return gatewayFailure("unauthenticated", req, {
        detail: "producer key is invalid or revoked",
      });
    }
    orgId = auth.orgId;
  } else {
    const sigHeader =
      req.headers.get("sv-signature") ||
      req.headers.get("SV-Signature") ||
      req.headers.get("x-securevoice-signature");
    const internal = verifySignature("", sigHeader, env.consoleIngestSecret ?? "");
    if (!internal.ok) {
      return gatewayFailure("unauthenticated", req, {
        detail: "request must carry a producer key or a valid SV-Signature",
      });
    }
    orgId = undefined;
  }

  // Per-key budget, so a polling loop cannot become the rate limiter of our
  // database. Generous: polling every 10s for a day is 8,640 requests.
  const rl = await consumeRateLimit(
    "pull",
    bearer?.slice("Bearer ".length).slice(0, 24) ?? "console",
    1,
    10_000,
  );
  if (!rl.ok)
    return gatewayFailure("rate_limited", req, {
      retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
      headers: rateLimitHeaders(rl),
    });

  const row = await db.moderationRequest.findFirst({
    where: {
      id,
      // Producer-key callers are pinned to their tenant; a platform-internal
      // signature (orgId === undefined) reads without the predicate. A row
      // with no tenant is platform business either way.
      ...(orgId ? { orgId } : {}),
    },
  });
  if (!row) return gatewayFailure("not_found", req);

  return gatewayJson(
    {
      id: row.id,
      stage: row.stage,
      verdict: row.verdict,
      categories: row.categories,
      source: row.source,
      refused: row.refused,
      model: row.model,
      template_version: row.templateVersion,
      case_ref: row.caseRef,
      latency_ms: row.latencyMs,
      created_at: row.createdAt.toISOString(),
    },
    req,
  );
}
