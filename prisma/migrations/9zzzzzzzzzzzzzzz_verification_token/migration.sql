-- Verification token (Part 8 item 2 — out-of-band anchoring for the CALL).
--
-- One column pair on `Case`, and nothing else in this migration. The migration
-- is separate from the token feature rather than folded into an existing one so
-- that a rollback of the feature does not require reverse-engineering which
-- migration owned which column.
--
-- `verificationTokenHash` holds a SHA-256 of the token, never the token. The
-- plaintext is returned exactly once, to the bank integration that renders it in
-- the customer's app, and is not recoverable from this table.
--
-- Deliberately NOT indexed. Lookups are always by `caseId` (the primary key);
-- an index here would only ever be used by a query that should not exist — one
-- that searched cases by token, which would make the token a bearer credential
-- for enumerating cases.
ALTER TABLE "Case" ADD COLUMN IF NOT EXISTS "verificationTokenHash" TEXT;
ALTER TABLE "Case" ADD COLUMN IF NOT EXISTS "verificationTokenAt" TIMESTAMP(3);

-- The verification token must never be inserted or modified by application code
-- after creation — a mutable token is a token whose whole guarantee depends on
-- when it was read. This mirrors the immutability trigger on AuditLog, applied to
-- the one field that must not drift.
--
-- Scope note: this allows the pair to be SET when previously unset (the normal
-- path is the INSERT in createCase) and refuses any later CHANGE of an
-- already-set token, including clearing it.
--
-- Erasure deliberately does NOT clear it. A `pdpl_erasure` run removes the
-- customer's personal data — name, transcript, payload, the data key — and
-- leaves the hash, because the hash is not personal data: it is a SHA-256 of a
-- word whose plaintext was never stored anywhere, so it cannot identify anyone
-- or be used as a credential. What it does is prove that a token was issued at
-- a moment in time, which is exactly the evidence an auditor wants after the
-- personal data around it is gone. Deleting the case row itself erases the pair
-- along with everything else, and DELETE is not gated by this trigger.
CREATE OR REPLACE FUNCTION prevent_verification_token_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."verificationTokenHash" IS NOT NULL
     AND NEW."verificationTokenHash" IS DISTINCT FROM OLD."verificationTokenHash" THEN
    RAISE EXCEPTION 'Verification tokens are write-once; a set token cannot be changed.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS no_mutate_verification_token ON "Case";
CREATE TRIGGER no_mutate_verification_token
BEFORE UPDATE ON "Case"
FOR EACH ROW EXECUTE FUNCTION prevent_verification_token_mutation();