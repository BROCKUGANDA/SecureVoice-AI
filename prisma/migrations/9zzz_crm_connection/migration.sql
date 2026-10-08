-- An institution's connection to its own CRM (Zendesk / Salesforce / webhook).
--
-- Directory name: migrations apply in LEXICOGRAPHIC order, so this must sort after
-- 9zz_unreachable_resolution (see the note in 9z_org_agent_binding).
--
-- ADDITIVE: a new table only. `configEnc` holds the AES-256-GCM-encrypted JSON
-- config (same envelope as the BYOK key); the secrets are never stored in clear.
CREATE TABLE "CrmConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "configEnc" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CrmConnection_orgId_provider_key" ON "CrmConnection"("orgId", "provider");
CREATE INDEX "CrmConnection_orgId_idx" ON "CrmConnection"("orgId");
