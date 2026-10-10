import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator } from "@/lib/credits";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { searchDocuments } from "@/lib/knowledge/documents";
import { badRequest, unprocessable } from "@/lib/api-errors";

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
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  if (!guard.profile.orgId) {
    return NextResponse.json(
      { error: "No organization is linked to this account, so there is no knowledge base." },
      { status: 409 },
    );
  }

  const rl = consumeRateLimit("console-documents-test", guard.profile.userId);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded; retry later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return unprocessable(parsed.error.issues[0]?.message ?? "invalid question");
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
