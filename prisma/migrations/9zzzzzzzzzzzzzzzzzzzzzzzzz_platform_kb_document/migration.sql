-- Per-Document linkage to the ElevenLabs PLATFORM knowledge base.
--
-- The tenant RAG plane (Pinecone) grounds a draft; the conversation plane's own
-- `knowledge_base` list is what lets the live agent quote the bank's policy
-- without a vector query. Publishing a document there returns a vendor document
-- id, and that id has to survive the process that made the call: without it,
-- every QStash retry and every operator Retry of the same row would POST a second
-- copy of one policy onto the agent. `platformDocId` is therefore the idempotency
-- record, and the retry path PATCHes the document it names instead of creating.
--
-- `platformError` is a second column rather than a reuse of `error` because the
-- two failures mean opposite things to an operator. `error` says "this document
-- did not embed" and renders beside a Retry button that re-embeds the PDF; a row
-- that embedded fine but failed to reach the platform must not be shown as broken
-- RAG, and must not be shown as nothing at all either.
--
-- Both are nullable and additive: every existing row simply has no platform
-- document, which is exactly what a deployment that has not set KB_PLATFORM_SYNC
-- has today. No backfill, no downtime, no behaviour change until the flag is on.

ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "platformDocId" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "platformError" TEXT;
