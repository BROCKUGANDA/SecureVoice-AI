ALTER TABLE "Case"
  ADD COLUMN IF NOT EXISTS "customerPhoneToken" TEXT,
  ADD COLUMN IF NOT EXISTS "customerNameToken" TEXT;
