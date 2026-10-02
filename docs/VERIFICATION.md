# Verification Ledger

Every completed gate is appended here with the command, date, and output hash.
This file is a submission artifact — it proves the build was verified, not
just claimed.

---

## WP-1 · Agent configuration as code — PASSED

**Date:** 2026-10-02
**Command:** `bun run agent:apply && bun run agent:snapshot` (run twice)
**Agent:** `agent_3601m3temww9e5eb43z3dtdthzdp` ("SecureVoice Fraud Intervention")
**Version (latest apply):** `agtvrsn_0401m3xcsnyaeqbr5vkf4s6fffsp`

### Gate: idempotency

| Cycle | version_id | snapshot sha256 | divergences |
|---|---|---|---|
| 1 | `agtvrsn_5201m3xcsepdfdeaynyzdty8jn6c` | `587112bd6949baa2002db99b17c76548214f63523498c7678339a876d5d9e3a7` | 0 |
| 2 | `agtvrsn_0401m3xcsnyaeqbr5vkf4s6fffsp` | `587112bd6949baa2002db99b17c76548214f63523498c7678339a876d5d9e3a7` | 0 |

**Result:** identical sha256 across both cycles, zero divergences on every
apply. The agent configuration is fully described by
`agent/securevoice.agent.yaml` and applied deterministically.

### Platform constraints discovered (deviations from the brief, with reasons)

1. **TTS model:** the brief says "Flash v2.5". The platform rejects
   `eleven_flash_v2_5` and `eleven_turbo_v2_5` for agents whose default
   language is English ("English Agents must use turbo or flash v2").
   `eleven_flash_v2` is the lowest-latency v2-class model that supports the
   en/ar/hi preset set. Same model class, same μ-law 8 kHz output.
2. **ASR provider:** the `elevenlabs` (Original ASR) provider has been
   removed from the platform. `scribe_realtime` (Scribe v2) is the only
   supported provider. Same μ-law 8 kHz input format.
3. **Language preset `ur` (Urdu):** not in the platform's preset allowlist
   (en, zh, es, hi, pt, fr, de, ja, ar, ko, id, it, nl, tr, pl, ru, sv, tl,
   ms, ro, uk, el, cs, da, fi, bg, hr, sk, ta, vi, no, hu, pt-br, fil).
   Removed from the preset set; en/ar/hi are the configured presets.

### Tool secret headers

Both webhook tools (`card_freeze`, `human_handoff`) now send
`x-agent-tool-secret` (64-char hex, from `AGENT_TOOL_SECRET` env). Before
this WP the tools had empty `request_headers` — live tool calls would have
401'd against the control plane. Verified by read-back: header present,
length 64.

### Artifacts

- `agent/securevoice.agent.yaml` — the agent definition (single source of truth)
- `scripts/agent-apply.ts` — apply + read-back + deep-diff
- `scripts/agent-snapshot.ts` — canonical snapshot + sha256
- `evidence/agent/snapshot.json` — canonical live config (25,233 bytes)
- `evidence/agent/snapshot.sha256` — `587112bd6949baa2002db99b17c76548214f63523498c7678339a876d5d9e3a7`
- `evidence/agent/version.txt` — latest version_id

---

## WP-2 · Risk signal to dial — PASSED

**Date:** 2026-10-02
**Command:** `bun test tests/e2e/dial.test.ts`
**Result:** 1 pass, 0 fail — p95 signal→provider 551 ms (target < 1500 ms), 20/20 signals dialed, idempotent replay verified, audit chains verified from genesis.

### What was built
- `POST /v1/interventions` — canonical bank-facing endpoint. Strict schema (E.164 phone, ISO-4217 currency, integer minor-unit amount, BCP-47 language, `transaction_ref`, `consent_record_id`), unknown fields rejected, no type coercion.
- `Idempotency-Key` header required; replay returns the stored response with `duplicate: true` and creates nothing.
- Policy gate (`src/lib/policy-gate.ts`) — consent → country allowlist → cooldown → concurrency → spend → credits, fail-fast with typed reason, audited either way.
- Call placement via `POST /v1/convai/twilio/outbound-call` with sanitised `dynamic_variables` and per-case `conversation_config_override` (language, first_message, voice_id).
- `conversation_id` persisted against the case (join key for WP-4).
- `case.dialing` emitted on the realtime channel.
- `src/lib/sanitize-untrusted.ts` — dynamic-variable sanitiser (invariant I-4).

