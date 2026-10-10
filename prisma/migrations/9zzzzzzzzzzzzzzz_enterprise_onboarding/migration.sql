-- Enterprise onboarding: org wallet, tenant residency + onboarding state,
-- telecom write credential, BYOK LLM key, and the knowledge-base Document
-- table.
--
-- NOTE ON THE DIRECTORY NAME. Migrations apply in LEXICOGRAPHIC order, so this
-- folder uses more `z`s than 9zzzzzzzzzzzzzz_agent_workflows (the current
-- tail) to sort after it - see 9zz_unreachable_resolution for the same
-- constraint.
--
-- ALL CHANGES ARE ADDITIVE. Every new organization/user_profile column is
-- nullable or defaulted, so a deploy of this migration under the previous
-- application build is safe: the old build simply never reads them.

-- 1. Institution wallet.
--
--    1 credit = 1 intervention signal fired. The organization is the tenant
--    (hazard AU-3), so when a session carries an active org its wallet is the
--    org's; the per-user wallet stays as the org-less fallback. 0 is a real
--    empty wallet - NOT a missing configuration - which is why it defaults
--    rather than nulling: an operator who has never topped up must see "0
--    credits", not "wallet unknown".
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "credits" INTEGER NOT NULL DEFAULT 0;

-- 2. Sovereign residency + onboarding progress, on the tenant.
--
--    Residency is declared by the institution (UAE | GCC | MENA | OTHER) and
--    surfaced on the audit trail, because "where does customer data live" is
--    the first question a PDPL reviewer asks. Wizard progress lives on the
--    tenant rather than the user so a second admin of the same bank resumes
--    where the first left off.
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "region" TEXT;
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "setupStep" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "setupCompletedAt" TIMESTAMP(3);

-- 3. The tenant's own Twilio auth token, AES-256-GCM sealed with the BYOK
--    master key (src/lib/byok.ts) exactly like vendorWebhookSecretEnc:
--    signing or driving the tenant's own telecom surface requires recovering
--    the plaintext, so it cannot be hash-only. Write-only: the console learns
--    only whether one exists.
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "twilioAuthTokenEnc" TEXT;

-- 4. BYOK OpenAI-compatible LLM key on the profile (same storage as the
--    ElevenLabs BYOK key above it). Preferred over the deployment's
--    Groq/LiteLLM/Gemini env chain when set, so an institution can route the
--    rephrase step through its own account. llmBaseUrl is NOT a secret - it
--    names the endpoint and is read back for display.
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "llmKeyEnc" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "llmBaseUrl" TEXT;

-- 5. Knowledge-base documents (RAG).
--
--    The raw PDF bytes are retained (capped at MAX_DOC_BYTES) so a FAILED
--    vectorization can be retried without asking the bank to upload again -
--    the "orphaned document" path. Vectors themselves live in Pinecone under
--    a strict { orgId } metadata filter; this table is the row-level source
--    of truth and is org-scoped for the console's status column.
CREATE TABLE IF NOT EXISTS "Document" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
    "sizeBytes" INTEGER NOT NULL,
    "lang" TEXT NOT NULL DEFAULT 'en',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "pdfBytes" BYTEA,
    "vectorizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Document_orgId_createdAt_idx" ON "Document"("orgId", "createdAt");
