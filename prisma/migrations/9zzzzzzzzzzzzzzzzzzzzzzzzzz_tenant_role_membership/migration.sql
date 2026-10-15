-- The tenant role must be one the connecting role can ACTUALLY ENTER.
--
-- `withTenantScope()` (src/lib/tenancy/db-scope.ts) runs every tenant-scoped
-- transaction as `SET LOCAL ROLE "sv_tenant"`, because the application's own
-- connecting role holds BYPASSRLS — so the policies only bind while the session is
-- inside the tenant role. `9zzzzzzzzzzzzzzzzzzzzzz_tenant_rls` creates `sv_tenant`
-- and grants it table privileges, but nothing in this schema ever grants
-- MEMBERSHIP of it to the role that connects.
--
-- That gap is silent on a superuser (a superuser may set any role) and loud
-- everywhere else. Worse, PostgreSQL 16 changed what "member" means for this:
-- role membership now carries per-membership options, and a membership recorded
-- without the SET option cannot be entered. `pg_dump`/`psql` restore emits the
-- legacy `ALTER ROLE … IN ROLE …` form, which records INHERIT but not SET — so a
-- database that arrives by restore or clone has membership that
-- `pg_has_role(…, 'MEMBER')` reports TRUE for, while `SET ROLE` answers
-- `42501 permission denied to set role "sv_tenant"`. Every scoped read then throws,
-- and the isolation the policies were written to provide is simply not in force.
--
-- Re-granting in the modern form restores all three options. It is idempotent, so
-- it is safe on a database where a superuser already made the switch work, and it
-- runs as the role that is actually connecting — which is what needs the entry.
--
-- Verified against PostgreSQL 17.11, where this was found: 78 scoped-transaction
-- failures across the tenancy, RLS, privacy and e2e suites on a database whose
-- membership row carried set_option = false.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sv_tenant') THEN
    EXECUTE format('GRANT sv_tenant TO %I', CURRENT_USER);
  END IF;
END
$$;
