# Interim control set — the EU deployment

**Status:** control set and gap register for the deployment as it stands while
the production stack runs in the EU. Not a legal opinion, not a certification,
and not a claim of compliance with anything.

**Scope:** the **infrastructure** posture of the running production deployment
— where data physically is, what the network exposes, who can reach the host,
what is logged, and what happens when the host dies. The product's own
compliance records live elsewhere and are not restated here:
[`docs/ROPA.md`](ROPA.md) (the register of processing),
[`docs/DPIA.md`](DPIA.md) (the assessment),
[`docs/DIFC-DFSA-COMPLIANCE.md`](DIFC-DFSA-COMPLIANCE.md) (the control map
and the gap register), [`docs/AI-INVENTORY.md`](AI-INVENTORY.md) (the system
register), [`docs/SECURITY-QUESTIONNAIRE.md`](SECURITY-QUESTIONNAIRE.md) (the
answers a bank will ask).

**Last reviewed:** 2026-10-22.

---

## 1. What the interim state actually is

**The Company is established in the DIFC, Dubai. The production stack runs in
the EU, and none of it runs in the UAE.** Everything below follows from that
one sentence — and the second half of it is the part that is easy to get
wrong, so it is worth being exact about _which_ piece runs where.

|                                 |                                                                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entity                          | SecureVoice Technologies FZ-LLC, registered in the DIFC (`docs/AI-INVENTORY.md`)                                                                                                                                                                                           |
| Application host, workers, edge | **OVHcloud public instance, France** — the provisioning module's default region is `GRA11` (Gravelines) and the running host's exact region is recorded as `OPEN` in the RoPA, because the box was hand-provisioned rather than created by the module (`docs/ROPA.md:188`) |
| **Primary datastore**           | **Supabase Postgres, `aws-0-eu-central-1` — Frankfurt, Germany** (measured against the live connection string, `docs/ROPA.md:187`)                                                                                                                                         |
| The OVHcloud box's own Postgres | **An empty shell.** It was never populated; the app was pointed at Supabase throughout (`docs/VPS-RECOVERY.md:173-176`)                                                                                                                                                    |
| Transactional email             | Resend, `eu-west-1` (Ireland) — measured via the vendor API (`docs/ROPA.md:194`)                                                                                                                                                                                           |
| Telemetry                       | Grafana Cloud `prod-ca-east-0` (Canada) — and the OTLP credential is **UNSET** in production, so metrics are **dormant** (`docs/ROPA.md:199`)                                                                                                                              |
| Voice and LLM processors        | US / UK / global — Twilio, ElevenLabs, Deepgram, Groq, Pinecone, Paddle (`docs/ROPA.md:189-198`)                                                                                                                                                                           |
| Instances                       | **One.** One application host, one availability zone, one region, one edge                                                                                                                                                                                                 |
| Public ingress                  | TCP 80 and 443 only (`terraform/versions.tf:112`); SSH 22 only while the bootstrap allow-list is open                                                                                                                                                                      |
| Edge                            | This project's own Caddy, behind a shared L4 front door on a multi-product host (`docs/adr/009-isolated-edge-per-project.md`)                                                                                                                                              |
| Backups                         | Nightly database dumps retained 14 days, off-host copy **recommended**, recovery-time objective **untested** (`docs/SECURITY-QUESTIONNAIRE.md` §7.3)                                                                                                                       |

**What this is:** a temporary architecture, in jurisdictions that are neither
the entity's jurisdiction nor the one the product is sold into, awaiting a
move to the UAE for data sovereignty and governance.

**What this is not:** a steady state. The end state is a deployment inside the
UAE — that is the point of the exercise, and the reason the architecture is
being made portable rather than merely reliable.

**One correction to the assumption this document was written against.** The
application server is in France, and it is the France the product is usually
described as running in — but the **case data is not on that server**. It is
in Frankfurt, in a managed Postgres. An answer to "where is my data?" that
says "France" is close enough to be dangerous: it names the right continent
and the wrong country for the primary datastore, and the company's own RoPA
already records that distinction. Say **"the EU — the application host in
France, the datastore in Frankfurt"**, or name the two separately.

