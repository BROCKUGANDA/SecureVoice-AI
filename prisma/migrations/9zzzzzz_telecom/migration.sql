-- Multi-tenant telecom isolation + the telecom outbox.
--
-- Naming follows the lexicographic constraint in 9zzzz_call_categories
-- (this sorts after 9zzzzz_call_sid). ALL CHANGES ARE ADDITIVE.
--
-- Per-tenant telecom identity: the institution's OWN numbers, so Bank A's
-- customers never see Bank B's caller ID. The voice caller ID on the
-- ElevenLabs path is the org's bound platform phone number
-- ("elevenPhoneNumberId", already present); these columns carry the
-- org-owned Twilio surface: the number customers can call BACK, and the
-- SMS sender identity.
ALTER TABLE "organization" ADD COLUMN "twilioVoiceNumber" TEXT;
ALTER TABLE "organization" ADD COLUMN "twilioSmsSenderId" TEXT;
ALTER TABLE "organization" ADD COLUMN "twilioMessagingServiceSid" TEXT;

-- The telecom outbox: the lifecycle of every outbound call and SMS, org-scoped.
-- `providerSid` is Twilio's call/message sid (the status-callback join key);
-- `status` follows the delivery lifecycle: queued | in_progress | sent |
-- delivered | failed. `payload` holds the exact text sent (already
-- redacted by the copy layer — no merchant, no amount).
CREATE TABLE "TelecomEvent" (
    "id" TEXT NOT NULL,
    "orgId" UUID,
    "caseId" TEXT,
    "channel" TEXT NOT NULL,
    "toPhone" TEXT NOT NULL,
    "fromPhone" TEXT NOT NULL,
    "providerSid" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelecomEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TelecomEvent_orgId_createdAt_idx" ON "TelecomEvent"("orgId", "createdAt");
CREATE INDEX "TelecomEvent_providerSid_idx" ON "TelecomEvent"("providerSid");
CREATE INDEX "TelecomEvent_caseId_idx" ON "TelecomEvent"("caseId");
