-- Per-tenant vendor webhook endpoint.
--
-- Outcome events are delivered to one deployment-wide BANK_WEBHOOK_URL today,
-- so every institution's results arrive at the same place. A bank integrating
-- SecureVoice needs its own endpoint called with its own signing key, and needs
-- one tenant's key rotation to have no effect on another tenant's deliveries.
--
-- Both columns are nullable and the fallback is the existing global, so a
-- single-tenant deployment changes behaviour not at all.

ALTER TABLE "organization"
  ADD COLUMN IF NOT EXISTS "vendorWebhookUrl"       TEXT,
  ADD COLUMN IF NOT EXISTS "vendorWebhookSecretEnc" TEXT;