---

## 2. The residency facts, stated without hedging

A bank asking "where is my customers' data?" deserves a precise answer, and
the precise answer is a list, not a slogan. The `Location` column of
`docs/ROPA.md`'s processor register is the authoritative version of this
table, and it is the document to hand over.

| Data                                                  | Where it is                                                                                        | Evidence                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Case records, transcripts, organisation and user data | **Germany** — Supabase `aws-0-eu-central-1` (Frankfurt)                                            | `docs/ROPA.md:187`                 |
| PII vault entries (phone numbers)                     | With the case rows, tokenised at rest, crypto-shredded on erasure                                  | `docs/adr/007-pii-tokenization.md` |
| Audio recordings                                      | With the case rows, bounded retention (30 days; zero when the organisation disables recording)     | `docs/adr/002-data-tiering.md`     |
| Application state, worker state, edge logs            | **France** — the OVHcloud host                                                                     | `docs/ROPA.md:188`                 |
| Support correspondence                                | **Ireland** — Resend `eu-west-1`                                                                   | `docs/ROPA.md:194`                 |
| Metrics (no request content)                          | **Canada** — Grafana Cloud `prod-ca-east-0`; and **dormant**, because the OTLP credential is unset | `docs/ROPA.md:199`                 |
| Traces and logs                                       | **Not shipped** — metrics-only was a deliberate decision                                           | `docs/OBSERVABILITY.md:24,113`     |
| Voice audio in transit and synthesis                  | **US / global** — Twilio, ElevenLabs, Deepgram                                                     | `docs/ROPA.md:189-191`             |
| Reply drafting (non-commitment turns only)            | **US** — Groq                                                                                      | `docs/ROPA.md:192`                 |
| Transcript embeddings                                 | `OPEN` — Pinecone                                                                                  | `docs/ROPA.md:193`                 |
| Billing identity                                      | **Merchant of record** — Paddle                                                                    | `docs/adr/005-paddle-metering.md`  |

**The honest summary for a due-diligence question:** _the case data is in
Frankfurt, the application runs in France, the operational metrics are in
Canada — and dormant — and the voice audio passes through US and UK
processors. Nothing is in the UAE, and the entity is in the UAE._ That is a
cross-border transfer position (DIFC Data Protection Law Arts 26-27) that is
currently marked `OPEN` in
[`docs/DIFC-DFSA-COMPLIANCE.md`](DIFC-DFSA-COMPLIANCE.md) row 12, and it is
the strongest argument for the move.

**What must not be said meanwhile.** "Data never leaves the country" is
false today, and the product's own published line is scoped to the _tenant's_
declared region, not to the infrastructure's physical location. Do not let a
sales conversation turn the tenant-level claim into an infrastructure-level
one. The accurate infrastructure claim today is _"case data in the EU
(Frankfurt), application in France, voice processors in the US and UK."_

---

## 3. Interim controls that are in place

These are evidenced in code or in infrastructure, and each one is a control
that carries over to the UAE unchanged.

### 3.1 Network and edge

- **One published surface.** The security group is an OpenStack allow-list and
  its whole content is TCP 80 and 443 (`terraform/versions.tf:112`). Postgres
  (5432) and the realtime socket service (9090) are denied by the _absence_ of
  a rule — the list is short, and `outputs.public_ports` is derived from the
  same value the group uses, so the documentation cannot promise less than the
  box grants.
- **The origin is unreachable from the internet.** The app and the realtime
  service listen on the compose network alone, and no port of theirs is
  published. This is what makes the trust model in `src/proxy.ts` sound: it
  believes `X-Forwarded-For` only when the edge set the marker header, and
  that guarantee is worthless if anything else can reach the origin.
- **One edge per product.** As of ADR-009, a compromise or a misconfiguration
  in this product's edge is not a capability against another product's
  containers, and this product's deploy is not another product's outage.
