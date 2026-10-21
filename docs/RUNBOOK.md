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

_Referenced from `src/app/api/agent/route.ts`._

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

| Endpoint          | Answers                                                                                                 | Consumer                |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ----------------------- |
| `GET /api/health` | Is the process alive? No dependency checks.                                                             | Container runtime       |
| `GET /api/readyz` | Can this instance serve? Checks database, outbox backlog, audit-chain freshness, voice-provider config. | Load balancer, compose  |
| `GET /api/status` | Deep diagnostics: telephony mode, admission capacity, 24h webhook freshness. Operator-gated.            | You, during an incident |

Do not wire `/api/status` into monitoring. It requires an operator session, so a
probe against it returns an auth failure rather than a health answer.

**Do not fail readiness because a shared dependency is unhealthy.** If Postgres
degrades and every instance reports not-ready, the balancer removes every
backend and a degraded system becomes a total outage. Readiness answers "can I
serve?", not "is everything healthy?". Global health belongs to `/api/status`.

---

## 2. When each dependency fails

| Dependency                          | Failsafe (do not act)                                                                           | Failover (switch to)                                | Declared in                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------- |
| **Conversation plane** (ElevenLabs) | Do not dial. Case holds in queue, audit row written, breaker opens.                             | `continuity_pipeline`, then SMS                     | `src/lib/failures/breaker.ts` |
| **Telephony** (Twilio)              | Case → `DIAL_FAILED`, bounded backoff.                                                          | `queued` + alert — the work is not lost, it waits   | same                          |
| **LLM** (Groq)                      | No model-generated phrasing.                                                                    | `scripted_reply` — fixed text, no model in the loop | same                          |
| **Redis**                           | Admission control fails **closed**: shed to the top risk band only.                             | `in_process_limits`, logged as degraded             | same                          |
| **Postgres primary**                | Read-only safe mode. Refuse new interventions explicitly.                                       | Replica promotion — _not built_                     | `db-failures.ts`              |
| **Post-call webhook lost**          | Reconciliation sweep polls conversation status for any case non-terminal past its expected end. | —                                                   | `src/lib/outbox.ts`           |
| **Operator console down**           | In-flight calls continue. The call path does not depend on the UI.                              | —                                                   | —                             |

Every one of these preserves the intervention: the customer's fraud is still
stopped, by a cruder channel, and the case audit records which.

**Known single points of failure** — say these plainly in any due diligence:
Caddy, the Docker host, Postgres and Redis are each a single instance. Rollback
is by image tag. There is no multi-region failover; that is roadmap.

---

## 3. Kill switches

| Switch                         | Where                | Deploy needed?                           | Effect                                           |
| ------------------------------ | -------------------- | ---------------------------------------- | ------------------------------------------------ |
| `DIAL_KILL_SWITCH`             | env, read per dial   | **No** to set; **yes** to change the env | Stops every outbound CARRIER CALL                |
| The dial kill switch (console) | `PlatformSwitch` row | **No** — not even a restart              | The same, flipped by an operator in the console  |
| `BILLING_KILL_SWITCH`          | env, read per call   | **No** — set it and it is live           | Stops all metered billing and credit reservation |

### 3.1 The dial kill switch — the one you actually want

**The console has a PILOT panel, and it is the first thing to look for.**
`src/views/PilotPanel.tsx`, at the top of the Command Center: it shows the
mode, the kill switch, the daily cap and the count against it, and — in
`live` mode — the cases waiting for a per-dial human decision, with an
**Approve** and a **Decline** button for each.

That panel is the reason the controls are reachable at all. Three things a
pilot needs during a shift are now one click instead of a `curl`:

| Control        | Where in the console         | What it does                                           |
| -------------- | ---------------------------- | ------------------------------------------------------ |
| Stop dialling  | Pilot panel, "Stop dialling" | Engages the platform-wide switch, in seconds           |
| Approve a dial | Pilot panel, per case        | Writes the approval for THAT attempt and wakes the job |
| Decline a dial | Pilot panel, per case        | Dead-letters the job and moves the case to REJECTED    |

