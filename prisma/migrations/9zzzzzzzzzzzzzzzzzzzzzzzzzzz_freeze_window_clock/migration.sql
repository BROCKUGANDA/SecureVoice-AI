-- The reversal window had a number and no clock.
--
-- `REVERSAL_WINDOW_SECS` (src/lib/config.ts, default 300) was read by exactly two
-- places, and both of them only put it in a payload: `card-freeze/route.ts`
-- returns `reversal_window_secs` to the agent, and `ai/ai-authz.ts` writes it into
-- the `freeze_staged` audit meta. Nothing stored a deadline, nothing compared a
-- wall clock to one, and nothing fired when it passed. So the sentence the product
-- tells banks — "protective actions are staged and reversible until a second actor
-- commits them" (src/lib/commercial.ts) — described a window that could not close.
-- A staged hold sat in FREEZE_STAGED forever: the case's whole life depended on a
-- specialist noticing an inbox row that nobody was chasing.
--
-- ── Why expiry escalates instead of reversing ─────────────────────────────────
-- The obvious implementation of "the window closed" is to undo the hold, and that
-- would be a lie in both directions. This platform does not write to a bank's core
-- ledger: `case.notified` in src/lib/contracts/schema.ts sends the institution
-- EVIDENCE, and the institution decides what happens to the account. So a staged
-- freeze is a row plus an audit entry plus a paged human — there is no hold at the
-- bank to unfreeze, and a sweep that reported "freeze reversed" would assert an
-- action that never happened, on a financial record, in the one direction a
-- post-incident review reads. Expiry therefore escalates: the hold is marked
-- lapsed, and a human is paged through the same ladder that the staging itself
-- used, with the lapse as the reason.
--
-- ── Why three timestamps and not one flag ─────────────────────────────────────
-- Both outcomes leave the case in ESCALATED, because committing a freeze also
-- moves it there (src/app/api/console/freeze/commit/route.ts). A boolean would make
-- "a specialist held this card" and "nobody acted for five minutes" the same row,
-- which is the distinction the whole control exists to keep. `freezeCommittedAt`
-- also closes the gap that route documented for itself — it previously recorded the
-- commit only in the audit chain, so a case list could not show it without walking
-- the chain. The actor stays in the chain (it carries accountId, email and role);
-- this column carries only the when.
--
-- Existing rows are deliberately left with NULL clocks rather than back-filled from
-- `createdAt`: a case staged before this migration genuinely has no recorded
-- staging time, and inventing one from the row's creation would put a five-minute
-- deadline on holds that are years old — the first sweep after deploy would then
-- escalate every one of them as a burst of pages about decisions that are long
-- settled. They stay as they are; only holds staged by the new code run on a clock.

ALTER TABLE "Case" ADD COLUMN IF NOT EXISTS "freezeStagedAt" TIMESTAMP(3);
ALTER TABLE "Case" ADD COLUMN IF NOT EXISTS "freezeCommittedAt" TIMESTAMP(3);
ALTER TABLE "Case" ADD COLUMN IF NOT EXISTS "freezeLapsedAt" TIMESTAMP(3);

-- The expiry sweep is a platform duty: it runs on the dial worker's tick across
-- every tenant, so it is not served by the tenant-prefixed indexes and would
-- otherwise sequential-scan the case table on the same tick that drains the dial
-- queue.
CREATE INDEX IF NOT EXISTS "Case_state_freezeStagedAt_idx"
  ON "Case" ("state", "freezeStagedAt");
