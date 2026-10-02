# Runbook

One page. What to do when each dependency fails, who to call, how to roll back,
and where the kill switches are.
One code comment already cited this file as though it existed
(`src/app/api/agent/route.ts` → "Audit append failure"). It did not. It does
now, and that section is here.

**Read the governing rule first.** The safe default is to **not act** and
escalate to a human. Never fail open into autonomous action. But the safe
default must be **loud** — a silent failsafe is indistinguishable from a working
system with no fraud, which is the most dangerous state this platform can be in.

## 0. Audit append failure

*Referenced from `src/app/api/agent/route.ts`.*

The audit chain is append-only and a write that fails must never be swallowed.
`append()` is called fire-and-forget (`{ fast: true }`) on hot paths, so a
failure is logged rather than thrown — which is the right latency trade and the
wrong thing to lose silently.

If you see repeated audit append failures:

1. `/api/readyz` → `audit_chain` reports staleness. That is the signal.
2. The chain is the one write that must never be sacrificed under storage
   pressure — `evaluateStoragePressure` lists it as `NEVER_SACIFICED`.
3. A case whose chain cannot be written is a case you cannot prove. Treat the
   affected cases as unverified in any report rather than as passing.
4. `verifyChain` on an affected ref returns `ok:false` with `brokenAt`. That is
   the detection, not the cure.

Do not re-anchor a broken chain to make the check pass. A re-anchored chain
looks intact and proves nothing.

---

## 1. Triage: which endpoint answers your question

| Endpoint | Answers | Consumer |
| --- | --- | --- |
| `GET /api/health` | Is the process alive? No dependency checks. | Container runtime |
| `GET /api/readyz` | Can this instance serve? Checks database, outbox backlog, audit-chain freshness, voice-provider config. | Load balancer, compose |
| `GET /api/status` | Deep diagnostics: telephony mode, admission capacity, 24h webhook freshness. Operator-gated. | You, during an incident |

Do not wire `/api/status` into monitoring. It requires an operator session, so a
probe against it returns an auth failure rather than a health answer.

**Do not fail readiness because a shared dependency is unhealthy.** If Postgres
degrades and every instance reports not-ready, the balancer removes every
backend and a degraded system becomes a total outage. Readiness answers "can I
serve?", not "is everything healthy?". Global health belongs to `/api/status`.

---

## 2. When each dependency fails

| Dependency | Failsafe (do not act) | Failover (switch to) | Declared in |
| --- | --- | --- | --- |
| **Conversation plane** (ElevenLabs) | Do not dial. Case holds in queue, audit row written, breaker opens. | `continuity_pipeline`, then SMS | `src/lib/failures/breaker.ts` |
| **Telephony** (Twilio) | Case → `DIAL_FAILED`, bounded backoff. | `queued` + alert — the work is not lost, it waits | same |
| **LLM** (Groq) | No model-generated phrasing. | `scripted_reply` — fixed text, no model in the loop | same |
| **Redis** | Admission control fails **closed**: shed to the top risk band only. | `in_process_limits`, logged as degraded | same |
| **Postgres primary** | Read-only safe mode. Refuse new interventions explicitly. | Replica promotion — *not built* | `db-failures.ts` |
| **Post-call webhook lost** | Reconciliation sweep polls conversation status for any case non-terminal past its expected end. | — | `src/lib/outbox.ts` |
| **Operator console down** | In-flight calls continue. The call path does not depend on the UI. | — | — |

Every one of these preserves the intervention: the customer's fraud is still
stopped, by a cruder channel, and the case audit records which.

**Known single points of failure** — say these plainly in any due diligence:
Caddy, the Docker host, Postgres and Redis are each a single instance. Rollback
is by image tag. There is no multi-region failover; that is roadmap.

---

## 3. Kill switches

| Switch | Where | Deploy needed? | Effect |
| --- | --- | --- | --- |
| `BILLING_KILL_SWITCH` | env, read per call | **No** — set it and it is live | Stops all metered billing and credit reservation |

