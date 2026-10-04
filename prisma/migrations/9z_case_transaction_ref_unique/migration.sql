-- One intervention call per bank transaction: the ATOMIC backstop.
--
-- The policy gate now refuses a repeated transaction_ref (code
-- `transaction_repeat`), but a read cannot settle a race. Two signals carrying
-- DIFFERENT Idempotency-Keys but the SAME transaction_ref can both read "no
-- prior case" and both reach the dial path, and a fraud victim then receives two
-- "your card is frozen" calls about one transaction. That is the exact failure
-- this product exists to prevent, so the race has to be settled by the database.
--
-- Partial index because transactionRef is nullable. Postgres already treats
-- distinct NULLs as non-conflicting under a plain unique constraint, but the
-- partial form states the intent and keeps the index small for rows that predate
-- the field.
--
-- Existing duplicates are resolved BEFORE the index is created, because CREATE
-- UNIQUE INDEX fails outright on duplicate rows. Which row survives is not
-- arbitrary: the EARLIEST case wins, because it is the one that was actually
-- dialled and therefore the one whose audit chain and call recording exist. A
-- later duplicate is a re-send, and deleting it discards a duplicate record
-- rather than the original evidence.
--
-- The deleted rows are written to a quarantine table rather than dropped
-- silently. If a duplicate turns out to have been a distinct real intervention
-- (two banks genuinely transacting with the same reference, which would be a
-- bank-side data problem), the row is recoverable and the incident is provable.

CREATE TABLE IF NOT EXISTS "TransactionRefDuplicate" (
    "id"         TEXT NOT NULL,
    "caseRef"    TEXT NOT NULL,
    "orgId"      TEXT,
    "transactionRef" TEXT,
    "state"      TEXT,
    "conversationId"  TEXT,
    "createdAt"  TIMESTAMP(3),
    "quarantinedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransactionRefDuplicate_pkey" PRIMARY KEY ("id")
);

WITH ranked AS (
    SELECT
        "id",
        "caseRef",
        "orgId",
        "transactionRef",
        "state",
        "conversationId",
        "createdAt",
        ROW_NUMBER() OVER (
            PARTITION BY "orgId", "transactionRef"
            ORDER BY "createdAt" ASC, "id" ASC
        ) AS rn
    FROM "Case"
    WHERE "transactionRef" IS NOT NULL
)
INSERT INTO "TransactionRefDuplicate"
    ("id", "caseRef", "orgId", "transactionRef", "state", "conversationId", "createdAt")
SELECT
    'dup_' || "id", "caseRef", "orgId", "transactionRef", "state", "conversationId", "createdAt"
FROM ranked
WHERE rn > 1;

DELETE FROM "Case"
WHERE "id" IN (SELECT "id" FROM "TransactionRefDuplicate");

CREATE UNIQUE INDEX IF NOT EXISTS "Case_orgId_transactionRef_key"
    ON "Case" ("orgId", "transactionRef")
    WHERE "transactionRef" IS NOT NULL;