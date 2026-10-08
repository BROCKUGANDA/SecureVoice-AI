-- The outbox table's own two columns, corrected after 9zzzzzz_telecom.
--
-- `id` was created as TEXT while every other id in this database is a UUID, and
-- `updatedAt` carried a CURRENT_TIMESTAMP default that Prisma's @updatedAt owns.
-- Both are FIXED FORWARD rather than edited into the applied migration: a
-- migration file that no longer matches what was applied to a database is how a
-- deploy host ends up with a schema no one's file describes, and the drift gate
-- then reports a difference nobody can attribute.
--
-- The cast is exact because the values in the column are UUIDs that were merely
-- stored as text.
ALTER TABLE "TelecomEvent" ALTER COLUMN "id" SET DATA TYPE UUID USING "id"::uuid;
ALTER TABLE "TelecomEvent" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "TelecomEvent" ALTER COLUMN "updatedAt" DROP DEFAULT;