### Latency architecture
- Combined idempotency+consent check: one raw SQL round-trip.
- Audit chain: dedicated Prisma client (`dbAudit`, 5-connection pool) so fire-and-forget appends never starve the hot path.
- Idempotency store: deferred with `setImmediate` so it never blocks the response.
- Cooldown/concurrency: in-memory (no DB round-trip on the hot path).

---

## WP-3 · Server tools guardrail boundary — PASSED

**Date:** 2026-10-02
**Command:** `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/securevoice_test?connection_limit=20 bun test tests/tools/guard.test.ts`
**Result:** 1 pass, 0 fail — p95 tool latency **11 ms over 200 calls** (target < 300 ms; distributions across runs: min 1 / p50 4 / p90 6 / p95 11 / p99 23 / max 26 ms), typed 409 refusals, cross-tool secret 401, audit chains verified from genesis, verify → freeze → handoff happy path.

### Measurement topology (read this before re-running)

The p95 < 300 ms gate assumes the production topology in `docs/HETZNER.md`:
Postgres **co-located with the app**. The dev Supabase database is ~270 ms
round-trip away, which makes the gate physically impossible regardless of
code — one round trip alone is 90 % of the budget. Measured evidence:

| Path | RTT per round trip | p95 over 200 calls |
|---|---|---|
| Co-located Postgres (gate run above) | ~2–6 ms | **11 ms** |
| Remote Supabase, 1-round-trip hot path | 270 ms (raw pg: 268–289 ms) | 304–605 ms |

`tests/preload.ts` honours `TEST_DATABASE_URL`, so the gate runs against a
co-located database when one is provided and falls back to `DATABASE_URL`
(dev Supabase) otherwise. Every other assertion in the suite (refusals,
secrets, audit chains) is topology-independent and passes on either database.

### What was built
- `prisma/schema.prisma` — `Case` model (the conversation↔case join key for the agent tools).
- `src/lib/case-state-machine.ts` — single writer for case state; `TRANSITIONS` table enforces invariant **I-2** (`stage_card_freeze` executable only from `CONFIRMED_FRAUD`).
- `src/lib/tool-guard.ts` — shared `guardToolCall`: auth (`timingSafeEqual` + per-tool allow-list) → case resolution → state precondition. Every refusal is a typed 409/401, never a 500, and every refusal is appended to the audit chain **before** returning.
- Four webhook tools under `src/app/api/elevenlabs/tools/`:
  `card_freeze` (staged-only, commits nothing), `human_handoff`,
  `verify_transaction` (disposition transitions), `switch_language`.
- **Hot path = 1 database round trip.** `switch_language` folds the case
  lookup and the state precondition into the `UPDATE … FROM (CTE) … RETURNING`
  itself instead of a `findFirst` + `update` pair; refusals pay one extra
  round trip only to type the 409. Auth is in-memory (no DB).
- `tests/tools/guard.test.ts` — the gate: 409 refusal codes, cross-tool
  secret, 200-call latency sweep (concurrency 10, pool warmed), audit-chain
  verification of the refusal entry, and the verify → freeze → handoff path.
  Unique `RUN_ID`-suffixed conversation ids so repeated runs never collide.

### Artifacts
- `tests/tools/guard.test.ts` — the WP-3 gate
- `src/lib/tool-guard.ts`, `src/lib/case-state-machine.ts`
- `src/app/api/elevenlabs/tools/*/route.ts` (four tools)

---

## WP-4 · Post-call ingest — PASSED

