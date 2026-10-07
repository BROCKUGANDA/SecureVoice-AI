-- The Twilio call leg sid for warm transfer.
--
-- ALL CHANGES ARE ADDITIVE (naming follows the lexicographic constraint in
-- 9zzzz_call_categories; `call_sid` sorts after `call_categories` so this
-- applies after that migration on a fresh database).
--
-- The dial worker already receives `callSid` from the ElevenLabs outbound-call
-- response but only ever persisted `conversation_id`. The warm_transfer agent
-- tool needs the TWILIO leg id: updating it with new TwiML is the one way to
-- bridge the customer to a live human mid-call.

ALTER TABLE "Case" ADD COLUMN "callSid" TEXT;
