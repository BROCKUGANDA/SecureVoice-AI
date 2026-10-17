-- ── Tenant RLS coverage for the voice-observability tables ─────────────────────
--
-- WHY THIS MIGRATION EXISTS. `9zzzzzzzzzzzzzzzzzzzzzzz_tenant_rls_coverage`
-- closes over every table that carries an `orgId` column and gives it a
-- `tenant_scope` policy, which is what makes the multi-tenant boundary hold at
-- the database rather than in a `where` clause someone can forget. That loop ran
-- BEFORE `LlmUsage` and `TtsSynthesis` were created by
-- `20261015120000_voice_observability_tables`, so those two tables carried an
-- `orgId` and no policy at all: the exact shape the earlier migration's own
-- comment says must fail the suite rather than pass review.
--
-- `tests/tenancy/rls-enforcement.test.ts` asserts coverage in both directions,
-- and it named both tables. A tenant role that could read another's LLM usage
-- or TTS synthesis rows would be a cross-tenant read of bank transcripts, so
-- this is the same default-deny the first pass applied, extended to tables that
-- did not exist when it ran.
--
-- The policy body is byte-identical to the loop above on purpose: one rule for
-- every tenant-scoped table, so the next table added under a different name
-- fails the same test rather than quietly arriving unguarded.

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'orgId'
      AND tb.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I', t.table_name);
    EXECUTE format(
      $pol$
      CREATE POLICY tenant_scope ON %I AS PERMISSIVE FOR ALL TO sv_tenant
        USING (
          "orgId" IS NOT NULL
          AND "orgId"::text = NULLIF(current_setting('app.org_id', true), '')::text
        )
        WITH CHECK (
          "orgId" IS NOT NULL
          AND "orgId"::text = NULLIF(current_setting('app.org_id', true), '')::text
        )
      $pol$,
      t.table_name
    );
  END LOOP;
END
$$;