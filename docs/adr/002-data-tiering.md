# ADR-002: Data tiering — Postgres, Pinecone, Redis, Cloudflare R2

## Context

The system needs four different storage properties at once: transactional
consistency for money and case state, similarity search over an institution's own
documents, sub-millisecond counters for rate limiting and abuse detection, and cheap
durable bytes for call recordings. Putting all four in one store is the
convenient option and the wrong one: embeddings in the operational database make every
tenant-scoped row scan wider, and audio in the database makes every backup enormous.

An external blueprint proposed a specific stack for this — Supabase plus `pgvector`
plus Upstash Redis, described as "polyglot persistence". That is close to what runs,
and wrong in two details that matter for a compliance review, so the record below
states the system as built.

## Decision

**Warm, transactional: Postgres.** Cases, interventions, the credit ledger, the audit
chain, the PII vault and tenant membership. Access is `@prisma/adapter-pg`;
row-level security with `FORCE` is applied per tenant table in
`prisma/migrations/9zzzzzzzzzzzzzzzzzzzzzz_tenant_rls` and widened in the coverage
migration, enforced by a role the application assumes with `SET LOCAL ROLE` because
the connecting role is a superuser and would otherwise skip every policy.
`UsageLedger` is append-only and the balance is the sum of it — there is no cached
balance column to drift.

**Vectors: Pinecone, not `pgvector`.** Document chunks are embedded into Pinecone;
`Document.error` carries `pinecone_not_configured` when it is not wired, and the
knowledge-base query degrades to an ungrounded answer rather than failing the call.
The `orgId` filter travels with every query because a vector match that ignores
tenancy is a data breach with good recall.

**Correction to the draft, on evidence:** the deployed box is **OVHcloud `GRA-11`**
(Gravelines, France), and `src/lib/config.ts` deliberately rejects an AWS-style
region name with a readable error. `me-central-1`/`me-central-2` in the blueprint is
not this architecture, and writing it into an ADR would be writing a residency claim
that the infrastructure contradicts. UAE data residency is an _aspiration with a plan_
(see `docs/INFRASTRUCTURE.md`), not a present fact, and this record says so.

**Hot: Redis.** Token buckets for rate limits, the bad-actor strike list, the
distributed lock for the ElevenLabs egress budget, and a semantic cache in
`src/lib/cache.ts` (hashed-ngram embeddings, 0.9 similarity, short TTL). Redis is
optional by design: with `REDIS_URL` unset the guard falls back to an in-process
budget at a tightened ceiling and _logs that it degraded_, rather than pretending to
be distributed.

**Cold: Cloudflare R2.** Archived post-call audio, written by the webhook, presigned
for download at 300 s by default and 900 s maximum, `cache-control: no-store` on the
object. The 30-day retention tier deletes it — and the worker registers the store at
boot, because a policy tier that reports success while objects accumulate is a
compliance failure with a green dashboard.

## Consequences

**Positive.** Each store is the cheapest one that satisfies its own property. Tenancy
is enforced in the database rather than in each query, and the credential-revealing
tables are invisible to the tenant role entirely.

**Negative, stated plainly.** Four stores mean four failure modes, and four places a
deployment can be half-configured. The vector store is the weakest link: with
Pinecone unconfigured the product still works and grounds nothing, which is a
silently degraded behaviour. Backups are per-store and separately restored; there is
no single consistent snapshot of a tenant.

## Evidence

`prisma/schema.prisma` · `prisma/migrations/9zzzzzzzzzzzzzzzzzzzzzz_tenant_rls/` ·
`src/lib/tenancy/db-scope.ts` · `src/lib/billing/ledger.ts` ·
`src/lib/knowledge/documents.ts` · `src/lib/cache.ts` · `src/lib/storage/s3.ts` ·
`src/lib/storage/recordings.ts` · `src/lib/storage/retention-audio-store.ts` ·
`src/lib/privacy/retention.ts` · `src/lib/abuse/bad-actor.ts` ·
`src/lib/elevenlabs/egress.ts` · `docs/INFRASTRUCTURE.md`