**Date:** 2026-10-02
**Command:** `bun run test:webhook:inbound` (with `TEST_DATABASE_URL` pointed at the co-located `securevoice_test` Postgres, same as WP-3)
**Result:** 1 pass, 0 fail — 22 assertions, 2.5 s. Forged signature → 401; valid signature with a stale timestamp → 401; exact replay → `duplicate: true` with **zero** additional audit rows; synthetic PAN / OTP / CVV absent from the stored transcript; case advanced `CONFIRMED_FRAUD → NOTIFIED`; audit chain verifies from genesis after ingest (I-6); an uncorrelatable conversation lands in quarantine with a redacted excerpt (never dropped).

### What was built
- `src/app/api/webhooks/elevenlabs/route.ts` — verifies `ElevenLabs-Signature: t=…,v0=…` with the **platform SDK's `constructEvent`** (`@elevenlabs/elevenlabs-js@2.70.0`, installed for this), not a hand-rolled HMAC. A verification failure is a 401 — never a 5xx. The handler then does the minimum: dedupe + persist the delivery, and returns 2xx immediately; all heavy work is fired without `await`.
- `src/lib/elevenlabs/inbound.ts` — processing for `post_call_transcription`, `post_call_audio` and `call_initiation_failure`, handled separately.
  - Transcript is redacted through `src/lib/redact.ts` **before** anything is stored (I-10). The raw payload is never persisted, so a quarantine row can only ever hold a redacted excerpt.
  - Evaluation-criteria results, data-collection results, `call_successful` and the reported call duration are persisted on the case.
  - Billing reconciliation input: `durationSeconds` on the case plus `billing.billed_minutes` in the audit entry — the append-only `UsageLedger` itself arrives with WP-13.
  - Every ingest appends `post_call_ingest` to the audit chain **before** the database mutation, mirroring the WP-3 refusal discipline.
  - The case advances to `NOTIFIED` where the state machine allows it, which is the trigger WP-5 hangs off.
  - Per-row in-process lock, so a redelivery arriving mid-processing cannot double-write or duplicate the audit entry.
- `prisma/schema.prisma` — `Case` gained `postCallAt`, `postCallEventType`, `outcome`, `durationSeconds`, `transcriptRedacted`, `evaluationResults`, `dataCollectionResults`; new `WebhookEvent` (registry + dedupe via unique `(provider, eventType, conversationId, eventTimestamp)`) and `WebhookQuarantine`.
- `GET /api/status` now reports `webhookIngest { configured, lastWebhookAt, fresh24h, pending }` — the "no webhook in 24 h" alarm the brief asks for (hazard H8).
- `drainPendingWebhooks()` surfaces deliveries that were accepted but never processed, so a crash mid-ingest cannot leave a case stuck (hazard H7).
- `scripts/run-tests.mjs` now discovers `*.test.ts` recursively, so the `tests/e2e`, `tests/tools` and `tests/webhooks` gates actually run inside `bun run test`.

### Idempotency (invariant I-7 at the webhook boundary)

The delivery identity is the platform's own envelope — `(provider, eventType, conversationId, eventTimestamp)`, not a hash of the body. A redelivery with the same envelope returns `duplicate: true` and writes nothing; a redelivery of a row that was accepted but failed processing is re-processed, which is what makes the platform's retry ladder useful instead of losing evidence.

### Notes and deviations
- Timestamp freshness is the SDK's 30-minute tolerance. Egress-IP pinning is not configured (documented as optional in the brief).
- Processing runs in-process off the enqueue. That is deliberate for a single-node deploy and is paired with the persisted delivery registry plus `drainPendingWebhooks()`; WP-5's outbox makes the whole egress path durable.
- `ELEVENLABS_WEBHOOK_SECRET` was added to `.env` / `.env.example` with a 64-char hex development value. Production must replace it with the secret ElevenLabs generates for the webhook endpoint.

### Artifacts
- `tests/webhooks/elevenlabs-inbound.test.ts` — the WP-4 gate
- `src/app/api/webhooks/elevenlabs/route.ts`, `src/lib/elevenlabs/inbound.ts`
