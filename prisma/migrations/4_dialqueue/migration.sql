-- Durable dial queue. Call placement moves out of the request handler so a
-- campaign burst queues instead of overwhelming the telephony provider, and a
-- killed worker releases its claim by lease expiry rather than losing the job.
-- The unique index on (caseRef, attemptNo) is the exactly-once dial guarantee.

CREATE TABLE "DialJob" (
    "id" TEXT NOT NULL,
    "caseRef" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "conversationId" TEXT,
    "callSid" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DialJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DialJob_caseRef_attemptNo_key" ON "DialJob"("caseRef", "attemptNo");
CREATE INDEX "DialJob_state_priority_createdAt_idx" ON "DialJob"("state", "priority", "createdAt");
CREATE INDEX "DialJob_state_availableAt_idx" ON "DialJob"("state", "availableAt");
CREATE INDEX "DialJob_leaseExpiresAt_idx" ON "DialJob"("leaseExpiresAt");