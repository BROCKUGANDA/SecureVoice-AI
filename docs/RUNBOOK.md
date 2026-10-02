# Runbook

What to do when each dependency fails, who to call, how to roll back, where the kill switches are.

## Kill switches

| Switch | How to flip | Effect | Recovery |
|---|---|---|---|
| **Global dial halt** | Feature flag `live_dialing` → `false` | No new outbound calls. In-flight calls complete. | Flag → `true`. |
| **Billing spend cap** | Per-org `spend_ceiling` in UsageLedger breaker | Reservations refuse at 100%. Dials shed with audit row. | Increase ceiling or wait for next period. |
| **Outbound webhooks** | Feature flag `outbound_webhooks` → `false` | No bank notifications sent. Outbox keeps accumulating. | Flag → `true`. Worker drains backlog. |
| **LLM phrasing** | Feature flag `llm_phrasing` → `false` | Continuity pipeline uses scripted replies only. | Flag → `true`. |
| **BYOK** | Feature flag `byok` → `false` | New BYOK calls refuse. Existing calls complete. | Flag → `true`. |

All flags are readable at `GET /api/console/features` and flippable without a deploy.

## Health checks

| Endpoint | Question | Consumer |
|---|---|---|
| `GET /healthz` | Is the process alive? No dependency checks. | Container runtime, for restarts |
| `GET /readyz` | Can this instance serve traffic? Migrations applied, pool reachable. | Load balancer, for rotation |
| `GET /api/status` | Full dependency matrix: DB, voice provider, telephony, outbox lag, last webhook | Human operator, status page |

**Do not fail `/readyz` because a shared dependency is unhealthy.** If Postgres degrades and all instances report not-ready, the load balancer removes every backend and a degraded system becomes a total outage. Readiness answers "can I serve?", not "is everything healthy?".

## When a dependency fails

### Postgres unreachable

**Symptom:** `/readyz` returns 503. All requests hang or 503.

**Declared behaviour:** Read-only degraded mode. The console serves from cache. **New interventions are explicitly refused** with 503 and `Retry-After`, because accepting a signal you cannot act on is the worst outcome.

**Action:**
1. Check Postgres process: `docker compose logs db` or `systemctl status postgresql`
2. If down, restart: `docker compose restart db`
3. If the disk is full (`WAL above 70%` alert), free space or expand
4. Verify: `GET /readyz` returns 200

### ElevenLabs (voice provider) unreachable

**Symptom:** Post-call webhooks stop arriving. `/api/status` shows `voiceProvider: degraded`.

**Declared behaviour:** Circuit breaker opens. Failover to the continuity pipeline (built-in STT/LLM/TTS). The degradation ladder steps down and writes an audit row.

**Action:**
1. Check ElevenLabs status page
2. If quota exhausted, top up the workspace or switch to a secondary credential
3. The breaker half-opens after 60s and probes automatically

### Twilio (telephony) unreachable

**Symptom:** Dial jobs fail with `VENDOR_UNAVAILABLE`. Cases transition to `DIAL_FAILED`.

**Declared behaviour:** Cases hold in queue with bounded backoff. After max attempts, dead-lettered with alert.

**Action:**
1. Check Twilio status page
2. Verify account balance and credentials
3. Check carrier geo-lock settings in Twilio console

### Redis unreachable (realtime)

**Symptom:** Console goes stale. Operators don't see live updates.

**Declared behaviour:** Admission control fails **closed** (shed to top band only). Realtime degrades to polling. A system banner is shown.

**Action:**
1. `docker compose restart redis` (if self-hosted)
2. Check managed Redis provider status
3. The system auto-recovers when Redis returns

### Outbox not draining

**Symptom:** `/api/status` shows `outboxLag` increasing. Bank webhooks delayed.

**Declared behaviour:** The outbox worker retries with exponential backoff and jitter over ~24h, then dead-letters.

**Action:**
1. Check worker logs: `docker compose logs app | grep outbox`
2. Manually trigger a drain: `bun run scripts/outbox-worker.ts --once`
3. Check the dead-letter queue: `GET /api/console/outbox/replay`

## Rollback

1. **No deploys during the demo window** (24-hour freeze). This is in the calendar.
2. If a deploy must happen:
   - The previous image tag is retained
   - Rollback: `docker compose up -d --force-recreate app` with the previous build
   - Reconnection is jittered to prevent thundering herd
3. **In-flight calls are never interrupted** during a drain. The drain waits for CONNECTED cases to reach terminal state.

## Who to call

| Role | Contact | When |
|---|---|---|
| **On-call engineer** | [NAME, PHONE] | S1: interventions not placed, wrongful calls |
| **Founder / product** | [NAME, PHONE] | S2-S4, business decisions, pilot issues |
| **ElevenLabs support** | support@elevenlabs.io | Voice provider issues |
| **Twilio support** | support@twilio.com | Telephony issues |

## Pre-demo checklist

- [ ] Carrier geo-lock active in Twilio console
- [ ] Spend ceilings set for all orgs
- [ ] Global kill switch tested (flip off, verify, flip on)
- [ ] `/readyz` returns 200 on all instances
- [ ] Outbox lag is 0
- [ ] ElevenLabs quota checked (not exhausted)
- [ ] Twilio balance checked
- [ ] Postgres disk usage below 70%
- [ ] Redis reachable
- [ ] Agent snapshot hash matches deployed agent (`bun run agent:snapshot`)
- [ ] `bun run evidence` produces a complete bundle
- [ ] Demo rehearsal completed twice on the actual machine

## Incident response

1. **Assess:** What is the symptom? Which dependency?
2. **Contain:** Flip the relevant kill switch if needed
3. **Communicate:** Update the status page. Page on-call if S1.
4. **Resolve:** Follow the dependency-specific steps above
5. **Recover:** Verify `/readyz`, check outbox lag, confirm webhooks flowing
6. **Post-mortem:** Write what happened, what the kill switch did, what to improve
