-- Finish the Better Auth cutover on the `user` table, and drop the one orphaned
-- table the dial-queue migration left behind.
--
-- ── user columns ──────────────────────────────────────────────────────────
-- 0_init created `user` in its Clerk shape (id, email, name, createdAt,
-- updatedAt) and no later migration added the columns Better Auth's own user
-- model carries. The gap is not cosmetic: createIdentity() in
-- src/lib/auth/identity.ts creates the backing user with
-- `emailVerified: true`, and the admin() plugin reads and writes banned /
-- banReason / banExpires / role. Every first-party account creation therefore
-- failed on a missing column.
--
-- The table is empty, so this is purely additive. emailVerified is NOT NULL
-- with default false rather than nullable, matching schema.prisma.
--
-- The primary key constraint is renamed to `user_pkey` so it matches the
-- @@map("user") rename performed in migration 5.

ALTER TABLE "user"
    ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "image" TEXT,
    ADD COLUMN "twoFactorEnabled" BOOLEAN DEFAULT false,
    ADD COLUMN "role" TEXT,
    ADD COLUMN "banned" BOOLEAN DEFAULT false,
    ADD COLUMN "banReason" TEXT,
    ADD COLUMN "banExpires" TIMESTAMP(3);

ALTER TABLE "user" RENAME CONSTRAINT "User_pkey" TO "user_pkey";

-- ── orphaned DialJob ──────────────────────────────────────────────────────
-- 4_dialqueue created a table literally named "DialJob" with snake_case body
-- columns (case_ref, attempt_no, lease_expires_at). schema.prisma maps the
-- DialJob model to "dial_job" via @@map, and 2_dial_job already created and
-- owns "dial_job", which is where Prisma has always read and written. The
-- "DialJob" table is therefore unreachable through the ORM: nothing selects
-- from it and nothing inserts into it. It is dead weight that keeps the schema
-- and database permanently out of sync.
--
-- Dropped rather than left in place. Nothing references it (no foreign keys
-- point at it), and the pre-migration backup restores it if it is ever wanted.

DROP TABLE "DialJob";