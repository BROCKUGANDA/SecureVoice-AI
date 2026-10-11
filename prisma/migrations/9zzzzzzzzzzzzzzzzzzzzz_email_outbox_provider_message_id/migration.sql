-- AlterTable
ALTER TABLE "EmailOutbox" ADD COLUMN     "providerMessageId" TEXT;

-- CreateIndex
CREATE INDEX "EmailOutbox_providerMessageId_idx" ON "EmailOutbox"("providerMessageId");
