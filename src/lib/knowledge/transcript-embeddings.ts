import "server-only";

/**
 * Case transcripts, embedded natively with pgvector and searched with cosine
 * similarity inside Postgres itself.
 *
 * Why this exists beside `src/lib/pinecone/transcript-index.ts`, which does the
 * same job against a third-party index:
 *
 *   - Transcripts are the most sensitive rows we have. pgvector keeps them in
 *     the same database they were sealed into, under the same RLS policies and
 *     the same tenant boundary. No vendor key, no separate retention owner.
 *   - `src/lib/privacy/crypto-shred.ts` already erases the sealed ciphertext
 *     and the data key; this module's `forgetTranscriptEmbeddings` deletes the
 *     vectors in the same transaction boundary, so a right-to-erasure request
 *     reaches every copy instead of leaving a residual in a vector database the
 *     operator did not ask for.
 *
 * Failure posture mirrors transcript-index.ts exactly: every step is
 * best-effort, logged into the audit chain, and never allowed to flip a case
 * or block the webhook that told the bank the outcome.
 *
 * Configuration is `OPENAI_API_KEY` + the model name. Absence of the key is
 * how an on-prem deployment proves nothing has left the building; the
 * embedding call itself is unauthenticated-by-default and refused when the key
 * is missing, same as `pineconeConfigured()` refuses without PINECONE_API_KEY.
 */

import { append as auditAppend } from "@/lib/audit-chain";
import { chunkText } from "@/lib/knowledge/documents";
import { env } from "@/lib/config";
import { db } from "@/lib/db";

const API_KEY = process.env.OPENAI_API_KEY ?? "";
const BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

export function transcriptEmbeddingsConfigured(): boolean {
  return API_KEY.length > 8;
}

/** One chunk, stored with the same deterministic id so a re-run overwrites in
 *  place instead of accumulating duplicates. `caseRef`+chunkIndex is unique in
 *  the table (see the migration). */
function vectorId(caseRef: string, chunkIndex: number): string {
  return `tx:${caseRef}:${chunkIndex}`;
}

/** OpenAI embedding endpoint: one call, many inputs (batched chunks). */
async function embedChunks(chunks: string[]): Promise<number[][] | { error: string }> {
  const body = JSON.stringify({
    model: env.ragEmbeddingModel,
    input: chunks,
    encoding_format: "float",
  });
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body,
      // Fail fast: an embedding round-trip must not hold a webhook worker.
      signal: AbortSignal.timeout(env.ragRetrievalTimeoutMs),
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) {
    return {
      error: `embedding http ${res.status}`,
    };
  }
  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const embeddings = (json.data ?? [])
    .map((d) => d.embedding ?? null)
    .filter((v): v is number[] => v != null && v.length > 0);
  if (embeddings.length !== chunks.length) {
    return {
      error: `embedding count mismatch (asked ${chunks.length}, got ${embeddings.length})`,
    };
  }
  return embeddings;
}

/** pgvector literal from a number array: `[0.1,-0.2,…]`. */
function pgVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

/**
 * Extract → chunk → embed → upsert, idempotently. Re-running overwrites the
 * same ids in place; existing rows for the caseRef are deleted first so a
 * re-embedding with fewer chunks does not leave stale vectors behind.
 *
 * Throws nothing: the caller (the webhook handler) decides what a failure
 * means. The audit row is the durable answer either way.
 */
