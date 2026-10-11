-- CreateTable
CREATE TABLE "EmailInbound" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "attachmentNames" TEXT NOT NULL DEFAULT '[]',
    "verdict" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailInbound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailInbound_messageId_key" ON "EmailInbound"("messageId");

-- CreateIndex
CREATE INDEX "EmailInbound_recipient_receivedAt_idx" ON "EmailInbound"("recipient", "receivedAt");

-- CreateIndex
CREATE INDEX "EmailInbound_fromEmail_idx" ON "EmailInbound"("fromEmail");

-- CreateIndex
CREATE INDEX "EmailInbound_receivedAt_idx" ON "EmailInbound"("receivedAt");
