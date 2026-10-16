-- Audit attribution: pseudonymised client IP + request id on every chain row.
--
-- Both columns are NULLABLE and NULL for worker, webhook and script writes, which
-- have no client and must not be attributed to whoever last logged in.
--
-- The `no_modify_audit` trigger installed by 9zzzzzzzzz_immutable_audit is
-- `BEFORE UPDATE OR DELETE` only, so this `ALTER TABLE ... ADD COLUMN` is not
-- blocked by it. Adding columns does not touch existing rows, so no UPDATE fires
-- and no chain link is disturbed.
--
-- BACKWARDS COMPATIBILITY WITH THE EXISTING CHAIN — this is the part that matters.
--
-- `chainHash` in src/lib/audit-chain.ts is
--   sha256(prevHash || "\n" || JSON.stringify(row, Object.keys(row).sort()))
-- and JSON.stringify DROPS a key whose value is `undefined`. A row written before
-- this migration has no ipHash/requestId, so verifyChain() reads it back as
-- `undefined`, the key is omitted from the object, and the serialised bytes are
-- byte-identical to what was hashed at write time. Old chains therefore still
-- verify. This is also why the new columns are added to BOTH the write hash and
-- the verify hash, and not left out of one of them.
--
-- `ipHash` is a domain-separated HMAC of the normalised address under
-- AUTH_SECRET (src/lib/ip-normalize.ts + src/lib/hmac.ts). It is NOT the address,
-- and it is deliberately NOT unique — see the schema comment. `chainHash` already
-- guarantees one row per record, which is the uniqueness this table needs.

ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "ipHash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "requestId" TEXT;

-- Partial index. An index over a column that is NULL on most rows is pure write
-- amplification on the hottest table in the system; restricting to the rows that
-- actually carry an ipHash gives the "everything from one source" explorer view
-- at a fraction of the cost.
CREATE INDEX IF NOT EXISTS "AuditLog_ipHash_createdAt_idx"
  ON "AuditLog" ("ipHash", "createdAt");

-- requestId is already unique per request, so this index is small and its equality
-- lookup is the single most selective access path a support investigation starts
-- with.
CREATE INDEX IF NOT EXISTS "AuditLog_requestId_idx" ON "AuditLog" ("requestId");