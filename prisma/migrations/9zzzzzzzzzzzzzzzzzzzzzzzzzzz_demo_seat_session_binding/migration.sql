-- DemoSeat: bind the lease to a SESSION, not only to a user.
--
-- WHAT WAS BROKEN
-- ---------------
-- The queue's whole job is to bound how many people hold the published demo
-- credential at once. Seats were stamped with `userId` only, and `leaseForUser()`
-- looked a seat up by that id. But the demo credential is ONE published account, so
-- every admitted browser shares a single `userId`:
--
--   1. Browser A joins the queue, gets a seat, signs in through /api/demo/enter,
--      and seat S1 is stamped with the demo user id.
--   2. Browser B types the same published password into the MANUAL sign-in form.
--      That path never redeems a seat — but `getProfile()` asked "does the demo
--      user hold a live lease?", and the answer was yes: S1.
--
-- So one admitted browser silently admitted every other one, and capacity became
-- N+1 the instant anyone got in. The bound this table exists to enforce was
-- advisory.
--
-- THE FIX
-- -------
-- Stamp the Better Auth session that redeemed the seat, and gate on THAT. N
-- browsers hold N sessions and N seats, up to capacity, exactly as intended; a
-- session holding no seat of its own is refused, so the manual form — which never
-- redeems one — can no longer mint an admitted demo session.
--
-- This does NOT cap concurrency at one. That was the tempting wrong fix (release
-- the previous seat on each new sign-in), and it would have made the second judge
-- to arrive kick the first one out.
--
-- NULLABLE AND NULL on every pre-existing row: those seats were bound under the
-- old rule and cannot be attributed to a session, so they are no longer admitted.
-- That is the correct direction — an unattributable lease is exactly the one the
-- bug made dangerous — and it converges on its own, because the heartbeat TTL
-- releases them.

ALTER TABLE "DemoSeat" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;

CREATE INDEX IF NOT EXISTS "DemoSeat_sessionId_idx" ON "DemoSeat" ("sessionId");