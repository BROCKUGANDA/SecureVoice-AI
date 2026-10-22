-- Per-intervention callback URL supplied by the bank at ingest.
-- The ingest route validates HTTPS + SSRF before writing it; the outbox
-- delivery re-validates the stored target before every POST.
ALTER TABLE "Case" ADD COLUMN "callbackUrl" TEXT;
