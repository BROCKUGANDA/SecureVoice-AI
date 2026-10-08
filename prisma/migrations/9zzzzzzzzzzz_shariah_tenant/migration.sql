-- Shariah-compliant tenant flag.
--
-- The speech gate substitutes Islamic financial terminology (interest ->
-- profit rate, insurance -> takaful, premium -> contribution) before text is
-- synthesised. That substitution is correct for an Islamic bank or a takaful
-- operator and factually wrong for a conventional one, because it renames the
-- product the customer actually holds. It is therefore opt-in per tenant, not
-- global, and it defaults off.

ALTER TABLE "organization"
  ADD COLUMN IF NOT EXISTS "shariahCompliant" BOOLEAN NOT NULL DEFAULT false;
