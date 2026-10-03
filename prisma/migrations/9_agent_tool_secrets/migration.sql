-- Per-tenant agent-tool credentials.
--
-- Bleedguard: `AGENT_TOOL_SECRET` is a single deployment-wide secret, so any
-- caller holding it could name ANY org's conversation_id and have that case
-- resolved, frozen or read — the one open cross-tenant gap recorded in
-- src/lib/tenancy/isolation-matrix.ts as `lib.case.by-conversation`.
--
-- This table makes the credential itself carry the tenant. The presented secret
-- is hashed with SHA-256, the row it matches names exactly one org, and the
-- tool-guard scopes the case lookup by that org. A leaked secret then reaches a
-- single tenant instead of the whole deployment.
--
-- Storage is hash-only and the plaintext is shown once, matching ProducerKey
-- exactly — one credential convention, not two. `revoked` keeps a compromised
-- key disableable without a migration.
--
-- orgId is a real foreign key to organization, not a bare string: an
-- AgentToolSecret that outlives its tenant is a credential pointing at nothing.

CREATE TABLE "AgentToolSecret" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "orgId" UUID NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentToolSecret_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentToolSecret_keyHash_key" ON "AgentToolSecret"("keyHash");

CREATE INDEX "AgentToolSecret_orgId_idx" ON "AgentToolSecret"("orgId");

ALTER TABLE "AgentToolSecret" ADD CONSTRAINT "AgentToolSecret_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;