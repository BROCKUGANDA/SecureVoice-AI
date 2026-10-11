-- Per-tenant BYOK credentials on the Organization.
--
-- The BYOK keys (ElevenLabs, LLM) were stored on UserProfile, which is per-USER.
-- That is the wrong granularity for a multi-tenant platform: a bank's fraud team
-- shares one ElevenLabs account across every analyst, so the key belongs to the
-- ORGANISATION. Storing it per-user meant N copies of the same secret, N places
-- to rotate it, and no way to revoke it for the whole tenant at once.
--
-- This migration adds the three columns to Organization. They are nullable and
-- additive: existing tenants have no org-level key and continue to resolve
-- through the per-user fallback in `resolveTtsKey` / `resolveLlmCredentials`.
-- A tenant that configures an org-level key gets it automatically — no data
-- migration, no backfill, no downtime.
--
-- The columns are sealed with the same AES-256-GCM envelope as the per-user
-- keys (src/lib/byok.ts), so the encryption story is unchanged. The console
-- writes them through the same `encryptSecret` / `decryptSecret` path.

ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "elevenKeyEnc" TEXT;
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "llmKeyEnc" TEXT;
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "llmBaseUrl" TEXT;