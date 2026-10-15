# ADR-007: PII tokenization, per-case key shredding, and a chain that resists editing

## Context

An intervention record legitimately needs a phone number, a name, an amount, a merchant
and a transcript of what the customer said. The transcript is the part that cannot be
trusted to stay clean: a customer will read out their own card number, and a
four-figure group of digits is the pattern every redactor exists for.

The compliance question a Tier-1 bank asks is not "is it encrypted" but "what does an
attacker who reads your database get, and what does an auditor get when a customer
exercises a deletion right". Those two answers pull in opposite directions, and a
design that ignores the second one gets deleted by a legal review.

## Decision

**Tokenize at the boundary.** Raw sensitive values are written only to
`src/lib/compliance/pii-vault.ts` (`pii_vault`, encrypted); the intervention row keeps
the token. Detokenization happens at the moment of execution — dialling the number —
not for display, and never for the prompt. The contract states the PII list that is
`neverSent` to the model and the OpenAPI schema carries it, so the guarantee is
machine-checkable rather than aspirational.

**Tokenization needed a way to be found first (amendment, 2026-10-15).** As written,
the decision was aspirational in one specific way: `storePii()` minted a random uuid
and only `resolvePii()` ever read it, so nothing could ask the vault "do you already
hold this number?" — and two live paths *must* ask exactly that. An inbound SMS reply
matches a customer's YES or NO to the alert it answers, and an inbound voice callback
finds the open case the caller is ringing back about. Both arrive with a phone number
and no tenant. They therefore matched on `Case.phone`, which meant the plaintext column
was load-bearing, meant `createCase` kept writing the number, and meant a vault that
existed but protected nothing the platform actually stored.

The fix is a blind index — HMAC-SHA256 over the normalised value under a key derived
from `AUTH_SECRET` in its own domain (`sv-blind:`, deliberately not the sealing key:
an index derivable from the encryption key lets a leaked database confirm guesses
without decrypting anything) — and it is **two different indexes**, because the two
jobs are different:

| | message | purpose | on |
|---|---|---|---|
| `pii_vault.blindIndex` | `orgId\|type\|value` | dedupe one tenant's copies so re-sealing returns the same token | vault |
| `Case.phoneIndex` | `type\|value` | let a tenant-less reply find its case | case row |

The org is in the vault's message and *not* in the case's, and that is the whole
trade-off: an org-scoped case index cannot be computed by the paths that have no org,
and an org-free one lets a reader with full database access group rows by customer.
What that reader already had, before this change, was the numbers themselves, in the
clear, one per row — so the pseudonym is strictly less exposed than the thing it
replaces, and it is what allows the plaintext to go. RLS still confines every
application read to one tenant's rows.

`createCase` now seals the destination before inserting: a new case carries a token and
an index and no readable number. When sealing is impossible — a deployment with no
`AUTH_SECRET`, or a row with no tenant to store it under — the number stays on the row
and the row is visibly un-tokenized (`customerPhoneToken IS NULL`), because the
alternative is a case with no destination and a fraud alert that never rings. A
degradation that lies about itself would be the worse bug.

Erasure follows the data: `phone`, `phoneIndex` and `customerPhoneToken` are in
`CASE_PAYLOAD_COLUMNS`, and `shredVaultRow` deletes the sealed value once no case
references it. Moving a number out of an erased column and into a table erasure never
touches is not erasure; the shared-token case (one tenant, repeat customer) keeps the
row until the last reference is gone, so one customer's request cannot delete another's
data.

**Historical rows are a separate, operator-run step.** `scripts/backfill-case-phone-vault.ts`
(`bun run pii:backfill`) is dry-run by default and needs `--apply`, and it is scoped by
`--org` so a rollout can start with one tenant. It is not in the migration: SQL cannot
seal anything, because the key lives in the application's environment, not in the
database. Rows it reports as `skippedNoOrg` cannot be vaulted at all, and the legacy
`phone` arm of `casePhoneWhere` must stay until it reports `pending: 0` — a missed NO
reply is a customer reporting a live fraud loss into a platform that answered "no open
alert".

**Redact in the speech path, both directions.** Inbound transcript text and outbound
spoken text pass `redactPII`, and the ordering is fixed and tested: spoken-text
conversion, verification-token refusal, numbers-as-words, vishing check, redaction,
Shariah terms, word cap, vishing re-check. Moving one step earlier is a live
regression, which is why it is a gate.

