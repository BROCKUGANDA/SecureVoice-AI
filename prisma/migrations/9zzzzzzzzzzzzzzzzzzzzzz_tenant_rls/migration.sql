-- Tenant isolation at the database layer (row-level security).
--
-- ── Why a role is part of this migration ────────────────────────────────────
-- Enabling row-level security is not the same as enforcing it. Every role that
-- owns a table, holds the `BYPASSRLS` attribute, or is a superuser skips policies
-- entirely and silently — and this application connects as exactly such a role
-- (`securevoice`: usesuper = t, usebypassrls = t, verified against the running
-- database). Policies added on top of that connection are decoration: `SELECT`
-- would keep returning every tenant's rows and every gate would keep passing.
--
-- So this migration creates `sv_tenant` — NOSUPERUSER, NOBYPASSRLS, NOLOGIN — and
-- the scoped execution path (`src/lib/tenancy/db-scope.ts`) enters it with
-- `SET LOCAL ROLE sv_tenant` inside a transaction, alongside
-- `SET LOCAL app.org_id`. The privilege-reliant paths (migrations, the dial and
-- retention workers, the outbox, cross-tenant operations) keep connecting as the
-- application role and therefore keep seeing everything they legitimately must.
--
-- `FORCE ROW LEVEL SECURITY` is still set per table: it costs nothing today and
-- keeps the policies binding on the day a table's owner becomes the connecting
-- role, which is what happens if this deployment is ever moved onto a
-- least-privilege database user.
--
-- ── The default is denial ────────────────────────────────────────────────────
-- A row is visible to a tenant only when its `orgId` is not null and equals the
-- session's `app.org_id`. Rows with a null `orgId` are therefore invisible under
-- the tenant role, deliberately: a null-org row is a row whose owner is unknown,
-- and "unknown" is not an authorisation. Anything that must reach those rows does
-- so from a service path, not from a tenant scope.
--
-- `FOR ALL` carries both USING (reads) and WITH CHECK (writes), so a tenant cannot
-- insert or reparent a row into somebody else's organisation either.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sv_tenant') THEN
    CREATE ROLE sv_tenant NOSUPERUSER NOBYPASSRLS NOLOGIN INHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO sv_tenant;

-- Table privileges, not just policies: RLS restricts rows among the rows a role
-- may touch at all. Sequences are included because every primary key here is a
-- cuid() written by the application, and the few `@default(seq)` columns need it.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sv_tenant;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sv_tenant;

-- Every table that carries an orgId, discovered rather than listed. A hand-copied
-- table list is how a later table silently misses isolation; this loop covers
-- whatever exists at apply time, and the gate in
-- `tests/tenancy/rls-enforcement.test.ts` asserts the coverage both ways.
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

    -- Idempotent re-apply: `migrate deploy` runs this once, but a manual replay
    -- must not fail halfway through and leave some tables guarded and others not.
    IF EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t.table_name
        AND policyname = 'tenant_scope'
    ) THEN
      EXECUTE format('DROP POLICY tenant_scope ON %I', t.table_name);
    END IF;

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
