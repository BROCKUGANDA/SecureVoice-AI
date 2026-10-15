-- Give the PII vault a way to be found, and the case table a way to stop holding
-- the value it points at.
--
-- `pii_vault` was write-only in practice. `storePii()` mints a random uuid per call
-- and `resolvePii()` needs that uuid, so a value already in the vault cannot be
-- located by its value — only by the token that was handed out when it was stored.
-- That is what kept `Case.phone` in plaintext: two live paths are handed a
-- customer's number and hold no tenant to scope by, so neither could ask the vault
-- "is this number yours?"
--
--   · an inbound SMS reply (`src/lib/sms-verdict.ts`) matches a YES or a NO to the
--     alert it answers. The reply carries a From number and nothing else — no case
--     reference, no org. A customer whose alert is open and who texts NO is
--     reporting a live fraud loss, and the match is what makes that reach the bank.
--   · an inbound voice callback (`src/app/api/twilio/inbound-voice/route.ts`) finds
--     the open case the caller is ringing back about.
--
-- Both therefore looked cases up by the raw column, which meant the column could
-- not be cleared, which meant the vault protected nothing that mattered.
--
-- ── Two indexes, deliberately different ──────────────────────────────────────
-- `pii_vault.blindIndex` covers `orgId|type|value`: it exists to dedupe within one
-- tenant so re-sealing the same number returns the SAME token instead of
-- accumulating a vault row per case. Keeping the org in the message is the point —
-- a reader of this table cannot use it to learn that one customer banks at two of
-- this platform's tenants, because the same number hashes differently per tenant.
--
-- `Case.phoneIndex` covers `type|value` with NO org. It has to: the paths above
-- have no tenant to hash in. The exposure is the one the plaintext column already
-- granted, row by row and in the clear, to anyone holding the table — grouping by
-- pseudonym is strictly less than reading the number. What it buys is the ability
-- to stop storing the number at all, which is why it is on the case table rather
-- than behind another indirection.
--
-- Both are keyed by HMAC-SHA256 under `sv-blind:` + AUTH_SECRET, a domain separate
-- from the BYOK sealing key, so a leaked database yields neither the values nor a
-- way to test guesses against them without the secret. Existing rows keep NULL
-- indexes and are back-filled by `scripts/backfill-case-phone-vault.ts` — a
-- reversible, audited, dry-run-first operation that is deliberately not run here:
-- SQL in a migration cannot seal anything, because the sealing key lives in the
-- application's environment, not in the database.

ALTER TABLE "pii_vault" ADD COLUMN IF NOT EXISTS "blindIndex" TEXT;

-- NULLs are distinct in a Postgres unique index, so rows sealed before this column
-- existed (all of them) coexist under it.
CREATE UNIQUE INDEX IF NOT EXISTS "pii_vault_org_type_blind_uniq"
  ON "pii_vault" ("orgId", "type", "blindIndex");

ALTER TABLE "Case" ADD COLUMN IF NOT EXISTS "phoneIndex" TEXT;

-- The reply lookup's shape: a number and the 24h window it is answering.
CREATE INDEX IF NOT EXISTS "Case_phoneIndex_smsSentAt_idx"
  ON "Case" ("phoneIndex", "smsSentAt");
