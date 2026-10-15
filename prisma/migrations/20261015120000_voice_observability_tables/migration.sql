-- Token accounting and TTS rung data, as tables instead of text blobs.
--
-- Two observability writes that existed only as fields handed to Langfuse or
-- embedded in `AuditLog.meta` (a `String?`), which made both of them unqueryable:
-- "what did inference cost this week" and "how often did synthesis fall back"
-- could not be asked as SQL. See docs/GAP-REGISTER.md §13 items 6 and 7.
--
-- Both tables are written fire-and-forget AFTER the customer has been served, on
-- the same discipline as the audit append — an observability row must never be on
-- the voice path's critical section, and a failed write must never fail a turn.
--
-- `orgId` is nullable on both: the LLM drafter does not always run inside an org
-- context (the demo and unauthenticated TTS paths), and a cost row that names the
-- provider and model is still worth having when the tenant is unknown. Nullable
-- org on a tenant-scoped table is deliberate, stated here so the next reader does
-- not "fix" it into a NOT NULL that silently drops those rows.

-- ── LlmUsage ─────────────────────────────────────────────────────────────────

CREATE TABLE "LlmUsage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LlmUsage_orgId_createdAt_idx" ON "LlmUsage"("orgId", "createdAt");
CREATE INDEX "LlmUsage_provider_createdAt_idx" ON "LlmUsage"("provider", "createdAt");
CREATE INDEX "LlmUsage_createdAt_idx" ON "LlmUsage"("createdAt");

-- ── TtsSynthesis ─────────────────────────────────────────────────────────────

CREATE TABLE "TtsSynthesis" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "callRef" TEXT,
    "source" TEXT NOT NULL,
    "rung" INTEGER,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "bytes" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TtsSynthesis_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TtsSynthesis_orgId_createdAt_idx" ON "TtsSynthesis"("orgId", "createdAt");
CREATE INDEX "TtsSynthesis_source_createdAt_idx" ON "TtsSynthesis"("source", "createdAt");
