-- Reachability: what happens when the voice call does not reach a human.
--
-- NOTE ON THE DIRECTORY NAME. Migrations apply in LEXICOGRAPHIC order, so `10_`
-- would sort before `5_better_auth_core` (which creates "organization") and fail
-- on a fresh database. `9zz_` sorts after every `9z_` entry - see
-- 9z_org_agent_binding for the same constraint.
--
-- ALL CHANGES ARE ADDITIVE. Every new "Case" column is nullable and the new
-- "organization" column has a default, so a deploy of this migration under the
-- previous application build is safe: the old build simply never reads them.

-- 1. The blind-ping SMS.
--
--    `cardLast4` lets the customer recognise the alert without the SMS carrying
--    a merchant or an amount (SMS is unencrypted and lands on lock screens).
--    `smsSentAt` anchors the 24h reply window and is what the expiry sweep keys
--    on. `signalKind` records what kind of risk signal opened the case so an
--    insurer's claim-payout alert is not described as a card transaction.
ALTER TABLE "Case" ADD COLUMN "cardLast4" TEXT;
ALTER TABLE "Case" ADD COLUMN "signalKind" TEXT;
ALTER TABLE "Case" ADD COLUMN "smsSentAt" TIMESTAMP(3);

-- 2. How a case was resolved, for the bank's outbound event. Kept separate from
--    `state` on purpose: the state machine stays the contract the bank already
--    parses, and this field says HOW it got there.
ALTER TABLE "Case" ADD COLUMN "resolutionMethod" TEXT;
ALTER TABLE "Case" ADD COLUMN "customerResponse" TEXT;

-- The inbound-SMS handler finds "the open cases for this phone, newest first".
CREATE INDEX "Case_phone_smsSentAt_idx" ON "Case"("phone", "smsSentAt");

-- 3. STOP / opt-out. A number that replied STOP must never be texted again by
--    this platform, whatever case fires next. Keyed on the E.164 number alone:
--    the opt-out belongs to the person, not to one bank's tenant.
CREATE TABLE "SmsSuppression" (
    "phone" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsSuppression_pkey" PRIMARY KEY ("phone")
);

-- 4. Institution type: a bank and an insurer are both tenants, operators and
--    vendors of this platform, but they speak differently to their customers
--    ("your card" vs "your policy"). Default 'bank' keeps every existing tenant
--    exactly as it was.
ALTER TABLE "organization" ADD COLUMN "institutionType" TEXT NOT NULL DEFAULT 'bank';
