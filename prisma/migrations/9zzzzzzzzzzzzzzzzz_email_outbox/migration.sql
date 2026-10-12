-- Transactional email outbox (magic link, invite, password reset).
--
-- A SEPARATE table from OutboxEvent on purpose. OutboxEvent is the signed
-- bank-webhook outbox: every row there assumes a tenant endpoint URL, a signing
-- secret, and a canonical-JSON body. None of those apply to an email. Filing
-- an email there would leave targetUrl either NULL or a lie, and would push a
-- sign-in credential through bank-delivery replay tooling built for a different
-- payload shape.
--
-- The queue exists because all three messages carry a live credential. Under
-- fire-and-forget, a brief Resend outage loses the message permanently and the
-- operator is told "check your inbox" for mail that never left. With a row, the
-- caller sees the send fail (HTTP 503) AND a worker retries with backoff, so a
-- provider blip does not lock an analyst out of a fraud console.
--
-- The magic-link and invite TOKENS ARE NOT STORED. payload holds the template
-- name and non-credential props only; a queued row that outlived its token's
-- expiry would otherwise be a usable credential sitting in the database.
CREATE TABLE "EmailOutbox" (
    "id"            TEXT NOT NULL,
    "kind"          TEXT NOT NULL,
    "toEmail"       TEXT NOT NULL,
    "subject"       TEXT NOT NULL,
    "payload"       TEXT NOT NULL,
    "state"         TEXT NOT NULL DEFAULT 'PENDING',
    "attempts"      INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError"     TEXT,
    "sentAt"        TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

-- The drain query's access path: claim a batch of due work in one statement.
CREATE INDEX "EmailOutbox_state_next_attempt_at_idx" ON "EmailOutbox"("state", "nextAttemptAt");

-- Support question: "did the invite reach this address?" answered without a
-- seq scan over personal data.
CREATE INDEX "EmailOutbox_to_email_idx" ON "EmailOutbox"("toEmail");

-- Retention sweep for sent rows.
CREATE INDEX "EmailOutbox_created_at_idx" ON "EmailOutbox"("createdAt");