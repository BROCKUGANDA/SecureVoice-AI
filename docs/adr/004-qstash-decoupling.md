# ADR-004: Upstash QStash between the inbound webhook and the dialler

## Context

A bank's fraud decisioning system posts a signal and expects a fast response. It does
not expect — and should not have to wait for — a phone call to be placed, a
transcription socket to open, and an agent to introduce itself.

The failure mode this exists to prevent is specific and expensive: the caller times
out, retries with a fresh idempotency key because it did not get an answer we can
tie to the first attempt, and the customer gets two verification calls about the same
transaction.

## Decision

Accept, then orchestrate. The ingest path validates, checks idempotency, runs the
policy gate, reserves the credit and returns **202 Accepted** with a `requestId` and a
case reference. The dial is a durable job (`DialJob`, `prisma/migrations/2_dial_job`)
dispatched through Upstash QStash — `@upstash/qstash` in `src/lib/queue/qstash.ts` —
and consumed by a worker in this repository, not by a third-party function.

Three properties were non-negotiable, and each is the reason a plain in-process queue
was rejected:

- **Durable across a deploy.** The queue is Postgres rows, so the 65-second graceful
  drain never has to choose between losing work and holding a connection open.
- **Claimed exactly once under concurrency.** Workers take jobs with
  `FOR UPDATE SKIP LOCKED` and a lease; an expired lease is reclaimed by the next
  claimant, so a killed worker costs a delay, not a lost call, and there is no
  orphan sweeper to forget about.
- **Bounded retries with a destination for exhaustion.** Attempts are capped, and an
  exhausted job is dead-lettered **with its error**, because "we stopped calling this
  customer" must be answerable.

QStash's own DLQ is monitored and alerts; when QStash is not configured the dispatcher
falls back to in-process scheduling and _says which mode it is in_, so the topology is
never a guess at 3 a.m.

## Consequences

**Positive.** The bank's timeout budget is never ours to miss. Duplicate signals
collapse at the idempotency layer, and the atomic backstop is a unique index rather
than a read-then-write that can race. A deploy mid-queue is a pause, not a loss.

**Negative, stated plainly.** QStash is a per-request-priced external dependency with
volume limits, and the fallback in-process path is not a second worker — a process
that dies with it loses those jobs. Two queues with different durability guarantees is
a real complexity cost, accepted because the alternative was requiring QStash to exist
before a developer could run the product. The async contract is published
(`GET /asyncapi`, `src/lib/contracts/asyncapi.ts`) so a caller can see the queue
semantics without reading this file.

## Evidence

`src/lib/queue/qstash.ts` · `src/lib/queue/` · `src/worker/dial.ts` ·
`prisma/migrations/2_dial_job/migration.sql` · `src/app/api/v1/interventions/route.ts` ·
`src/lib/credits.ts` (idempotency + reserve) · `src/lib/contracts/asyncapi.ts` ·
`docker-compose.yml` (`dial-worker`, `outbox-worker`) · `docs/VERIFICATION.md` (WP-19)
