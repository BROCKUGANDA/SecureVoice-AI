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
