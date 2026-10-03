-- Reconcile the two remaining Clerk-era tables with the Better Auth datamodel.
--
-- The application code was already migrated: identity.ts creates a `user` row
-- and attaches a "credential" Account to it, and credits.ts / tts-quota.ts /
-- console/settings all key UserProfile lookups on `userId`. Only the database
-- was still Clerk-shaped, so every read of Account or UserProfile raised a
-- missing-column error and no operator could sign in.
--
-- ── UserProfile ───────────────────────────────────────────────────────────
-- 0_init created this table with `clerkUserId TEXT NOT NULL UNIQUE`, holding
-- Clerk user ids like "user_3J3Lfk4hzKz2MsVGp2Nj1DYGbDj". schema.prisma
-- declares `userId UUID` with a foreign key to the Better Auth `user` row.
--
-- The existing rows cannot be carried across and are dropped rather than
-- coerced. Two facts force it: a Clerk id is not a valid uuid, so the type
-- conversion is impossible; and the `user` table is empty, so those rows point
-- at identities that no longer exist and would become dangling the moment the
-- foreign key was added. They are leftovers of a provider that is gone, and
-- UserProfile rows are re-created on first sign-in (credits.ts upserts by
-- userId), so nothing is lost that cannot be regenerated.
--
-- `orgId` also moves text -> uuid for the same reason: it now references the
-- Better Auth `organization` row, and hazard AU-3 makes the organization the
-- tenant identity.

-- 0_init created the uniqueness as a bare unique INDEX rather than a table
-- constraint, so it has to be dropped as an index. DROP CONSTRAINT fails here
-- with 42704.
DROP INDEX "UserProfile_clerkUserId_key";
DELETE FROM "UserProfile";

ALTER TABLE "UserProfile" DROP COLUMN "clerkUserId";

ALTER TABLE "UserProfile" ADD COLUMN "userId" UUID NOT NULL;
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

ALTER TABLE "UserProfile"
    ALTER COLUMN "orgId" TYPE uuid USING ("orgId"::uuid);

ALTER TABLE "UserProfile"
    ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserProfile"
    ADD CONSTRAINT "UserProfile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Account ───────────────────────────────────────────────────────────────
-- The same cutover left Account holding only the first-party columns (email,
-- name, role, passwordHash, createdAt) while schema.prisma declares it as the
-- union of those and Better Auth's credential columns. Prisma has been
-- emitting `INSERT ... ("accountId","providerId","userId",...)` against those
-- names for the whole of the Better Auth era.
--
-- The table holds zero rows on every deployment, so this is purely additive and
-- no data migration is involved. `userId` is added NOT NULL with no default
-- rather than with a fabricated one: a credential Account without a real User
-- is a state this codebase cannot represent, and createIdentity() always
-- supplies the nested user.
--
-- The rename is the same repair as migration 5: @@map("account") has been in
-- schema.prisma all along, so Prisma has been querying a lowercase table name
-- that did not exist.
--
-- The DELETE below is what makes the four NOT NULL ADDs that follow actually
-- runnable against a database that has rows. `ADD COLUMN ... NOT NULL` with no
-- DEFAULT fails outright on a non-empty table (SQLSTATE 23502), and these rows
-- cannot be carried across anyway: they have no `userId`, and the foreign key
-- added at the end of this migration requires one, while `createIdentity()`
-- always creates the backing user and the scrypt verifier is re-seedable. The
-- rows present in the wild were test fixtures (@wp11.test) left by a test run
-- against a shared database. Same reasoning as the UserProfile DELETE above,
-- and covered by the same re-invite decision.
DELETE FROM "Account";

ALTER TABLE "Account" RENAME TO "account";
ALTER INDEX "Account_email_key" RENAME TO "account_email_key";
ALTER INDEX "Account_pkey" RENAME TO "account_pkey";

ALTER TABLE "account" ADD COLUMN "accountId" TEXT NOT NULL;
ALTER TABLE "account" ADD COLUMN "providerId" TEXT NOT NULL;
ALTER TABLE "account" ADD COLUMN "userId" UUID NOT NULL;
ALTER TABLE "account" ADD COLUMN "accessToken" TEXT;
ALTER TABLE "account" ADD COLUMN "refreshToken" TEXT;
ALTER TABLE "account" ADD COLUMN "idToken" TEXT;
ALTER TABLE "account" ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "account" ADD COLUMN "refreshTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "account" ADD COLUMN "scope" TEXT;
ALTER TABLE "account" ADD COLUMN "password" TEXT;
ALTER TABLE "account" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL;

CREATE INDEX "account_userId_idx" ON "account"("userId");

ALTER TABLE "account"
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;