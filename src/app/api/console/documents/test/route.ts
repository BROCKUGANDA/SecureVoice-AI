import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator } from "@/lib/credits";
import { consume as consumeRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { searchDocuments } from "@/lib/knowledge/documents";
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
 * "Ask the knowledge base" — the org-scoped test search.
 *
 *   POST /api/console/documents/test  { question } → scored chunks
 *
 * This exists so an operator can prove the upload worked WITHOUT waiting for a
 * live call to hit a wrong answer. It is the only way to see a score and the
 * exact chunk that would have been retrieved, which is the difference between
 * "the RAG is configured" and "the RAG returns this passage".
 *
 * `orgId` is the session's active organization and is passed to a search that
 * requires it — never accepted from the body. Rate-limited because every call is
 * an embedding round-trip against a metered provider.
 */
const schema = z.object({ question: z.string().trim().min(3).max(500) });

export async function POST(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return failure(guard.status === 401 ? "unauthenticated" : "not_found", { detail: guard.error });
  }
  if (!guard.profile.orgId) {
    return failure("state_conflict", {
      detail: "No organization is linked to this account, so there is no knowledge base.",
    });
  }

  const rl = await consumeRateLimit("console-documents-test", guard.profile.userId);
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

  const res = await searchDocuments(guard.profile.orgId, parsed.data.question);
  if (!res.ok) {
    // A missing index is a CONFIGURATION state, not a bad request: the console
    // renders it as "documents cannot be searched yet", not as an error toast.
    return NextResponse.json({ error: res.error ?? "search failed", matches: [] }, { status: 200 });
  }

  return NextResponse.json(
    { ok: true, matches: res.matches },
    { headers: { "Cache-Control": "no-store" } },
  );
}
