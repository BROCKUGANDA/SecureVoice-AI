-- AlterTable
-- `lastActiveAt` is written by the Better Auth `dash` plugin's activity
-- tracking (`activityTracking.enabled`) and read by `sentinel`'s stale-user
-- check, which is handed `null` on every call while this column is absent.
-- Nullable and additive: existing rows simply have no recorded activity yet.
ALTER TABLE "user" ADD COLUMN "lastActiveAt" TIMESTAMP(3);