**Encrypt at rest with a key that can be destroyed.** AES-256-GCM envelopes under a
per-case data key, wrapped by `PRIVACY_MASTER_KEY`. Retention then does the thing that
satisfies both questions: transcripts at 90 days are **crypto-shredded** — the case's
data key is deleted, so the ciphertext remains and is unreadable — because editing or
deleting the row would rewrite the audit chain it is sealed into.
`assertRetentionMutationAllowed` refuses _any_ column write to `AuditLog`, including
the tempting "just drop redactedText", and the refusal is a code path with a test, not
a comment.

**Auditable and append-only, at the database layer.** `AuditLog` rows are hash-chained
(`chainHash` unique, `prevHash` linking), so a rewrite is detectable and
`verifyChain` names the broken row. Prevention is enforced where a superuser cannot be
constrained by grants: a `BEFORE UPDATE OR DELETE` trigger that raises, plus
`REVOKE UPDATE, DELETE` for the tenant role, with a gate that runs with the trigger
live and proves both halves.

**Correction to the external draft, on evidence.** It supplied SQL to run against
`audit_logs` — a table that does not exist here — with a `BEFORE INSERT` trigger
computing the chain in PL/pgSQL. Two problems. The chain hash covers a canonical
serialization built in the application
(`src/lib/audit-chain.ts`: `sha256(prevHash || canonical(sorted-keys))` over the entry,
`meta` handled as an object), which a database trigger cannot reproduce; and
`log_audit_event()` would compute `NEW.org_id || NEW.action || …` with `||` as string
concatenation over columns that are nullable in this schema — a silent NULL swallower,
and unverifiable after the fact. Hashing lives in the app for the same reason the
word cap lives in the app: it has to agree byte-for-byte with the verifier.

## Consequences

**Positive.** A database read yields tokens and ciphertext. An erasure request can be
honoured without touching an append-only log, and the log still proves a call happened
and a key was destroyed. Redaction is enforced in code that is tested, in six
languages, rather than by a prompt asking the model to be careful.

**Negative, stated plainly.** Detokenization is an extra lookup inside the dial path,
and there is no cache in front of it, so the vault is on the critical path of the one
operation that must be fast. Crypto-shredding does not shrink storage and does not
remove data subject to a legal hold — it removes the ability to read it, which is the
right answer for most of these regimes and the wrong one for a preservation order.
The chain is only as trustworthy as the head: a `TRUNCATE` by the owning role is
detectable as a missing head, not prevented by a row trigger, and this record says so
in the same sentence as the control.

Added by the amendment: every case write now costs a seal (an AES-GCM encrypt plus an
indexed insert-or-conflict), so the vault has moved from the read path into the write
path of ingest; `AUTH_SECRET` has become load-bearing for case creation, and a
deployment missing it silently degrades to plaintext (logged, and visible as a NULL
token, but degraded). The org-free `Case.phoneIndex` is a correlation surface for a
full-database reader, argued above and not hidden. And until the backfill has run with
an operator watching, production holds both shapes at once: new rows tokenized, the
85 existing ones still carrying the number, which is precisely why `casePhoneWhere`
still ORs the legacy column instead of pretending the migration happened.

## Evidence

`src/lib/compliance/pii-vault.ts` (`blindIndexOf`, `vaultCasePhone`, `casePhoneWhere`) ·
`src/lib/case-state-machine.ts` (`createCase` seals before it inserts) ·
`src/lib/sms-verdict.ts` and `src/app/api/twilio/inbound-voice/route.ts` (the two
tenant-less lookups) · `src/lib/privacy/crypto-shred.ts` (`shredVaultRow`) ·
`scripts/backfill-case-phone-vault.ts` ·
`prisma/migrations/9zzzzzzzzzzzzzzzzzzzzzzzzzzzz_pii_vault_blind_index/` ·
`tests/privacy/pii-vault-blind-index.test.ts` (18 cases; mutation-proved: writing the
caller's plaintext back fails 2, dropping the index arm fails 4, skipping the vault
shred fails 2) ·
`prisma/migrations/9zzzzzzzzz_pii_vault/` ·
`src/lib/privacy/retention.ts` ·
`src/lib/audit-chain.ts` · `prisma/migrations/9zzzzzzzzz_immutable_audit/` ·
`prisma/migrations/9zzzzzzzzzzzzzzzzzzzzzzzzz_audit_immutability_grants/` ·
`src/lib/compliance/redactor.ts` · `src/lib/compliance/gate.ts` ·
`src/lib/contracts/schema.ts` (`neverSent`) · `tests/tenancy/audit-immutability.test.ts` ·
`tests/docs/error-catalogue-page.test.ts` · `src/lib/compliance/speech-gate.ts` · `docs/TRUST-MODEL.md`
