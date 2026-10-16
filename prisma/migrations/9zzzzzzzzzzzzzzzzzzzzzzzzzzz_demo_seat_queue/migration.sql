-- Demo sign-in queue: bounded concurrent guided-demo sessions.
--
-- The one-click demo credential is public, so entry is gated by a seat lease:
-- a (ipHash, deviceId) pair holds either an ACTIVE lease or a QUEUED ticket,
-- promoted FIFO. See src/lib/demo-queue.ts for the state machine.
--
-- No orgId by design (the queue gates entry before any tenant exists), so no
-- tenant RLS policy: same precedent as PilotRequest, which carries no policy
-- in 9zzzzzzzzzzzzzzzzzzzzzz_tenant_rls. The IP is stored hashed only.
--
-- IF NOT EXISTS throughout: a partially-applied run must be re-runnable, and
-- the table must never fail `migrate deploy` on a database that already has it.
CREATE TABLE IF NOT EXISTS "DemoSeat" (
    "id" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoSeat_pkey" PRIMARY KEY ("id")
);

-- NOTE: no unique index here. The live-row backstop is a PARTIAL unique index
-- added by the LATER migration 9zzzzzzzzzzzzzzzzzzzzzzzzzzzz_demo_seat_live_unique:
--   CREATE UNIQUE INDEX ... ON "DemoSeat" ("ipHash","deviceId")
--     WHERE "status" IN ('active','queued');
-- A plain @@unique([ipHash, deviceId, status]) was tried first and removed: it
-- permitted only one "released" row per pair, so the sweep's bulk
-- status->'released' update violated its own index (P2002 swallowed by design),
-- killing the sweeper silently and permanently. Prisma cannot express a partial
-- index, so it lives in SQL only — kept separate so this file stays a pure
-- table creation that any later constraint can build on.
--
-- Promotion scan (oldest queued first) and the active-count check.
CREATE INDEX IF NOT EXISTS "DemoSeat_status_createdAt_idx" ON "DemoSeat"("status", "createdAt");

-- Lease lookup for a signed-in demo session (getProfile) and sign-out release.
CREATE INDEX IF NOT EXISTS "DemoSeat_userId_idx" ON "DemoSeat"("userId");
