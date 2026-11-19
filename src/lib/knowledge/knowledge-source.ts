import "server-only";
/**
 * The REAL knowledge seam adapter — the Pinecone document index bound to the
 * WP-18 `KnowledgeSource` port.
 *
 * A thin adapter on purpose: `searchDocuments` already carries the org
 * refusal, the PII-safe query handling and the error vocabulary. This file
 * adds only what the port requires that the function does not carry — the
 * adapter identity and the declared mode — because the registry refuses to
 * build a binding whose adapter does not say what it is.
 */

import { searchDocuments } from "@/lib/knowledge/documents";
import type { KnowledgeSearchResult, KnowledgeSource } from "@/lib/ports/types";

export const PINECONE_KNOWLEDGE_SOURCE_ID = "pinecone-documents";

export function pineconeKnowledgeSource(): KnowledgeSource {
  return {
    adapterId: PINECONE_KNOWLEDGE_SOURCE_ID,
    mode: "real",
    async search(
      orgId: string,
      query: string,
      topK = 5,
    ): Promise<KnowledgeSearchResult> {
      const res = await searchDocuments(orgId, query, topK);
      if (!res.ok) {
        return { ok: false, hits: [], error: res.error ?? "knowledge_unavailable" };
      }
      return {
        ok: true,
        hits: res.matches.map((m) => ({
          source: m.documentId,
          score: m.score,
          text: m.text,
          chunkIndex: m.chunkIndex,
        })),
      };
    },
  };
}