- **Security headers on every response**, including on 404s and on the
  HTTP→HTTPS redirect (`Caddyfile`, `(secure_defaults)`).
- **Log redaction at the edge.** Cookie, `Authorization` and the agent-tool
  secret are deleted from the access log, `SV-Signature` is replaced, and the
  query string is never written — signed bank payloads carry secrets in it
  (`Caddyfile`, `log { format filter { … } }`).
- **Certificates are issued and renewed by the edge** (Let's Encrypt,
  automatic), and the admin API is off (`admin off`), so there is no reload or
  introspection endpoint reachable from anywhere.

### 3.2 Data protection

- **PII is tokenised**, and erasure crypto-shreds the vault entry
  (`docs/adr/007-pii-tokenization.md`).
- **Retention is tiered and enforced by workers**, not by hope
  (`docs/adr/002-data-tiering.md`).
- **Telemetry is metrics only.** Traces and logs were deliberately _not_
  widened, because widening them re-opens the residency question against the
  RoPA (`docs/OBSERVABILITY.md:113`).
- **Tenant scoping is enforced in the application**, not at the edge, and the
  edge deliberately does not authenticate the bank API — the producer key is
  verified per route, where tenancy is resolved, so there is exactly one
  implementation of that check.
- **The commit path does not leave the boundary.** The sentences that commit
  the platform to a fraud decision are vetted scripts; only non-commitment
  turns reach a model provider (`docs/ROPA.md:192`,
  `src/lib/llm.ts:58-62`).

### 3.3 Deployment safety

- **Blue/green with a drain that outlasts a call leg** (`docs/adr/008`), so a
  release does not drop a live fraud call.
- **A canary at 5% against live traffic** before 100%, gated on readiness
  (`/api/readyz`) rather than liveness.
- **The edge configuration is tracked and reviewable**, and the same bytes run
  in every zone (`docs/adr/009`).

---

## 4. Interim risks, ranked, with what to do about each

This is the part that is usually left out, and it is the part a reviewer
actually needs. Each risk names the evidence, the consequence, and the
mitigation that exists **today** — not one that will exist at the UAE cutover.

### R1 — The origin IP is directly reachable, with no WAF or DDoS in front

**Evidence.** The Cloudflare record is DNS-only (grey cloud), so Cloudflare's
proxy does not sit in front of the hostname and the origin IP is reachable
from anywhere on the internet. The Caddyfile records this trade explicitly:
Cloudflare's proxy was tried three ways and each failed (a proxy needs a
static origin certificate, and the stock `caddy:2-alpine` image carries no
`dns.providers.*` module, so a DNS-01 challenge is a startup failure that
takes every hostname down).

**Consequence.** The only thing between the internet and the application is
this project's own edge. No CDN WAF, no L3/L4 DDoS scrubbing, no managed
rate limiting in front of it.

**Mitigation today.** The edge is the only published surface, it rate-limits
per client IP at the app layer (`src/proxy.ts`), and the security group
admits nothing else. **What is not mitigated:** volumetric DDoS and TLS-layer
floods, which a single origin absorbs with one box.

**Action.** Either move the DNS record to proxied and give the edge a static
origin certificate, or put a load balancer in front — the latter is also the
first component of the three-zone topology in
[`docs/INFRASTRUCTURE.md`](INFRASTRUCTURE.md). **Until one of those lands, the
box is a single point of failure and a single target.**

### R2 — One host, one zone, one region

**Evidence.** One application instance (`terraform/main.tf`), one region, one
Postgres connection pool to a managed store, no read replica, no automatic
promotion. `docs/SECURITY-QUESTIONNAIRE.md` §7.4 already says this:
_"Not yet documented as a tested plan — target Q1. Single-region today."_

**Consequence.** The host is a single point of failure for every live fraud
call. A provider-side incident, a disk failure or a bad kernel update is an
outage, and the RTO is "however long a rebuild takes". The datastore is a
managed service, so it is not the same risk — but a regional outage that takes
both the host and the store's region is still one event.

