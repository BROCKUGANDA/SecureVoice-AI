-- RenameIndex — EmailOutbox index names, snake_case -> camelCase.
--
-- WHY THIS IS IDEMPOTENT (and why it is its own migration, LAST in the order):
--
-- `9zzzzzzzzzzzzzzzzz_email_outbox` created these indexes with snake_case names
-- (`EmailOutbox_created_at_idx`), while the schema's `@@index` declarations
-- resolve to camelCase (`EmailOutbox_createdAt_idx`). That is genuine drift, and
-- Prisma reports it as such on any database where the migration history is
-- replayed from scratch.
--
-- It must run AFTER the migration that creates the indexes, so it carries the
-- highest `z`-prefix in this directory — the repo forces ordering by
-- lexicographic prefix (`9zzzzzzzzz_` < `9zzzzzzzzzzzzzzzzz_` < `9zzzzzzzzzzzzzzzzzz_`),
-- NOT by timestamp. A timestamped name sorts before every `9zzz…` migration and
-- would try to rename indexes that do not exist yet on a fresh database, which
-- is exactly the bug this file replaces.
--
-- The existence guard makes it a no-op on a database already in the camelCase
-- state (the production/staging path, where the rename was applied by hand),
-- and the correct fix on a fresh one.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'EmailOutbox_created_at_idx' AND n.nspname = current_schema()
  ) THEN
    ALTER INDEX "EmailOutbox_created_at_idx" RENAME TO "EmailOutbox_createdAt_idx";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'EmailOutbox_state_next_attempt_at_idx' AND n.nspname = current_schema()
  ) THEN
    ALTER INDEX "EmailOutbox_state_next_attempt_at_idx" RENAME TO "EmailOutbox_state_nextAttemptAt_idx";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'EmailOutbox_to_email_idx' AND n.nspname = current_schema()
  ) THEN
    ALTER INDEX "EmailOutbox_to_email_idx" RENAME TO "EmailOutbox_toEmail_idx";
  END IF;
END
$$;
