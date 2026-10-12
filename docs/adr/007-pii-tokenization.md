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

## Evidence

`src/lib/compliance/pii-vault.ts` · `prisma/schema.prisma` (`@@map("pii_vault")`) ·
`src/lib/privacy/crypto-shred.ts` · `src/lib/privacy/retention.ts` ·
`src/lib/audit-chain.ts` · `prisma/migrations/9zzzzzzzzz_immutable_audit/` ·
`prisma/migrations/9zzzzzzzzzzzzzzzzzzzzzzzzz_audit_immutability_grants/` ·
`src/lib/compliance/redactor.ts` · `src/lib/compliance/gate.ts` ·
`src/lib/contracts/schema.ts` (`neverSent`) · `tests/tenancy/audit-immutability.test.ts` ·
`tests/docs/error-catalogue-page.test.ts` · `src/lib/compliance/speech-gate.ts` · `docs/TRUST-MODEL.md`
