-- DemoSeat live-row uniqueness: a PARTIAL unique index instead of the composite
-- `@@unique([ipHash, deviceId, status])`.
--
-- WHAT WAS BROKEN
-- ---------------
-- The composite unique over (ipHash, deviceId, status) permits exactly ONE row per
-- pair PER STATUS VALUE — including "released". The sweeper in
-- src/lib/demo-queue.ts works by bulk-updating every stale live row to "released":
--
--   db.demoSeat.updateMany({
--     where: { status: { in: ["active","queued"] }, lastSeenAt: { lt: stale } },
--     data:  { status: "released" },
--   })
--
-- That statement's target set can contain BOTH an "active" and a "queued" row for
-- one pair, and once it does, both become "released" and the second one violates the
-- index it is being written under. Prisma raises P2002, `sweep()` swallows it (by
-- design — a sweep failure must not take down sign-in), and the sweeper is now dead
-- for the life of the process. Because sweep() is the ONLY thing that releases an
-- abandoned lease, capacity is never reclaimed again and the demo queue only ever
-- shrinks until every judge sees "queued".
--
-- Reaching that state needs no attacker. One browser tab that closes without
-- signing out, twice from the same address and device id, is enough.
--
-- WHY A PARTIAL INDEX
-- ------------------
-- The property the queue actually depends on is "one LIVE row per pair", so that the
-- check-then-insert join race resolves to a P2002 the handler already catches and
-- re-reads. Released rows are terminal and are pruned wholesale, so their count is
-- irrelevant — except that the old index made it fatal. Restricting the constraint
-- to the live statuses keeps the backstop exactly as strong and removes the failure
-- mode entirely.
--
-- REVERSIBLE: dropping this index restores the old behaviour, which is why it is
-- safe to apply before the code that relies on it ships.

DROP INDEX IF EXISTS "DemoSeat_ipHash_deviceId_status_key";

CREATE UNIQUE INDEX IF NOT EXISTS "DemoSeat_live_pair_key"
  ON "DemoSeat" ("ipHash", "deviceId")
  WHERE "status" IN ('active', 'queued');