-- ── Tenant RLS coverage for the Qwen3Guard moderation tables ─────────────────
--
-- Same shape as `…_tenant_rls_voice_observability`: the discovery loops run at
-- APPLY time, so the tables created by `…_qwen3guard_moderation`
-- (`ModerationRequest`, `ModerationPolicyVersion`) carried an `orgId` and no
-- policy at all until this pass. `tests/tenancy/rls-enforcement.test.ts` fails
-- on exactly that shape, by design.
--
-- The policy body is byte-identical to the earlier passes on purpose: one rule
-- for every tenant-scoped table. Rows with a null `orgId` stay invisible under
-- `sv_tenant` — platform-level moderation evidence is reachable only from
-- service paths, never from a tenant scope.

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
      AND tb.table_name IN ('ModerationRequest', 'ModerationPolicyVersion')
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
