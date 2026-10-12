-- ---------------------------------------------------------------------------
-- White-label brand colour on the organization (the tenant row).
--
-- Nullable, so every existing tenant keeps the platform default with no backfill
-- and no window in which a row is missing a value the console expects.
--
-- The CHECK is the last line of defence, not the primary control: the settings
-- route refuses a failing colour before it reaches this statement, and
-- tests/unit/brand-color.test.ts asserts that gate's arithmetic. The constraint
-- exists because a column that is only correct on one code path becomes wrong
-- the first time something writes to the table from elsewhere — a seed script, a
-- migration, a psql session at 2am during an incident.
--
--   · six hex digits, lower case  — the normal form `normalizeHex` emits, so
--     "is it normalised" is answerable by the database rather than by a reader
--
-- The CHECK constrains SHAPE only. It deliberately does not reject white or
-- black: `evaluateBrandPrimary` accepts those and CORRECTS them per colour
-- scheme (down for the light card, up for the dark one), so refusing them here
-- would reject values the application deliberately supports — and would turn a
-- clean 422 at the settings route into a 500 from the database. A column whose
-- constraint is narrower than the rule the application enforces is a column
-- that produces the wrong status code on the day someone tries a monochrome
-- bank.
--
-- Note the table name: the Prisma model is `Organization` but it maps to a
-- lower-case "organization" table, and Postgres folds an unquoted name to
-- lower case — so the quoted form below is correct and the unquoted capitalised
-- one is a relation that does not exist.
-- ---------------------------------------------------------------------------

ALTER TABLE "organization"
  ADD COLUMN IF NOT EXISTS "brandPrimary" TEXT;

-- `ADD CONSTRAINT` has no IF NOT EXISTS, so the guard is a catalogue lookup in a
-- DO block. This keeps the migration re-runnable against a database where a
-- previous attempt already added it, which is the situation a failed apply
-- leaves behind.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organization_brand_primary_chk'
      AND conrelid = '"organization"'::regclass
  ) THEN
    ALTER TABLE "organization"
      ADD CONSTRAINT "organization_brand_primary_chk"
      CHECK ("brandPrimary" IS NULL OR "brandPrimary" ~ '^#[0-9a-f]{6}$');
  END IF;
END
$$;

COMMENT ON COLUMN "organization"."brandPrimary" IS
  'White-label primary colour as #rrggbb, contrast-validated by src/lib/brand/color.ts. NULL = platform default.';
