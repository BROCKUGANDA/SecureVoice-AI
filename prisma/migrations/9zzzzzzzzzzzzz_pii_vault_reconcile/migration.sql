-- Reconcile `pii_vault` with prisma/schema.prisma.
--
-- 9zzzzzzzzz_pii_vault/migration.sql created the table with "createdAt" as a
-- plain TIMESTAMP and the (orgId, type) index named "pii_vault_org_type_idx".
-- Prisma's datamodel maps an unadorned DateTime to TIMESTAMP(3), and names a
-- bare @@index([orgId, type]) after the FIELD (orgId), so schema.prisma expects
-- "createdAt" TIMESTAMP(3) and the index "pii_vault_orgId_type_idx". That gap
-- is exactly what the migration drift gate flagged ("schema.prisma is ahead of
-- prisma/migrations").
--
-- Applied as a NEW migration rather than an edit to the original: an edited
-- migration keeps its old checksum, so any environment (including production)
-- that already applied the original would never see the correction, while
-- migrate diff --from-migrations would still drift. This reconciles every
-- environment to the schema in one place.

-- AlterTable
ALTER TABLE "pii_vault" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- RenameIndex
ALTER INDEX "pii_vault_org_type_idx" RENAME TO "pii_vault_orgId_type_idx";
