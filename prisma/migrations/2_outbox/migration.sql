-- Outbox / dead-letter / inbound-bank-event tables.
-- Generated with prisma migrate diff against the deployed database (which had the
-- schema in code but none of these tables). Without this migration, every bank
-- notification 500s with 'table public.OutboxEvent does not exist'.

CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'elevenlabs',
    "eventType" TEXT NOT NULL,
    "conversationId" TEXT,
    "agentId" TEXT,
    "eventTimestamp" INTEGER,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "processedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookQuarantine" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "conversationId" TEXT,
    "reason" TEXT NOT NULL,
    "transcriptRedacted" TEXT,
    "eventTimestamp" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookQuarantine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "caseRef" TEXT,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadLetter" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "caseRef" TEXT,
    "payload" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "replayedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundBankEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "caseRef" TEXT,
    "signatureValid" BOOLEAN NOT NULL,
    "signatureHeader" TEXT,
    "body" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundBankEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookEvent_processed_idx" ON "WebhookEvent"("processed");

-- CreateIndex
CREATE INDEX "WebhookEvent_conversationId_idx" ON "WebhookEvent"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_eventType_conversationId_eventTimesta_key" ON "WebhookEvent"("provider", "eventType", "conversationId", "eventTimestamp");

-- CreateIndex
CREATE INDEX "WebhookQuarantine_conversationId_idx" ON "WebhookQuarantine"("conversationId");

-- CreateIndex
CREATE INDEX "WebhookQuarantine_createdAt_idx" ON "WebhookQuarantine"("createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_state_nextAttemptAt_idx" ON "OutboxEvent"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_caseRef_idx" ON "OutboxEvent"("caseRef");

-- CreateIndex
CREATE UNIQUE INDEX "DeadLetter_eventId_key" ON "DeadLetter"("eventId");

-- CreateIndex
CREATE INDEX "DeadLetter_failedAt_idx" ON "DeadLetter"("failedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundBankEvent_eventId_key" ON "InboundBankEvent"("eventId");

-- CreateIndex
CREATE INDEX "InboundBankEvent_receivedAt_idx" ON "InboundBankEvent"("receivedAt");