The kill switch is platform-wide, so only a **platform operator** (a session
with no active organisation) may flip it. A tenant-scoped operator sees the
state and the button is disabled with the reason — a control that answers 403
teaches people the console is lying.

`docs/RUNBOOK.md` §5 has the "the button did nothing" troubleshooting, and
`docs/PILOT-READINESS.md` §3 is the gate that says the switch must be tested
end to end before the first dial.

`docs/RUNBOOK.md` used to say, in these words, that there was **no kill switch
for live dialling**, and that stopping outbound calls meant
`docker compose stop dial-worker`. That is no longer true, and a runbook that
tells the person holding the pager to take a container down during an incident
is a runbook that will be ignored.

There are now two halves, and either one stops dialling:

- **The environment half** — `DIAL_KILL_SWITCH=stop` (it accepts the same
  spellings as `BILLING_KILL_SWITCH`: `1`, `true`, `on`, `yes`, `stop`,
  `halt`). It is read from `process.env` on every dial decision and never
  cached, so flipping it takes effect on the next call. Changing the
  container's own environment still needs a restart — which is why the second
  half exists.
  - It also accepts an explicit OFF: `0`, `false`, `off`, `no`, `disabled`,
    `none`. `DIAL_KILL_SWITCH=0` is what an operator writes when they mean
    "leave it off", and it has to MEAN that — otherwise the natural thing to
    type during an incident would stop every fraud call.
  - **Any other spelling is NOT engaged**, and is logged as an unrecognised
    spelling. A typo that silently left the switch off is the failure this
    variable must not have, and a typo that silently STOPPED every fraud call
    is the other failure. So: allowlist semantics, a loud log, and the raw
    value plus an `envRecognised` flag on `GET /api/console/pilot` so the
    operator's screen says _"NOT RECOGNISED — the switch is NOT engaged"_
    instead of a bare `false` they have to interpret.
- **The database half** — a row in `PlatformSwitch` named `dial_kill_switch`,
  flipped from the operator console:
  ```bash
  curl -X POST https://securevoiceai.me/api/console/pilot/kill-switch \
    -H 'Content-Type: application/json' \
    -b "$SESSION_COOKIE" \
    -d '{"engaged":true,"reason":"carrier outage"}'
  ```
  No deploy, no restart, no shell on the box. The platform stops dialling
  within seconds, and every engage and release is written to the audit chain
  with the operator's id. It is a **platform** lever: only a platform operator
  can flip it, so an admin of one bank cannot stop every bank.

