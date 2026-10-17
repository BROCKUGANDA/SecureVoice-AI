import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator } from "@/lib/credits";
import { consume as consumeRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { searchTranscripts } from "@/lib/knowledge/transcript-embeddings";
import { makeFailure, type FailureCode, type FailureInit } from "@/lib/failures/envelope";

function failure(code: FailureCode, init: FailureInit = {}): NextResponse {
  const f = makeFailure(code, init);
  return NextResponse.json(f.body, {
    status: f.status,
    headers: { ...f.headers, "Cache-Control": "no-store" },
  });
}

export const dynamic = "force-dynamic";

/**
 * "Ask the call transcripts" — org-scoped semantic search over embedded
 * post-call transcripts stored in pgvector.
 *
 *   POST /api/console/search/transcripts  { question } → scored transcript chunks
 *
 * This is the retrieval consumer for the pgvector transcript RAG plane. It lets
 * an operator prove ingestion worked without waiting for a live call: search the
 * transcripts this tenant has embedded and see the exact chunk, score and caseRef
 * that would be returned.
 *
 * `orgId` is the session's active organization and is passed to the search —
 * never accepted from the body. Rate-limited because every call is an embedding
 * round-trip against OpenAI (a metered provider).
 *
 * Gated behind `transcriptEmbeddingsConfigured()` (OPENAI_API_KEY): if the
 * operator hasn't opted in, the plane is unavailable and we say so explicitly
 * instead of failing open.
 */
const schema = z.object({ question: z.string().trim().min(3).max(500) });

export async function POST(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return failure(guard.status === 401 ? "unauthenticated" : "not_found", { detail: guard.error });
  }
  if (!guard.profile.orgId) {
    return failure("state_conflict", {
      detail: "No organization is linked to this account, so there are no transcripts to search.",
    });
  }

  const rl = await consumeRateLimit("console-transcripts-search", guard.profile.userId);
  if (!rl.ok) {
    return failure("rate_limited", {
      retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
      headers: rateLimitHeaders(rl),
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return failure("malformed_request", { detail: "Invalid JSON body" });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return failure("semantically_invalid", {
      detail: parsed.error.issues[0]?.message ?? "invalid question",
    });
  }

  const res = await searchTranscripts(guard.profile.orgId, parsed.data.question);
  if (!res.ok) {
    // A missing configuration is a CONFIGURATION state, not a bad request: the
    // console renders it as "transcript search not configured", not an error toast.
    return NextResponse.json({ error: res.error ?? "search failed", matches: [] }, { status: 200 });
  }

  return NextResponse.json(
    { ok: true, matches: res.matches },
    { headers: { "Cache-Control": "no-store" } },
  );
}
