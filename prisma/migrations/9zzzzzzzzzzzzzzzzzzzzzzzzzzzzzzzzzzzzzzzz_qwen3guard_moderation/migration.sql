-- CreateTable
CREATE TABLE "ModerationRequest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "caseRef" TEXT,
    "conversationId" TEXT,
    "traceId" TEXT,
    "stage" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "categories" TEXT[],
    "model" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "refused" BOOLEAN NOT NULL DEFAULT false,
    "inputHash" TEXT NOT NULL,
    "sample" TEXT,
    "latencyMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationPolicyVersion" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "version" INTEGER NOT NULL,
    "profile" TEXT NOT NULL,
    "escalateOn" TEXT NOT NULL DEFAULT 'unsafe',
    "languages" TEXT[],
    "gateTools" BOOLEAN NOT NULL DEFAULT true,
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "createdBy" TEXT,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModerationRequest_orgId_createdAt_idx" ON "ModerationRequest"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationRequest_stage_verdict_createdAt_idx" ON "ModerationRequest"("stage", "verdict", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationRequest_traceId_idx" ON "ModerationRequest"("traceId");

-- CreateIndex
CREATE INDEX "ModerationRequest_caseRef_idx" ON "ModerationRequest"("caseRef");

-- CreateIndex
CREATE INDEX "ModerationRequest_createdAt_idx" ON "ModerationRequest"("createdAt");

-- CreateIndex
CREATE INDEX "ModerationPolicyVersion_orgId_active_effectiveFrom_idx" ON "ModerationPolicyVersion"("orgId", "active", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ModerationPolicyVersion_orgId_version_key" ON "ModerationPolicyVersion"("orgId", "version");
