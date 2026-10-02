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

The p95 < 300 ms gate assumes the production topology in `docs/DEPLOY.md`:
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

---

## WP-5 · Outbound bank notification — PASSED

**Date:** 2026-10-02
**Command:** `bun run test:webhook:outbound`
**Result:** 1 pass, 0 fail — 50 assertions, ~300 ms. Delivery survives a receiver returning **500 three times** and lands on the fourth; the retry ladder is backoff-jittered (`nextAttemptAt` moves into the future, first step 60 s); a sixth failure **dead-letters** the event; the **dead-letter replay produces exactly one additional delivery** and a second replay of the same letter is refused; the signature verifies in a **second language implementation (CPython)** — and rejects a forged signature and a tampered body there too; the state transition and the outbox row commit in one transaction; our own receiver accepts a real delivery, records it once, and 401s a forgery.

### What was built
- `src/lib/outbox.ts` — the whole egress path.
  - **Transactional outbox.** `enqueueOutbox(tx, …)` takes the *transaction client*, so the case transition and the delivery row commit together. `case-state-machine.ts` gains `transitionCaseWithOutbox()` as the only sanctioned way to publish a verdict; WP-4's `NOTIFIED` transition now goes through it. No request handler ever awaits a `fetch`.
  - **`FOR UPDATE SKIP LOCKED` claiming** — N workers drain concurrently with no distributed lock, and a killed worker's lease is reclaimed by a stale-`SENDING` sweep.
  - **Retry ladder** `60s · 5m · 30m · 2h · 3h · 12h` (±20% jitter), six attempts over ~24 h, then `DEAD` plus a `DeadLetter` row. Replay is an admin action that re-queues exactly once.
  - **Signing**: `SV-Signature: t={unix},v1={hex}` where `v1 = HMAC-SHA256({t}.{canonical_body})`, computed at delivery time over the exact bytes sent. Bodies are sorted-key canonical JSON, so signer and verifier agree byte-for-byte.
  - **Payload discipline** (hazard H28): events carry the verdict, `case_ref`, `event_id` (stable across retries — the bank's dedupe key) and an audit reference. No transcript content, ever.
- `scripts/outbox-worker.ts` (`bun run outbox:work`) — cron-friendly (`--once`) or loop mode; the only code that performs delivery network I/O.
- `POST /api/webhooks/receiver` — our own bank-side receiver: reads raw bytes, verifies the signature, records the delivery.
- **`/inspector`** — the demo surface the brief asks us to own rather than outsource to a third-party site: raw payload, signature header, and a green/red verdict **recomputed server-side** (the secret never reaches the browser). Operator-gated.
- `POST /api/console/outbox/replay` — operator-only manual dead-letter replay; `GET` lists dead letters.
- Reference verifiers shipped in-repo and **both executed by the gate**: `scripts/verify_sv_signature.ts` and `scripts/verify_sv_signature.py`. Snippets for both languages are published in the README.

### Isolation fix found by the gate
The first full-suite run failed while the gate passed standalone: `claimBatch` claims the oldest *due* row, and WP-4 legitimately leaves a `PENDING` verdict it never delivers. The gate now drains the shared queue on entry and asserts it claimed its own event by id, so it measures what it creates rather than whatever is next in line.

### Notes and deviations
- The gate **fails** when no Python interpreter is found rather than skipping the cross-language check. On this machine it resolves to the bundled CPython 3.13; set `PYTHON` to override.
- Java is deliberately **not** in this package — the brief names it as a WP-17 integration artifact, and a third implementation adds little while the sprint still owes WP-6 through WP-24.
- `BANK_WEBHOOK_SECRET` / `BANK_WEBHOOK_URL` were added to `.env` and `.env.example`; the URL defaults to our own receiver so the demo needs no external service.

### Artifacts
- `tests/webhooks/outbound.test.ts` — the WP-5 gate
- `src/lib/outbox.ts`, `src/lib/case-state-machine.ts` (`transitionCaseWithOutbox`)
- `src/app/api/webhooks/receiver/route.ts`, `src/app/api/console/outbox/replay/route.ts`
- `src/app/inspector/page.tsx`, `src/components/inspector/Inspector.tsx`
- `scripts/outbox-worker.ts`, `scripts/verify_sv_signature.ts`, `scripts/verify_sv_signature.py`

---

## Suite status at this point

`bun run test` — all green (one process per file, co-located Postgres):

| Gate | Result |
|---|---|
| WP-2 risk signal → dial | 1 pass — p95 signal→provider 551 ms (< 1500 ms) |
| WP-3 server tools | 1 pass — p95 11 ms over 200 calls (< 300 ms) |
| WP-4 post-call ingest | 1 pass — forged rejected, replay idempotent, OTP redacted, chain verifies |
| WP-5 outbound notification | 1 pass — retries, dead-letter, single replay, cross-language signature |
| WP-20 realtime slice | 1 pass — tenancy, resume, inbox dedupe, ack-escalation; cross-node **verified** over Redis |
| flag/feature suites | 30 pass |

`bunx tsc --noEmit` clean; `bun run build` succeeds with `/inspector`, `/api/webhooks/elevenlabs`, `/api/webhooks/receiver` and `/api/console/outbox/replay` registered.

---

## WP-20 · Realtime and notifications (sprint slice) — PASSED with one item unverified

**Date:** 2026-10-02
**Commands:** `bun run test:realtime` · `cd mini-services/realtime && bun test`
**Result:** 1 pass, 0 fail — 40 assertions. Org B never receives Org A's events; a client that missed three events replays **every one** of them on reconnect; a burst of 8 alerts collapses into ONE inbox item with `count: 8`; an unacknowledged page advances `fraud_oncall → fraud_desk → head_of_risk → exhausted`, an acknowledged one never advances, and every hop verifies in the audit chain. Realtime service: 48 pass, 0 fail across 5 files, three consecutive clean runs.

### What was built
- **Resumability, tested where it is used.** The activity feed's read model moved out of the SSE handler into `src/lib/activity-feed.ts`, so the shipped query — not a copy of it — is what the gate exercises. The cursor is `(createdAt, id)`, because two rows can share a millisecond and a timestamp-only cursor silently drops the second. The test asserts exactly that case.
- **Tenancy as a required argument.** `fetchActivitySince({ scope })` takes an `OrgScope`; there is no "unscoped" call to forget. Org-less sessions get the default rows only, asserted in the gate.
- **In-app inbox + severity routing + acknowledgement-driven escalation** (`src/lib/notifications.ts`, `Notification` table). Alerts dedupe on `{orgId}:{alertType}:{window}` and increment a count, so a smishing wave is one alert carrying the real number. Escalation advances through a contact ladder on SLA expiry and stops permanently on acknowledgement; each hop is written to the audit chain, because "we paged on-call and nobody came" is a post-incident-review fact.
- **`GET/POST /api/console/inbox`** — org-scoped list, acknowledge. Cross-org ids return **404, never 403** (a 403 confirms existence).
- **Honest connection state** (`src/lib/connection-state.ts`): `live` / `reconnecting` / `stale since HH:MM`, where a reconnect alone does **not** promote the UI to "live" — only a received event does. A dashboard that looks live while frozen is worse than one that admits it is disconnected.

### Cross-node delivery — VERIFIED (was unverified)

Provisioned a portable Redis 5.0.14 (`redis-server.exe`, loopback only, port 6380, no Docker, no admin) and ran `mini-services/realtime/test/crossnode.test.ts`, which stands up **two real service instances**, connects a client to node B only, ingests into node A, and asserts the event arrives:

```
cross-node delivery verified: ingest on node A -> client on node B
confirmed: without the Redis adapter the event never reaches the other node (silent, no error)
50 pass / 0 fail
```

Both directions are asserted, and both matter:

- **Positive** — with `REDIS_URL` set, `/readyz` on *both* instances reports `pubsub: redis` (the test asserts it, so it cannot pass by accident on a single process), and the event crosses the node boundary.
- **Negative** — with no `REDIS_URL`, two instances both report `single-node` and the client on B receives **nothing, with no error**. That is the hazard itself: a console that silently stops updating looks identical to a quiet day.

The gate refuses to run rather than skip: if `REDIS_URL` is unreachable it prints why and exits non-zero. `node-redis` is pinned to v4 because v6 negotiates RESP3 (`HELLO`), which Redis 5 does not implement.

### Reproducing Redis locally

```
redis-server.exe --port 6380 --save "" --appendonly no     # loopback, no persistence
$env:REDIS_URL="redis://127.0.0.1:6380"
cd mini-services/realtime && bun test                      # includes the cross-node case
```

### Room scoping — already present, now proven
The service derived channels from the org id and validated membership on every join before this package; the gate now proves the tenant property end to end rather than leaving it as a design claim.