**Mitigation today.** The blue/green drain means a _deploy_ does not drop a
call. It says nothing about a _host failure_, because a host failure takes
the call with it.

**Action.** This is the strongest reason to build the three-zone topology
before the UAE move, rather than after: a region migration done on a
single-AZ architecture is a single-AZ architecture with a new address. See
[`docs/INFRASTRUCTURE.md`](INFRASTRUCTURE.md).

### R3 — Recovery is untested, and the backup location is undecided

**Evidence.** `docs/SECURITY-QUESTIONNAIRE.md` §7.3: nightly database dumps,
14-day retention, off-host copy _recommended_, and **"recovery-time
objective is untested"**. The Terraform backup volume
(`terraform/main.tf:160`) is off by default, and it backs up the _host disk_,
which does not hold the case data — the case data is in Frankfurt. The reason
the volume is off is still correct and worth keeping: where a PII-bearing
fraud-case database's backups physically live is a legal decision, not a
forgotten boolean.

**Consequence.** "We can restore from backup" is currently an untested claim,
and the location of the retained dumps is unrecorded.

**Mitigation today.** The dump procedure exists; a rehearsed restore does not.

**Action.** Record where the nightly dumps are written, decide whether an
off-host copy is made and where it lives, and rehearse a restore with a
measured RTO. If the dumps are written to the France host, say so — and
decide whether that is acceptable, because it means a second copy of
Frankfurt data in France.

### R4 — CI shares the production host

**Evidence.** The compose smoke test runs `docker compose up` **on the machine
that serves live traffic** (`.github/workflows/ci.yml`), under its own project
name and its own host ports, and it asserts afterwards that production still
has its full container set. The reclaim script (`scripts/reclaim-ci.sh`) also
runs on this host and deletes unused Docker resources.

**Consequence.** A CI job has Docker-level access to the production host. The
guard (a container-count check) catches a _collision_; it does not prevent a
CI job from _doing_ something to production.

**Mitigation today.** The CI project is fenced off by name and by port, the
reclaim script filters by the `svci-` prefix, and the post-run assertion
fails the job if production's container count moved.

**Action.** This is the strongest argument for moving CI off the production
host before the UAE migration — a build agent with Docker access to the
production box is a production-box compromise with extra steps. It is also
cheap: the box is a single host today, so the CI runner's home is one
migration.

### R5 — The host is the unit of trust for the people operating it

**Evidence.** SSH is the intended route in, and `allow_ssh_from` must be
non-empty and cannot be `0.0.0.0/0` (`terraform/variables.tf`,
`docs/INFRASTRUCTURE.md` "Guardrails"). Access is by key, not by password.

**Consequence.** Every operator with a key can reach the host, and the host
is the machine serving live traffic.

**Mitigation today.** Key-only access, a generated and unusable root password
(`terraform/main.tf:144-150`), a non-root `deploy` user, and a security group
that closes 22 once bootstrap is over.

**Action.** Record the operator list and a named owner for the keys, and
review it on the same cadence as the rest of this document. A key list nobody
reviews is not a control.

### R6 — Cross-border transfer position is open

**Evidence.** `docs/DIFC-DFSA-COMPLIANCE.md` row 12: _"EU hosting and named
US/UK processors; no DIFC transfer assessment — OPEN."_ Rows 6, 11 and 13 are
open for the same reason.

**Consequence.** The Company is a DIFC controller whose production data sits
in the EU. That is lawful in many readings and undocumented in all of them.

**Mitigation today.** None that is documentary. The technical controls are in
place; the paperwork is not.

**Action.** This is the item that most directly justifies the move, and it
should be carried by counsel rather than by engineering. The engineering
contribution is the data-flow table in §2 above and the processor register in
`docs/ROPA.md` — both of which are ready to hand over.

### R7 — The monitoring pipeline is dormant

**Evidence.** The Grafana Cloud stack exists and the region is
`prod-ca-east-0`, but the OTLP credential is **UNSET** in production
(`docs/ROPA.md:199`), so no metrics are actually leaving the box.

