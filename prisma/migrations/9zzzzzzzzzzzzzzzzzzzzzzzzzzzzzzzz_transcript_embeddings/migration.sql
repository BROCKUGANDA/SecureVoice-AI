-- Per-case transcript embeddings for NATIVE (pgvector) RAG.
--
-- Why pgvector instead of a third-party vector database:
--
--   - The transcript already lives in this database (Case.transcriptRedacted,
--     sealed under crypto-shred). Embedding it here keeps bank call data inside
--     the tenant boundary instead of shipping it to a vendor vector store. The
--     absence of PINECONE_API_KEY already proves nothing has left the building;
--     this file is what makes that guarantee real for the transcript plane too.
--   - Cosine similarity is computed by Postgres itself, so retrieval shares the
--     same connection pool, RLS policies and audit boundary as the rest of the
--     case data. No vendor key, no separate retention owner, no cross-tenant
--     blast radius from a misconfigured third-party index.
--   - `chunkIndex` lets a long transcript be embedded in several vectors rather
--     than one 4000-char blob whose signal drowns in noise. Every chunk carries
--     `orgId`, and every query filters by it; an unscoped search is
--     unrepresentable by design.
--
-- The extension and table are created inside DO blocks that swallow the error
-- when pgvector is not installed in this database (e.g. the local dev
-- postgres:16-alpine image does not ship it). The migration therefore never
-- fails for a missing extension — transcript RAG is simply unavailable until
-- pgvector is present, which is honest: the feature is additionally gated
-- behind OPENAI_API_KEY (src/lib/config.ts `ragEmbeddingsConfigured`).
--
-- Additive and safe on existing data: existing rows simply have no embeddings
-- until a post-call ingest runs `embedTranscript`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE EXTENSION vector;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- pgvector is not installed in this database (local dev postgres:16-alpine
  -- does not ship it). Transcript RAG is unavailable here; the feature is
  -- gated behind OPENAI_API_KEY anyway.
  NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS "TranscriptEmbedding" (
        "id" TEXT NOT NULL,
        "caseRef" TEXT NOT NULL,
        "orgId" TEXT NOT NULL,
        "chunkIndex" INTEGER NOT NULL,
        "text" TEXT NOT NULL,
        "embedding" vector(1536) NOT NULL,
        "model" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),

        CONSTRAINT "TranscriptEmbedding_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "TranscriptEmbedding_caseRef_chunkIndex_key"
            UNIQUE ("caseRef", "chunkIndex")
    );

    CREATE INDEX IF NOT EXISTS "TranscriptEmbedding_orgId_caseRef_idx"
        ON "TranscriptEmbedding" ("orgId", "caseRef");

    -- ivfflat with vector_cosine_ops: cosine distance is what the search side
    -- compares against, so the index must match the operator. lists=100 is a
    -- starting point; the operator tunes it against their call volume.
    CREATE INDEX IF NOT EXISTS "TranscriptEmbedding_embedding_idx"
        ON "TranscriptEmbedding" USING ivfflat ("embedding" vector_cosine_ops)
        WITH (lists = 100);
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
