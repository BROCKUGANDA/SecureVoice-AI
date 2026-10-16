-- Persist the two instants the `signal_received_to_ringing` span needs.
--
-- The public promise this makes measurable is in SPAN_DEFINITIONS
-- (`src/lib/telemetry/spans.ts:48`, "signal received -> ringing", p95 < 5s) and it had
-- no producer, so `evidence/latency/slo.json` reported the leg `not_measured` with zero
-- samples. The gap was not a missing `recordSpan` call — it was that neither endpoint
-- survived the request:
--
--   * the intake handler's arrival instant lived in a local (`const started`), and the
--     only persisted timestamp on the row, `Case.createdAt`, is written inside
--     `createCase`, which runs AFTER the policy, compliance and credit gates. Using it
--     would have measured the dial and silently dropped the gate time — the part of the
--     1.2 s-per-round-trip path that a bank's auditor asks about.
--   * the carrier's `ringing` status arrived at `POST /api/twilio/status` and was
--     folded into the delivery vocabulary as `queued`
--     (`src/lib/telecom-outbox.ts:117-121`), which is correct for an outbox and
--     useless for a latency measurement, because `queued` and `ringing` are different
--     instants and the mapping cannot tell them apart afterwards.
--
-- Both nullable, no default, no backfill: an existing case genuinely has no measured
-- ringing instant, and a column filled with a guess is how a metric starts lying.
-- ADD COLUMN without a default is catalog-only in Postgres, so this does not rewrite
-- the table or hold an ACCESS EXCLUSIVE lock beyond the statement itself.

ALTER TABLE "Case" ADD COLUMN IF NOT EXISTS "signalReceivedAt" TIMESTAMP(3);
ALTER TABLE "Case" ADD COLUMN IF NOT EXISTS "ringingAt" TIMESTAMP(3);

-- The ringing callback resolves its case by the call-leg sid, which already has an
-- index (`9zzzzzzzzzzzzzzzzzzzzzzzzzzzzz_case_callsid_index`), so the compare-and-set
-- in `src/lib/telemetry/ringing.ts` needs no new one.
--
-- `signalReceivedAt` is deliberately unindexed. It is read only as part of the row the
-- sid lookup already returned; an index on it would serve a query nobody has written.