**Consequence.** A product that cannot see its own latency, error rate or
capacity is operating blind. The incident in `docs/VPS-RECOVERY.md` is the
shape of what that hides: a stalled ladder that looked like a red build.

**Mitigation today.** Application-level health probes exist and are wired into
the edge's active health checks, and the edge's own access log is the
incident record (`docs/RUNBOOK.md`). Those are per-instance signals, not
fleet-wide observability.

**Action.** Turn the metrics on, and point them at an in-region destination
rather than Canada. This is the one item on this list that is both a
compliance improvement and an operational improvement, and it is small.

---

## 5. What changes at the UAE cutover

The move is a **re-deployment**, not a rewrite, and the reason it can be is
that everything in §3 is version-controlled and portable. The table says what
moves, what must be re-verified, and what genuinely does not change.

| Area                          | Today                                       | At the UAE cutover                                                         | Must be re-verified?                                                           |
| ----------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Application host              | OVHcloud, France                            | UAE region — 3 AZ                                                          | **Yes** — region code, image, flavor catalog, security group                   |
| **Primary datastore**         | Supabase, Frankfurt (`eu-central-1`)        | A store **inside the UAE** — this is the substantive move                  | **Yes** — data migration, connection string, pooler, and the retention workers |
| Edge                          | This project's Caddy + shared L4 front door | Identical, per zone                                                        | **Yes** — the front door's table, the ACME challenge path per zone             |
| Email                         | Resend `eu-west-1`                          | An in-country or regionally-appropriate sender, if the traffic is UAE data | **Yes** — sender domain, region, and the support-data flow                     |
| Metrics                       | Grafana Cloud Canada, **dormant**           | In-country, and **on**                                                     | **Yes**                                                                        |
| Backups                       | Dumps, location undecided                   | In-country, and a rehearsed restore                                        | **Yes**                                                                        |
| Voice processors              | US / UK                                     | Unchanged unless the carriers offer regional terms                         | **No** — but it is the item most likely to keep the transfer position open     |
| Application code              | —                                           | Unchanged                                                                  | **No** — this is the point                                                     |
| Certificates                  | Let's Encrypt, automatic                    | Unchanged                                                                  | **No**                                                                         |
| Trust model in `src/proxy.ts` | —                                           | Unchanged                                                                  | **No**                                                                         |

**The invariant to protect:** the move must not change the _application_. A
sovereignty migration that requires a code change is a migration that will be
deferred, and then the data stays in Europe. Everything in the table above the
line is infrastructure and configuration; everything below it is code, and the
code does not move.

### 5.1 The three-zone target

The target topology, in one paragraph, because it decides the order of
operations: **three availability zones, each with its own instance, its own
database replica and its own edge; a load balancer in front of the three
edges; and a failover story that is tested rather than described.** The edge
split in ADR-009 is a prerequisite for it rather than an alternative to it —
three zones behind one shared Caddy would have the same drift problem three
times over, and the same blast radius three times over.

The order that costs least:

1. **Split the edge** (this change). One product's failure stops being
   another product's failure. Works on one box.
2. **Add two more zones**, each with its own edge behind its own front door
   instance. The three zones are identical because the edge configuration is
   tracked — that is what ADR-009 bought.
3. **Put a load balancer in front of the three edges** and close R1 at the
   same time, because a load balancer is also the WAF and the DDoS
   mitigation.
4. **Move the zones into the UAE**, which by then is a provider-region
   change on a topology that is already redundant.

Doing step 4 first moves a single point of failure and calls it sovereignty.

---

## 6. Review trigger

This document is reviewed **on any of**: a change of hosting region or
provider; a new processor or sub-processor; a change to what the edge
publishes; the first three-zone deployment; the rehearsal of a restore; or
each anniversary, with `docs/ROPA.md`.

It carries the same evidence discipline as the rest of `docs/`: a claim with
no file behind it is `OPEN`, and the honest blank is the compliant entry.