`BILLING_KILL_SWITCH` is the **only** genuinely deploy-free kill switch today.
It accepts `1`, `true`, `on`, `yes`, `stop`, `halt`.

Feature flags in `src/lib/flags.ts` — `realtime`, `elevenLabsLive`,
`piiRedaction`, `consoleLiveFeed` — are read from `process.env` on every call
(no module-load cache), so flipping one takes effect without a rebuild but
**does need a container restart** to take effect for already-running processes.

There is **no** kill switch for live dialling, the LLM phrasing layer, BYOK, or
outbound webhooks. To stop dialling now, take the dial worker down:

```bash
docker compose stop dial-worker
```

Jobs stay queued in `dial_job` and are picked up when it returns. This is
recorded as an open gap in `docs/GAP-REGISTER.md` §7.

---

## 4. Rollback

```bash
cd /srv/securevoice
git checkout <previous-tag>
docker compose build app db-setup
docker compose up -d
```

**Rebuild both images.** A plain `up -d` after a pull reuses the previous
`db-setup` image, which does not contain the new migration, and reports "No
pending migrations to apply" while the database is behind. This has shipped
twice on this project.

Verify the database is actually current — this is the check that catches a
stale `db-setup` image:

```bash
docker compose exec -T db psql -U securevoice -d securevoice \
  -c 'SELECT migration_name FROM _prisma_migrations ORDER BY finished_at;'
docker compose logs db-setup | tail -5   # must say "All migrations have been successfully applied"
```

Migrations are expand/contract: every one is backward-compatible with the
previously deployed code, so a rollback does not require a down-migration.

---

## 5. Named failure modes you will actually hit

**`P1001` on connect, to Supabase.** The direct DB host is often IPv6-only. If
the host has no IPv6 route you get `P1001` on a project you know is healthy.
Use the IPv4 pooler. Pin it in deployed configuration rather than debugging it
again at 02:00.

**Everything times out at once, `max_connections` exhausted.** Twenty app
instances at the Prisma default pool will exhaust Postgres immediately. Run the
arithmetic:

```
(instances × connection_limit) + workers ≤ max_connections − reserved
```

`max_connections` and `connection_limit` are set explicitly for this reason.
Check `/api/readyz` → database first; it is the only fatal check.

**The console shows a case stuck in `DIALING`.** Either the dial worker died
mid-flight (the job is reclaimed on lease expiry — check
`docker compose logs dial-worker`) or `placeOutboundCall` failed and the job
dead-lettered (state `DEAD` in `dial_job`, with `last_error` set).

**The case is stuck after the call ended.** The post-call webhook never
arrived. The reconciliation sweep completes it. Check the 24h freshness signal
in `/api/status`; if no webhook has been received in 24h the whole evidence
pipeline is down, not one call.

**A judge or operator pressed "Fire intervention signal" and nothing
happened.** Check, in order: is there an enrolled customer for that workspace
(the button returns a typed `customer_not_enrolled` otherwise — this is the
Console's step-1 "Connect your phone" panel); did the org's credits run out;
was it refused by the policy or abuse gate — those are typed 409s and audited
with the reason.

---

## 6. Freeze window

**No deploys and no migrations from 24 hours before the demo until it ends.**
Put it in the calendar and in CI. A deploy mid-demo is the cheapest way to lose
the one criterion worth 30%.

---

## 7. Who to call

⬜ **INPUT REQUIRED** — fill before the demo.

| Role | Name | Contact | Covers |
| --- | --- | --- | --- |
| Platform on-call | ⬜ | ⬜ | Sev 1 |
| Database / Supabase | ⬜ | ⬜ | P1001, connection exhaustion |
| ElevenLabs support | ⬜ | ⬜ | Conversation plane outage, quota |
| Twilio support | ⬜ | ⬜ | DDI failures, concurrency limits |
| Institutional contact | ⬜ | ⬜ | Pilot |

---

## 8. Heartbeat

The dangerous failure mode in a fraud platform is not an error — it is silence.
If the worker fleet stops claiming jobs, or no webhook arrives, or the
evidence bundle goes stale, that is a page. A green dashboard with a dead
queue is not a healthy system.
