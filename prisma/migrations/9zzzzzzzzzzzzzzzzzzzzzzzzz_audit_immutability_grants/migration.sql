-- Audit immutability: enforce it, and make the enforcement survive the harness.
--
-- `9zzzzzzzzz_immutable_audit` created a BEFORE UPDATE OR DELETE trigger on
-- "AuditLog", and docs/SUBMISSION.md has described the table as append-only ever
-- since. That migration is necessary and, on its own, was not sufficient. Two
-- separate defects made the claim decorative, and neither one produced an error.
--
-- 1. THE ROLE THAT MUST NOT REWRITE HISTORY COULD REWRITE IT.
--    `9zzzzzzzzzzzzzzzzzzzzzz_tenant_rls` grants `sv_tenant`
--    `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public`, and a
--    tenant-scoped transaction (`src/lib/tenancy/db-scope.ts`) runs as exactly
--    that role. The row-level policy therefore restricts WHICH audit rows a
--    tenant reaches — its own, never another's — and says nothing about WHAT it
--    may do to them. A tenant could erase its own frozen-account trail or edit a
--    `redactedText` after the fact. RLS is not the control that was missing;
--    the grants underneath it were the hole.
--
-- 2. THE TRIGGER DID NOT OUTLIVE THE LAST TEST RUN.
--    `tests/preload.ts` disables the trigger so the suites that legitimately
--    mutate "AuditLog" (teardown wipes their seeded rows; the chain gates forge a
--    row to prove `verifyChain()` detects it) can run. `ALTER TABLE ... DISABLE
--    TRIGGER` is persistent TABLE state, not session state — nothing reverts it
--    when the process exits, so any `bun run test` leaves the guard off for every
--    other connection to that database, the application included. Read from the
--    live catalog rather than inferred: `pg_trigger.tgenabled` was `D`.
--
-- ── What this migration does ─────────────────────────────────────────────────
-- a) Re-asserts the function and re-CREATES the trigger. `CREATE TRIGGER` lands
--    ENABLED, so replaying this restores enforcement on a database the harness
--    switched it off on; the `DROP ... IF EXISTS` first keeps a re-apply clean.
-- b) REVOKES UPDATE and DELETE from `sv_tenant` and `PUBLIC`.
--
-- The two mechanisms are not redundant and neither one is a substitute for the
-- other. Grants bind `sv_tenant`, which is what `SET LOCAL ROLE` puts on the
-- tenant path, and they keep binding while the trigger is disabled — they are the
-- half the harness cannot reach. The trigger binds the application role, which is
-- a superuser with `BYPASSRLS` (verified live, `pg_roles.rolsuper = t`), so no
-- grant on this table can constrain it and only a trigger can. Together they cover
-- each other's blind spot; alone each leaves one writer free.
--
-- INSERT and SELECT are deliberately left granted: append-only has to mean a
-- tenant can still append. Revoking the mutating privileges while leaving the
-- append path untested would be an outage dressed up as a control, so
-- `tests/audit/immutability.test.ts` asserts the allow half as loudly as the deny
-- half.
--
-- ── What this does not claim ─────────────────────────────────────────────────
-- TRUNCATE. A row-level trigger never fires for TRUNCATE and Postgres has no
-- event trigger for it, so the owning role can still empty the table and this
-- migration cannot stop that. The exposure is bounded — no other role holds
-- TRUNCATE here, and an emptied chain is a detectable absence of a head row, not
-- a forged history — but it is a limit of the design, not a property the docs may
-- claim away.

CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit logs are immutable and cannot be modified or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS no_modify_audit ON "AuditLog";

CREATE TRIGGER no_modify_audit
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

REVOKE UPDATE, DELETE ON "AuditLog" FROM PUBLIC;
REVOKE UPDATE, DELETE ON "AuditLog" FROM sv_tenant;
