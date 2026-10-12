-- Row-level security, coverage pass 2.
--
-- The first pass (`9zzzzzzzzzzzzzzzzzzzzzz_tenant_rls`) discovered tenant tables
-- by looking for a column literally named `orgId`, and guarded the 18 tables that
-- have one. That discovery is too narrow in three separate ways, and this
-- migration closes them. All three are silent: the guarded set looked complete,
-- because nothing errored.
--
-- 1. THE NAME IS NOT ALWAYS `orgId`.
--    `dial_job` is a hand-rolled worker table and spells it `org_id`
--    (schema.prisma maps orgId -> org_id). It is as tenant-scoped as `Case` — it
--    is literally the queue of outbound calls for one organisation — and it was
--    left unguarded. Same class of miss: any future table that follows the
--    snake_case convention, or the Better Auth `organizationId` convention,
--    inherits the hole without anybody deciding it should.
--
-- 2. THE AUTH TABLES ARE NOT TENANT-GATED, AND MUST NOT BE.
--    `session`, `member` and `invitation` carry an organisation reference, but
--    that reference is what RESOLVES the tenant: Better Auth has to read the
--    session to learn which organisation the caller is acting for. A policy of
--    the form `organizationId = current_setting('app.org_id')` is therefore
--    self-defeating on those tables — before the tenant is known there is nothing
--    to compare against, so every row is invisible and sign-in returns no user.
--    These tables get RLS with NO permissive policy instead, which is what makes
--    `sv_tenant` blind to them. That is the honest posture: authentication is a
--    service-path concern and it runs as the application role, which is not
--    subject to these policies.
--
--    This closes a real hole rather than a theoretical one. Pass 1 granted
--    `SELECT` on ALL tables to `sv_tenant`, so a scoped tenant transaction
--    running raw SQL could read every row of `user`, `session`, `account` and
--    `twoFactor` — password hashes, backup codes and session tokens for every
--    operator — with no predicate to defeat, because there was no policy at all.
--
-- 3. `EmailOutbox` AND `EmailInbound` CLAIM A BOUNDARY THEY DID NOT HAVE.
--    schema.prisma says of EmailOutbox: "this table holds personal data and is
--    inside the RLS boundary like every other tenant-scoped row." The table had
--    no organisation column at all, so there was nothing to be inside. Both
--    tables are added here, nullable and additive, and populated from the
--    session that produced the row. Rows written before this migration keep a
--    null orgId and therefore stay readable only by the service path — which is
--    the correct default for a row whose owner cannot be established, and is the
--    same rule pass 1 already applies to every other null-orgId row.
--
-- ── Why enabling RLS here is still inert for the connecting role ───────────────
-- Unchanged from pass 1 and still true: the application role is a superuser with
-- BYPASSRLS, and (on Supabase, where production runs) the `postgres` role carries
-- BYPASSRLS too. Neither is subject to any of these policies. They bind only
-- inside `withTenantScope` (src/lib/tenancy/db-scope.ts), which enters
-- `sv_tenant` for the duration of a transaction. That is why pass 1 also records
-- moving the deployment onto a least-privilege database user as the change that
-- makes these policies bind everywhere — it is not done here.
--
-- Idempotent by construction, like every later migration in this repository:
-- `migrate deploy` runs each file once, but a manual replay must not fail halfway
-- and leave some tables guarded and others not.

-- ── 1. dial_job — the same boundary, spelled differently ─────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'dial_job' AND column_name = 'org_id'
  ) THEN
    EXECUTE 'ALTER TABLE dial_job ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE dial_job FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_scope ON dial_job';
    EXECUTE $pol$
      CREATE POLICY tenant_scope ON dial_job AS PERMISSIVE FOR ALL TO sv_tenant
        USING (
          "org_id" IS NOT NULL
          AND "org_id"::text = NULLIF(current_setting('app.org_id', true), '')::text
        )
        WITH CHECK (
          "org_id" IS NOT NULL
          AND "org_id"::text = NULLIF(current_setting('app.org_id', true), '')::text
        )
    $pol$;
  END IF;
END
$$;

-- ── 2. The auth tables: RLS on, no permissive policy, so sv_tenant sees none ──
--
-- Enumerated rather than discovered, because "give this table no policy" is not a
-- shape a column query can express: the point is the ABSENCE of one, and a
-- discovery loop that found a table by its tenant column would attach a policy to
-- exactly the tables that must not have one.
--
-- `session`, `member` and `invitation` are the Better Auth tenant tables.
-- `user`, `account`, `verification`, `twoFactor`, `rateLimit` and `organization`
-- are included for the same reason and because they carry the credential columns
-- (password, secret, backupCodes, token) whose exposure is the whole point of
-- this pass.

DO $$
DECLARE
  t TEXT;
  auth_tables TEXT[] := ARRAY[
    'session', 'member', 'invitation',
    'user', 'account', 'verification', 'twoFactor', 'rateLimit', 'organization'
  ];
BEGIN
  FOREACH t IN ARRAY auth_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t AND table_type = 'BASE TABLE'
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      -- No policy is created, deliberately. A table with row security enabled and
      -- no permissive policy matches nothing for a non-exempt role, which is the
      -- default-deny this pass is after.
      EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I', t);
    END IF;
  END LOOP;
END
$$;

-- ── 3. EmailOutbox / EmailInbound: the boundary their own comments claim ───────

ALTER TABLE "EmailOutbox" ADD COLUMN IF NOT EXISTS "orgId" TEXT;
ALTER TABLE "EmailInbound" ADD COLUMN IF NOT EXISTS "orgId" TEXT;

CREATE INDEX IF NOT EXISTS "EmailOutbox_orgId_createdAt_idx"
  ON "EmailOutbox" ("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "EmailInbound_orgId_receivedAt_idx"
  ON "EmailInbound" ("orgId", "receivedAt");

-- The tenant tables guarded here all spell the column `orgId`, so the loop finds
-- every one of them. That is a statement about the CURRENT state of the schema,
-- not a discovery rule: section 1 handles the one table that does not conform,
-- and this loop would silently skip any table added tomorrow under a different
-- name. `tests/tenancy/rls-enforcement.test.ts` asserts the coverage both ways so
-- that a future snake_case table fails the suite rather than the review.

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