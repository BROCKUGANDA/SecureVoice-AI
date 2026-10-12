# Architecture Decision Records

Eight records of decisions that were actually made in this repository, each traceable
to the code that implements it.

## Why these exist in this shape

An ADR that describes an architecture the repository does not contain is worse than
no ADR: it is a written false statement in the one folder an auditor or a judge reads
to find out how the system was built. Every record here therefore carries an
**Evidence** section, and where a decision was drafted elsewhere first — including in
the external "enterprise checklist" documents this project has been handed — the
record says what the code does instead, and marks the correction.

Three rules, enforced the same way the rest of `docs/` is:

1. **A claim without a file that proves it is not in an ADR.** Cite the module, the
   migration, the workflow, or the gate that keeps it true.
2. **A rejected alternative is recorded with its rejection.** Several of these
   decisions were re-opened by an outside blueprint and declined again on evidence
   (pgvector, Nginx, Vercel, a second audit-log table). The rejection is the part
   worth keeping.
3. **A consequence includes the ones still unpaid.** Each record names what this
   choice now costs — usually a manual step, a single region, or a gate that has to
   be maintained by hand.

## Index

| #                                       | Decision                                           | Status               |
| --------------------------------------- | -------------------------------------------------- | -------------------- |
| [001](001-custom-voice-engine.md)       | Custom Node.js voice engine over Retell/Vapi       | Accepted             |
| [002](002-data-tiering.md)              | Data tiering: Postgres, Pinecone, Redis, R2        | Accepted (corrected) |
| [003](003-jit-authz-soft-freeze.md)     | Just-in-time AuthZ and reversible soft freeze      | Accepted             |
| [004](004-qstash-decoupling.md)         | Upstash QStash between the webhook and the dialler | Accepted             |
| [005](005-paddle-metering.md)           | Paddle as Merchant of Record, own metering ledger  | Accepted             |
| [006](006-better-auth-organizations.md) | Better Auth Organizations, no auth vendor          | Accepted             |
| [007](007-pii-tokenization.md)          | PII tokenization vault and crypto-shredding        | Accepted             |
| [008](008-blue-green-graceful-drain.md) | Blue/green on one box, graceful drain, Caddy       | Accepted (corrected) |

Two subjects that belong here and do not yet have a record, because the decision is
still open: the retention tiers themselves (30/90/2555 days, and why the audit chain
is deliberately outside erasure) and feature flags versus per-tenant entitlements.
Both are recorded as gaps in `docs/TECH-DEBT-LEDGER.md` rather than written up as
settled.
