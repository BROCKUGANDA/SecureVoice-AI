-- dial_job: the durable dial queue (WP-19 concurrency and scale).
--
-- WHY THIS TABLE EXISTS
-- The vendor ceiling binds long before our compute does (see docs/CAPACITY.md):
-- a smishing/SIM-swap campaign offers ~2,800 interventions in 40 minutes, which
-- is ~210 concurrent conversations at a 3-minute mean — more than any published
-- ElevenLabs Agents tier allows. The queue is what makes that survivable: every
-- case is durably enqueued first, so refusing a dial is a decision we can record
-- rather than a signal we drop on the floor.
--
-- Four properties this schema is responsible for:
--
--   1. FOR UPDATE SKIP LOCKED claiming. N workers drain this table concurrently
--      with no distributed lock and no row contention: a worker that loses the
--      race simply skips the locked row (src/lib/scale/queue.ts claimDialJobs).
--   2. UNIQUE (case_id, attempt_no). Enqueue is idempotent. A retried signal, a
--      replayed webhook and a queue drain all converge on ONE job per attempt;
--      the unique index is what makes that a database guarantee rather than a
--      promise in a comment.
--   3. Lease expiry. A worker killed mid-call leaves a CLAIMED row. lease_expires_at
--      is the deadline; any worker may reclaim an expired lease (reapExpiredLeases),
--      so a crashed process delays the queue by at most one lease — it does not
--      strand the case.
--   4. Bounded attempts + a dead-letter STATE. `retries` is capped by
--      DIAL_JOB_MAX_ATTEMPTS; past that the row goes to DEAD with last_error set.
--      DEAD is the dead-letter: a customer is never left un-contacted without a
--      row that says so and names why.
--
-- WHY THERE IS NO FOREIGN KEY TO "Case"
-- The queue must outlive a case-row purge (PDPL erasure workflows, a manual
-- operator purge, a retention sweep). A FK would cascade a customer's dial job
-- away — the row that proves we tried to reach them. Referential integrity is
-- enforced by the worker instead: a job whose case cannot be resolved is
-- dead-lettered with reason `case_missing`, never silently dropped.
--
-- `payload` is a JSON string holding SANITISED dial inputs only (destination in
-- E.164, language, merchant, amount) — never transcript content (invariant I-10).
--
-- snake_case table + columns: this model is declared with @@map / @map in
-- schema.prisma (the block to add is reproduced verbatim in
-- src/lib/scale/schema-notes.md — that file is the integration point).

-- CreateTable
CREATE TABLE "dial_job" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "case_ref" TEXT NOT NULL,
    "org_id" TEXT,
    "attempt_no" INTEGER NOT NULL DEFAULT 1,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "payload" TEXT NOT NULL,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMP(3),
    "claimed_by" TEXT,
    "last_error" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dial_job_pkey" PRIMARY KEY ("id")
);

-- The enqueue idempotency guarantee: one job per (case, attempt), enforced by the
-- database. ON CONFLICT DO NOTHING in enqueueDialJobs relies on this index.
CREATE UNIQUE INDEX "dial_job_case_id_attempt_no_key" ON "dial_job"("case_id", "attempt_no");

-- The claim predicate: (state, available_at) for due work, descending priority
-- so the highest expected-loss case is dialled first when we can only do some.
CREATE INDEX "dial_job_state_available_at_priority_idx" ON "dial_job"("state", "available_at", "priority");

-- Lease reclamation: reapExpiredLeases scans exactly this predicate.
CREATE INDEX "dial_job_state_lease_expires_at_idx" ON "dial_job"("state", "lease_expires_at");

-- Operator surfaces: per-case history and the dead-letter list.
CREATE INDEX "dial_job_case_id_idx" ON "dial_job"("case_id");

CREATE INDEX "dial_job_state_created_at_idx" ON "dial_job"("state", "created_at");