**A switch whose state cannot be read is treated as ENGAGED.** The database
half fails closed, because a database blip is transient and the conservative
reading costs a minute of not-dialling; failing open would silently disarm the
control during exactly the incident it exists for. The status surface
distinguishes the two facts (`databaseAvailable: false` means "we could not
tell", not "an operator stopped the pilot").

**What the switch stops: VOICE.** The blind-ping SMS fallback keeps running,
and that is a deliberate boundary rather than an omission — the SMS exists to
warn a customer whose card is being questioned and to tell the bank the
customer was not reached. Suppressing it during a voice incident would leave a
customer with a live fraud attempt and nobody telling them. What the switch
does guarantee is that no carrier call is placed.

**What it does NOT stop, and how to stop that instead:**

| Thing                       | How to stop it                                                  |
| --------------------------- | --------------------------------------------------------------- |
| The blind-ping SMS fallback | Not stopped by the dial switch — by design (see above).         |
| The LLM phrasing layer      | Blank `GROQ_API_KEY` / `GEMINI_API_KEY`: scripted replies only. |
| BYOK                        | Blank `ELEVENLABS_API_KEY`: the platform voice is used instead. |
| Outbound bank webhooks      | Blank `BANK_WEBHOOK_URL`: dispatch pauses, the outbox keeps.    |
| Metered billing             | `BILLING_KILL_SWITCH`.                                          |

### 3.2 Pilot mode — the other switches

`src/lib/pilot/mode.ts` adds a bounded operating mode for a live pilot. It is
**off by default**, so a deployment that has never heard of it behaves exactly
as it always has.

| Env var                 | Effect                                                                      |
| ----------------------- | --------------------------------------------------------------------------- |
| `PILOT_MODE`            | `off` (default) / `shadow` (no customer contact) / `live` (Phase 1).        |
| `DIAL_KILL_SWITCH`      | See above.                                                                  |
| `PILOT_DAILY_CALL_CAP`  | Interventions one organisation may act on per day.                          |
| `PILOT_CONCURRENCY_CAP` | Calls one organisation may have in flight at once, counted across replicas. |
| `PILOT_SIGNAL_KIND`     | The one alert type the pilot is chartered for.                              |
| `PILOT_HUMAN_APPROVAL`  | Whether a human approves every dial. On by default in `live`.               |

**What the daily cap counts**, because a cap whose unit is ambiguous is a cap
nobody can reason about: DISTINCT **cases**, over the union of "admitted
today" and "settled today", on the **database's** calendar day.

- _Cases_, not job rows: a case that is dialled, comes back unanswered and is
  retried is still one intervention — the same unit the pricing model bills.
  Counting rows would make a pilot hit its ceiling at half the contracted
  number of customers.
- _Admitted today OR settled today_, not just admitted today: a pilot that
  admitted five hundred cases yesterday and has not dialled them yet has a
  BACKLOG, and yesterday's admission says nothing about how many customers
  that backlog will ring today. The union is the number of distinct customers
  the pilot can still touch today, which is what a "hard daily call cap" is
  for.
- The database's day, not UTC and not the app server's: the queue leases, the
  audit chain and every deadline in this system already run on the database
  clock, and a cap that resets on a different boundary is a cap nobody can
  reason about.

**What the charter counts.** `PILOT_SIGNAL_KIND` names the ONE alert type the
pilot is chartered for, and it fails CLOSED: a signal whose type is unknown is
REFUSED, not admitted. `signal_kind` is optional in the bank contract, so "no
type" is the common case, and a scope control that waves through everything
it cannot classify is not a scope control.

**A human approval is bound to ONE attempt.** A case that is dialled, comes
back unanswered and is retried as attempt 2 needs a SECOND approval: a second
call to a customer is a second call to a customer, and Phase 1 says a human
approves every dial. The approval lives in the audit chain with the attempt
number in its `intent` (`pilot_dial_approved:2` — a colon, because the audit
chain's field sanitiser strips `#` on the way in), and a decline for the case
refuses every attempt for it.

Read the live state from `GET /api/console/pilot` (any signed-in operator) or
from `/api/status` (platform operator). `/api/readyz` carries a `pilot` check
that reports the mode and whether the switch is engaged — it is a check, not an
assertion: a stopped pilot is a decided state, not a fault, and refusing
readiness for it would turn a deliberate stop into an outage.

**A pilot block never fails a dial.** "The cap is reached", "a human has not
approved this yet" and "the switch is on" all PARK the dial job — back to
PENDING, no attempt consumed, no SMS — so a pilot block can never dead-letter a
case into the blind-ping fallback and text a customer the operator decided not
to call.

**And a pilot decision that cannot be MADE is also a park.** The counters
read the database, and a database blip in the middle of one used to throw out
of the decision function — into the worker's handler, where a throw is a
crashed handler that climbs the attempt ladder and eventually dead-letters
into the blind-ping SMS. A database wobble would have become a text message
to a customer during exactly the window the pilot was supposed to contact
nobody. The whole decision is now wrapped, and an unreadable control is a
refusal, not an exception.

### 3.3 Compliance controls are not switches

Feature flags in `src/lib/flags.ts` — `realtime`, `elevenLabsLive`,
`consoleLiveFeed`, `seedDemo`, `twilioMediaStreams` — are read from `process.env`
on every call (no module-load cache), so flipping one takes effect without a
rebuild but **does need a container restart** to take effect for
already-running processes.

There is **no** flag for a compliance control, and there must not be one. The
opening disclosure, the credential-ask refusal, PII redaction and inbound
`SV-Signature` enforcement are invariants: the code that performs them reads no
flag at all, so they are on in every deployment and `FEATURE_COMPLIANCE_*`,
`FEATURE_PII_REDACTION`, `FEATURE_WEBHOOK_STRICT_SIGNATURES`,
`COMPLIANCE_OPENING_DISCLOSURE`, `COMPLIANCE_NO_CREDENTIAL_REQUESTS` and
`COMPLIANCE_PII_REDACTION` are read by nothing. `GET /api/console/invariants`
(operator session) lists each one with the path and line that enforce it and the
test that proves it; `tests/surface/invariants.test.ts` keeps that list honest.
If a previous runbook or ticket told you one of these could be switched off,
that instruction was never executable.

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

**The fire button answers 503 "not configured".** The console signs the signal
it forwards with a credential that may NAME an organisation, and the shared
`WEBHOOK_SECRET` may not — every producer holds that one, so a request signed
with it cannot select a tenant. A session that names an organisation therefore
needs `CONSOLE_INGEST_SECRET` (deployment-internal, never given to a producer,
never sent to a browser); a session with NO organisation names no tenant and
signs with the shared secret, as it always did. If the button 503s for a
tenant session, that variable is not set on the box. `docs/RUNBOOK.md` §5,
`src/app/api/console/fire/route.ts`.

---

## 6. Freeze window

**No deploys and no migrations from 24 hours before the demo until it ends.**
Put it in the calendar and in CI. A deploy mid-demo is the cheapest way to lose
the one criterion worth 30%.

---

## 7. Who to call

⬜ **INPUT REQUIRED** — fill before the demo.

| Role                      | Name | Contact | Covers                             |
| ------------------------- | ---- | ------- | ---------------------------------- |
| Platform on-call          | ⬜   | ⬜      | Sev 1                              |
| Database / Supabase       | ⬜   | ⬜      | P1001, connection exhaustion       |
| ElevenLabs support        | ⬜   | ⬜      | Conversation plane outage, quota   |
| Twilio support            | ⬜   | ⬜      | DDI failures, concurrency limits   |
| Institutional contact     | ⬜   | ⬜      | Pilot                              |
| **Named pilot owner**     | ⬜   | ⬜      | Pilot go/no-go, scope, the charter |
| **Incident commander**    | ⬜   | ⬜      | Sev 1/Sev 2 — declared in advance  |
| **Security owner**        | ⬜   | ⬜      | Security exception, pen-test gate  |
| **Data-protection owner** | ⬜   | ⬜      | DPO / rights requests / transfers  |

### 7.1 Pilot support hours and escalation — TO AGREE

These are **not yet agreed with any institution**, and this document does not
imply they are. They are the terms a pilot agreement has to state, and
`docs/PILOT-READINESS.md` carries the same items as open Phase 1 gates.

| Term                 | State    | What has to be decided                                                       |
| -------------------- | -------- | ---------------------------------------------------------------------------- |
| Support hours        | TO AGREE | Coverage window in the institution's local time, and whether it is 24×7.     |
| Support channel      | TO AGREE | A monitored mailbox, a ticket system, or a named phone number.               |
| Response times       | TO AGREE | Sev 1 / Sev 2 / Sev 3, and what "response" means (acknowledge vs. restore).  |
| Escalation path      | TO AGREE | Operator → pilot owner → institution's sponsor, with the point of no return. |
| Bank-side escalation | TO AGREE | Who at the institution we call, and when.                                    |
| Named pilot owner    | TO AGREE | One accountable human, named in the pilot charter.                           |
| Incident commander   | TO AGREE | Named per incident; the founder by default until a rota exists.              |

**What is in place today, so the gap is only the roster and the hours:** the
technical levers are real — a deploy-free dial kill switch (§3.1), a
health-gated blue/green rollback (§4), a durable queue that survives a worker
restart, a reconciliation sweep for missing post-call webhooks, and an audit
chain that is verifiable per case. What is missing is a name against a phone
number, and that is an agreement with a person, not a piece of code.

### 7.2 Contracts — TO AGREE / OPEN

| Document                           | State                  | Note                                                                                                                                                                                              |
| ---------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MSA                                | OPEN — template exists | `docs/LOI-TEMPLATE.md` is a letter of intent, not the MSA.                                                                                                                                        |
| Data processing agreement          | OPEN — template exists | Must name controller, processor, purposes, retention and deletion.                                                                                                                                |
| Order form / pilot terms           | OPEN                   | Scope, volume cap, success criteria, termination assistance.                                                                                                                                      |
| SLA                                | OPEN                   | Service levels and credits; a premium SLA is priced separately.                                                                                                                                   |
| Shariah supervisory board approval | OPEN — CONDITIONAL     | The institution's SSB must approve the terminology map, the scripts, the product terms and the spoken disclosures before any Shariah-mode call. SecureVoice issues no fatwa and no certification. |

---

## 8. Heartbeat

The dangerous failure mode in a fraud platform is not an error — it is silence.
If the worker fleet stops claiming jobs, or no webhook arrives, or the
evidence bundle goes stale, that is a page. A green dashboard with a dead
queue is not a healthy system.

---

## 9. The deploy window, and the two probes that see it differently

**Read this before you trust a monitor.** A release on a host that has NOT
adopted the blue/green slots is an in-place roll of the only application
container, and for about twenty seconds the edge has no origin to serve.

### 9.1 What it looks like from outside

Measured on the production box, from the deploy that shipped `v0.2.48`:

```
21:43:29.712  Container securevoice-ai-app-1  Recreated   ← the old container is gone
21:43:43.320  Container securevoice-ai-app-1  Started     ← the new one is up
21:43:49.217  health attempt 1: 200                       ← the origin finally answers
```

Two phases, and they fail differently:

| Phase                           | Duration | What the edge does                                             |
| ------------------------------- | -------- | -------------------------------------------------------------- |
| No container at all             | ~13.6 s  | Connection refused → Caddy answers **502**                     |
| Container up, app still booting | ~5.9 s   | The request is forwarded to an origin that will not answer yet |

The first phase answers. The second one **hangs**, and a monitor reports a hang
as _timeout: no headers received_ — the connection was made and no response
headers came back before the deadline. That is the message that should send
you to the deploy, not to the database.

The deploy's own health check does not see any of this: it starts AFTER the
roll, so by the time it probes, the origin is up and it passes on attempt 1.
**A green Deploy run does not mean the edge never went dark.**

### 9.2 The three paths, and which one to alert on

| Path          | Answered by | Touches the origin? | Use it for                        |
| ------------- | ----------- | ------------------- | --------------------------------- |
| `/healthz`    | Caddy       | **No**              | Edge liveness. Never false-alarms |
| `/api/readyz` | The app     | Yes                 | "Can the platform serve?"         |
| `/api/health` | The app     | Yes                 | "Is the process alive?"           |

`/healthz` is answered by the edge itself. It proves DNS, TLS and Caddy, and
it **cannot** report a deploy-time blip, because it never asks the app. That
is what makes it the right probe for a monitor that must not cry wolf.

`/api/readyz` is a machine surface and is deliberately excluded from the
maintenance page, so it reports the app's real state rather than the edge's
story about it. It is the same probe Caddy's own active health check uses, and
it is the one that will report a real outage.

The **root page** is a page surface: during a roll the edge answers it with
the maintenance page (503, `Retry-After: 20`). That is a designed degradation,
not a down site, and a monitor pointed at it cannot tell the difference.

**The monitoring shape is two probes, not one:**

- `securevoiceai.me — edge` → `https://securevoiceai.me/healthz`
- `securevoiceai.me — app (readyz)` → `https://securevoiceai.me/api/readyz`

### 9.3 The fix, and how to check it

Adopting the blue/green slots removes the window entirely: the release is
staged into the IDLE colour, the old colour keeps serving throughout, and the
traffic flip is a one-line `APP_UPSTREAM` change plus a Caddy recreate.

```bash
cd ~/securevoice-ai
bun scripts/deploy.mjs mode     # plain | bluegreen | unknown
bun scripts/deploy.mjs status   # stack, active colour, canary split, edge
bun scripts/deploy.mjs adopt    # the one-time migration, by hand
```

`mode` answers "what is running"; `status` answers "what is serving". After
the adoption they agree, and the deploy window is gone.

### 9.4 A half-finished adoption

The adoption can be interrupted — the traffic flip failed once on the
production box, and it left the box in a state whose record did not match
reality:

- a colour slot was running and healthy,
- `.deploy/active.env` named the new colour,
- **Caddy was still proxying to the old one**, because the Caddy recreate is
  what failed and Caddy was never restarted.

Production was never affected — the running container was never touched — but
the recording lied, and the next `adopt` would have refused to finish it.

**How to recognise it.** Compare the two:

```bash
bun scripts/deploy.mjs mode                                   # says "bluegreen"?
docker inspect securevoice-ai-caddy-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep APP_UPSTREAM                                          # says "app:3000"?
```

A colour running with no `APP_UPSTREAM` in the Caddy environment is an
**interrupted adoption**, not an adopted host. The `adopt` command is
resumable: it reads the upstream from the running Caddy container, finishes
the flip, verifies through the proxy, and only then retires the plain
container.

**Recovery, if the edge is wrong and you cannot wait for the script:**

```bash
# the plain container is stopped, never removed — a `start` away
docker compose start app
```

### 9.5 What the adopted host actually did — the first blue/green release

§9.1 describes the deploy window of a host that has NOT adopted the slots, and
that is still the right description of the plain path. It is no longer a
description of production. This is the measured first release through the
adopted path on the production box (deploy run `39537833586`, canary run
`39538178175`, 2026-10-21):

```
03:18:41  deployed commit: 221f9dfcc141        ← the commit CI proved
03:18:41  rolling immutable tag securevoice-ai-app:221f9dfcc141
03:18:41  stack mode: bluegreen                ← the box is adopted
03:22:17  ✓ app-green is staged and verified. Traffic has NOT moved.
03:22:17  canary 1/20 slots → 5% app-green, 95% app-blue
03:22:30  ✓ split live
03:27:32  canary 10/20 slots → 50% app-green, 50% app-blue
03:27:45  ✓ split live
03:32:48  canary 100% → app-green (full switch)
03:32:54  ✓ all traffic on app-green
03:32:54  promoting: stopping app-blue
03:32:54  ✓ auto release complete: app-green is serving securevoice-ai-app:221f9dfcc141
```

**The edge never went dark.** Caddy's own access log for `securevoiceai.me`
over 03:10–03:40Z — the window that contains the whole deploy, both 300-second
soaks and the flip:

| Status  | Count |
| ------- | ----- |
| 200     | 30    |
| 308     | 6     |
| 404     | 31    |
| **5xx** | **0** |

The 404s are `/remote/logincheck`, `/global-protect/login.esp`,
`/sslvpn/Login/Login` and the rest of the internet's VPN-scanner vocabulary —
none of them our routes. The 308s are Caddy's own HTTP→HTTPS redirect. There
is no 502 in the window, and no hang either: the app was up and answering for
the whole release because the OLD colour was serving until the flip.

Two soaks of 300 seconds each, five minutes apart, with the edge AND the new
colour probed every 30 seconds. The release took about twelve and a half
minutes from staging to promotion, and it took that long because the soak is
the point — not because anything was slow.

**What the rollback is, once a release has been promoted.** `promote` retires
the old colour and clears `previous`, so after a successful promotion there is
deliberately no warm colour left to flip back to:

```bash
bun scripts/deploy.mjs rollback
#   no previous colour recorded — nothing to roll back to.
```

The rollback guarantee covers the window that matters — the canary, while the
release is still being introduced. Inside that window the old colour is still
running, and the rollback is a flip rather than a rebuild, which is why the
rollback lives inside `deploy.mjs auto` and not in a workflow step.

After the promotion the fallback is the plain container, which the adoption
deliberately left stopped rather than removed:

```bash
docker compose start app    # the pre-adoption build, stopped, never removed
```

and the box keeps every SHA-tagged image it has built, so a rollback to a
previous release is `bun scripts/deploy.mjs deploy --image
securevoice-ai-app:<sha>` away. Neither is automatic. Know which one you have
before the next release, not after it.
