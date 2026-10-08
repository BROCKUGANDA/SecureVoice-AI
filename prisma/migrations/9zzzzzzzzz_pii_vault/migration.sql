CREATE TABLE IF NOT EXISTS "pii_vault" (
  "token" TEXT PRIMARY KEY,
  "orgId" TEXT NOT NULL,
  "encryptedValue" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "pii_vault_org_type_idx" ON "pii_vault" ("orgId", "type");
