-- Post-call ingest columns on Case, plus the Notification table.
-- Second schema-ahead-of-migrations instance. Generated with prisma migrate diff
-- against the deployed database; CI now fails the build if this ever drifts again.

-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "dataCollectionResults" TEXT,
ADD COLUMN     "dataKeyEnc" TEXT,
ADD COLUMN     "durationSeconds" INTEGER,
ADD COLUMN     "erasedAt" TIMESTAMP(3),
ADD COLUMN     "evaluationResults" TEXT,
ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "postCallAt" TIMESTAMP(3),
ADD COLUMN     "postCallEventType" TEXT,
ADD COLUMN     "transcriptRedacted" TEXT;

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "caseRef" TEXT,
    "alertType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "windowMinutes" INTEGER NOT NULL DEFAULT 0,
    "count" INTEGER NOT NULL DEFAULT 1,
    "contactIndex" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLedger" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "caseRef" TEXT,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "reason" TEXT,
    "idemKey" TEXT NOT NULL,
    "balanceAfter" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "provider" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "entitlementsJson" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_orgId_acknowledgedAt_idx" ON "Notification"("orgId", "acknowledgedAt");

-- CreateIndex
CREATE INDEX "Notification_alertType_idx" ON "Notification"("alertType");

-- CreateIndex
CREATE UNIQUE INDEX "UsageLedger_idemKey_key" ON "UsageLedger"("idemKey");

-- CreateIndex
CREATE INDEX "UsageLedger_orgId_createdAt_idx" ON "UsageLedger"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageLedger_caseRef_idx" ON "UsageLedger"("caseRef");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecord_reference_key" ON "PaymentRecord"("reference");

-- CreateIndex
CREATE INDEX "PaymentRecord_orgId_createdAt_idx" ON "PaymentRecord"("orgId", "createdAt");
