-- Captures the Case model (was applied to the database via prisma db push before
-- migration history existed). Marked applied via migrate resolve on existing DBs.

CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "caseRef" TEXT NOT NULL,
    "orgId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'RECEIVED',
    "conversationId" TEXT,
    "transactionRef" TEXT,
    "riskScore" DOUBLE PRECISION,
    "language" TEXT NOT NULL DEFAULT 'en',
    "phone" TEXT,
    "merchant" TEXT,
    "amountMinor" INTEGER,
    "currency" TEXT,
    "consentRecordId" TEXT,
    "freezeStaged" BOOLEAN NOT NULL DEFAULT false,
    "freezeReference" TEXT,
    "handoffQueued" BOOLEAN NOT NULL DEFAULT false,
    "handoffSpecialist" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Case_caseRef_key" ON "Case"("caseRef");
CREATE INDEX "Case_orgId_state_idx" ON "Case"("orgId", "state");
CREATE INDEX "Case_orgId_createdAt_idx" ON "Case"("orgId", "createdAt");
CREATE INDEX "Case_conversationId_idx" ON "Case"("conversationId");
