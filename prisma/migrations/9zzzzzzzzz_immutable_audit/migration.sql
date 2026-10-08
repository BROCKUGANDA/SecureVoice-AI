-- Append-only audit log protection.
--
-- Auditors require proof that log rows cannot be modified or deleted after
-- write. This trigger enforces that at the database level so a compromised
-- application credential cannot alter history.

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