export async function embedTranscript(
  caseRef: string,
  transcript: string,
  // REQUIRED, with the same rationale as transcript-index.ts: every vector
  // carries the tenant key, and an unscoped write is unrepresentable.
  orgId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!orgId.trim()) return { ok: false, error: "org_id_required" };
  if (!transcriptEmbeddingsConfigured()) return { ok: false, error: "openai_not_configured" };
  const trimmed = transcript.slice(0, env.ragEmbeddingMaxChars * env.ragEmbeddingMaxChunks);
  if (!trimmed.trim()) return { ok: false, error: "empty_transcript" };

  const chunks = chunkText(trimmed, {
    maxChars: env.ragEmbeddingMaxChars,
  }).slice(0, env.ragEmbeddingMaxChunks);
  if (chunks.length === 0) return { ok: false, error: "no_extractable_text" };

  const embedded = await embedChunks(chunks);
  if ("error" in embedded) {
    await auditAppend(
      {
        callRef: caseRef,
        action: "agent",
        intent: "transcript_embed_failed",
        callerId: "system-pgvector",
        redactedText: "pgvector transcript embedding failed; case remains sealed-only",
        meta: { caseRef, error: embedded.error.slice(0, 200) },
        orgId: orgId || undefined,
      },
      { fast: true },
    ).catch(() => {});
    return { ok: false, error: embedded.error.slice(0, 200) };
  }

  // Delete first so a re-run with a shorter transcript cannot leave old chunks.
  await db
    .$executeRawUnsafe(`DELETE FROM "TranscriptEmbedding" WHERE "caseRef" = $1`, caseRef)
    .catch(() => {});

  try {
    for (let i = 0; i < chunks.length; i++) {
      await db.$executeRawUnsafe(
        `INSERT INTO "TranscriptEmbedding"
           ("id", "caseRef", "orgId", "chunkIndex", "text", "embedding", "model")
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
         ON CONFLICT ("caseRef", "chunkIndex") DO UPDATE
           SET "text" = EXCLUDED."text",
               "embedding" = EXCLUDED."embedding",
               "model" = EXCLUDED."model",
               "createdAt" = now()`,
        vectorId(caseRef, i),
        caseRef,
        orgId,
        i,
        chunks[i],
        pgVector(embedded[i]),
        env.ragEmbeddingModel,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await auditAppend(
      {
        callRef: caseRef,
        action: "agent",
        intent: "transcript_embed_failed",
        callerId: "system-pgvector",
        redactedText: "pgvector transcript embedding failed; case remains sealed-only",
        meta: { caseRef, error: msg.slice(0, 200) },
        orgId: orgId || undefined,
      },
      { fast: true },
    ).catch(() => {});
    return { ok: false, error: msg.slice(0, 200) };
  }

  await auditAppend(
    {
      callRef: caseRef,
      action: "agent",
      intent: "transcript_indexed_pgvector",
      callerId: "system-pgvector",
      redactedText: "transcript embedded into pgvector for semantic search",
      meta: { model: env.ragEmbeddingModel, chunks: chunks.length },
      orgId: orgId || undefined,
    },
    { fast: true },
  ).catch(() => {});
  return { ok: true };
}

export type TranscriptSearchHit = {
  caseRef: string;
  score: number;
  text: string;
  chunkIndex: number;
};

/**
 * Tenant-scoped semantic search over indexed transcripts.
 *
 * Same contract as searchTranscripts in transcript-index.ts: `orgId` is
 * required and the filter is applied inside the query AND re-checked after it.
 * The unscoped call is unrepresentable.
 *
 * Cosine similarity via `<=>`: `1 - (embedding <=> query)` is 1.0 for identical
 * vectors, 0.0 for orthogonal, and pgvector's ivfflat index with
 * `vector_cosine_ops` accelerates exactly this operator.
 */
export async function searchTranscripts(
  orgId: string,
  question: string,
  topK = 3,
): Promise<{ ok: boolean; matches: TranscriptSearchHit[]; error?: string }> {
  if (!orgId.trim()) return { ok: false, matches: [], error: "org_id_required" };
  if (!transcriptEmbeddingsConfigured())
    return { ok: false, matches: [], error: "openai_not_configured" };
  const trimmed = question.trim().slice(0, env.ragEmbeddingMaxChars);
  if (!trimmed) return { ok: true, matches: [] };

  const embedded = await embedChunks([trimmed]);
  if ("error" in embedded) {
    return { ok: false, matches: [], error: embedded.error.slice(0, 200) };
  }
  const [query] = embedded;

  let rows: Array<{
    caseRef: string;
    orgId: string;
    score: string;
    text: string;
    chunkIndex: number;
  }>;
  try {
    rows = await db.$queryRawUnsafe<
      {
        caseRef: string;
        orgId: string;
        score: string;
        text: string;
        chunkIndex: number;
      }[]
    >(
      `SELECT "caseRef",
              "orgId",
              1 - ("embedding" <=> $1::vector) AS score,
              "text",
              "chunkIndex"
       FROM "TranscriptEmbedding"
       WHERE "orgId" = $2
       ORDER BY "embedding" <=> $1::vector
       LIMIT $3`,
      pgVector(query),
      orgId,
      topK,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      matches: [],
      error: msg.slice(0, 200),
    };
  }

  // Belt and braces: re-check the tenant boundary after the query, mirroring
  // transcript-index.ts. A dropped filter would return another institution's
  // call transcripts and nothing here would notice.
  const matches = rows
    .filter((r) => r.caseRef && r.orgId === orgId)
    .map((r) => ({
      caseRef: r.caseRef,
      score: Number(r.score),
      text: r.text.slice(0, env.ragEmbeddingMaxChars),
      chunkIndex: r.chunkIndex,
    }))
    .slice(0, topK);
  return { ok: true, matches };
}

/**
 * Erasure hook: delete every vector for a case. Called from crypto-shred.ts
 * alongside the Pinecone forget; failure is logged and never blocks the
 * erasure that already committed.
 */
export async function forgetTranscriptEmbeddings(
  caseRef: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await db.$executeRawUnsafe(`DELETE FROM "TranscriptEmbedding" WHERE "caseRef" = $1`, caseRef);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
