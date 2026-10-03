-- Let the `account` table hold BOTH kinds of credential row.
--
-- `account` is Better Auth's account model, which the Clerk -> Better Auth
-- cutover merged into the pre-existing first-party Account because Prisma model
-- names collide. The two writers populate it differently:
--
--   · First-party path (src/lib/auth/identity.ts createIdentity) writes
--     email / name / role / passwordHash — the scrypt digest the first-party
--     verifier in src/lib/auth/password.ts checks.
--   · Better Auth's own credential sign-up writes ONLY accountId, providerId,
--     userId, password and the timestamps. It has no concept of a first-party
--     email, display name or scrypt column.
--
-- With those three columns NOT NULL, every Better Auth sign-up aborted with a
-- not-null violation while the first-party path kept working — a half-migrated
-- state that looks healthy until someone signs in through the other door. That
-- mattered because the console operator surface resolves identity through
-- `auth.api.getSession()`, so a Better Auth session was the only way in.
--
-- Nullable rather than defaulted on purpose: a `DEFAULT ''` would collide with
-- the unique index on the second Better Auth sign-up, since both rows would
-- carry the same empty email. NULLs are exempt from a unique index in
-- Postgres, which is exactly the semantics wanted — Better Auth-owned rows
-- carry no first-party address and are not first-party Identities.
--
-- getIdentity() already rejects rows without a first-party email/name rather
-- than fabricating a placeholder, so a Better Auth row can never be
-- authenticated as a first-party account.
--
-- `role` stays NOT NULL: it has a default, so Better Auth's insert takes 'demo'
-- without the column being supplied, and no reader needs a null check for it.

ALTER TABLE "account" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "account" ALTER COLUMN "name" DROP NOT NULL;
ALTER TABLE "account" ALTER COLUMN "passwordHash" DROP NOT NULL;