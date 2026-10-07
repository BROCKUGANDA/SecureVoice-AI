-- Call categories + the voice do-not-call registry.
--
-- ALL CHANGES ARE ADDITIVE (see 9zz_unreachable_resolution for the lexicographic
-- naming constraint that puts this after every 9z_ migration: `10_` would sort
-- before `5_better_auth_core` and fail on a fresh database).
--
-- `callCategory` records WHY the institution is calling (fact_finding |
-- sensitive_case | b2b | routine | time_critical_fraud). Nullable by design: a
-- case that predates the router — or a producer that declares nothing — reads
-- as the audited default (time_critical_fraud) in code, never as an empty
-- prompt. The category is what selects the agent's system prompt and the
-- preconditions the backend enforces before the dial.

ALTER TABLE "Case" ADD COLUMN "callCategory" TEXT;

-- The voice do-not-call registry: numbers that must not receive routine or
-- non-critical outbound calls. Keyed by E.164 like "SmsSuppression", with the
-- reason kept for the audit narrative. Time-critical fraud verification —
-- which is consent-record-backed and in the customer's interest — is
-- deliberately not gated on this table.
CREATE TABLE "DoNotCall" (
    "phone" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoNotCall_pkey" PRIMARY KEY ("phone")
);
