# ADR-008: Blue/green on one box, with a drain that outlasts a call leg

## Context

Deployment interrupts the exact thing that must not be interrupted: a live call to a
customer whose card is being drained. A fraud call is short but not instantaneous, and
a container that dies mid-stream drops an audio socket the customer experiences as
silence from the bank they were told to trust.

The other half of the context is honesty about scale. This is one VPS behind one Caddy,
shared with a second product on the same edge. A document that describes
active-active multi-region failover while that is true is describing a system nobody is
operating.

## Decision

**Blue/green with a Caddy-level canary.** Each release is a colour (`blue`/`green`);
the `scripts/deploy.mjs` `stage` command starts and verifies the new colour on its own port,
`canary --percent N` shifts a slice of real traffic, `promote` completes it, and
`rollback` flips the pointer back. The state lives in the host's `.deploy/active.env`, which the
Caddy service mounts, and it is written **before** caddy is recreated — an earlier
version wrote it after, which is how a deploy could publish an edge config pointing at
a colour that had already been stopped.

**The canary mechanism is proportional repetition, because the obvious directive does
not exist.** Caddy 2.11.4 has no `weighted_round_robin` and rejects a `weight`
subdirective; the accepted policies are random, round_robin, least_conn, first,
ip_hash, uri_hash and cookie. So 5% is the old colour listed nineteen times and the new
colour once, which is exact over a window rather than probabilistic. It is
per-request, not per-session: this is a traffic split for exposing a build to real
load, and it must not be used as A/B routing for cohorts.

**Graceful drain, with the numbers matched to the domain.** On `SIGTERM`
(`scripts/server-preload.ts`) the instance flips `/api/readyz` to 503 and waits
`SHUTDOWN_DRAIN_MS`, default 65 s — chosen to exceed a Twilio call leg, and
`stop_grace_period: 75s` so Docker never kills it inside that window. Caddy's active
health check (`health_uri /api/readyz`) is what makes this real rather than
ceremonial: it observes the 503 and stops sending new requests while in-flight ones
finish against a process that is still alive. Without it, an instance is killed while
still in rotation, which is the dropped-call case this whole record exists to avoid.

**CI shares the host, and is fenced off from it.** The compose smoke test runs under
its own project name on its own ports, and asserts afterwards that production still has
its full container set and a healthy origin — because a job that can `docker compose
up` on the machine serving two products needs that assertion, not a comment.

## Consequences

**Positive.** Zero-downtime deploys with a real rollback that does not require a build.
Health-gated routing means the drain is observable instead of hoped for. Canary at 5%
against a live carrier before 100%.

**Negative, stated plainly, because this is where the claims get overclaimed.**

- **There is no region failover.** One box, one Caddy, one Postgres. A dead VPS is an
  outage, and read replicas with automatic promotion are not deployed. The HA story
  that competes is a canary plus a queue that survives a restart, which is genuinely
  valuable and is not multi-region.
- Deploys take longer by design — up to the drain window per instance.
- Colour state is host-local file state, so two operators running deploy at once is a
  race, and the skip-worktree'd edge config currently blocks the pull whenever a
  promoted commit touches `Caddyfile` (recorded in `docs/VPS-RECOVERY.md` failure mode
  #2, which understates it: the merge by hand does not unblock `--ff-only`).
- Blue/green holds two app containers during a deploy, and the memory ceiling for the
  box had to be measured for that overlap rather than for one instance.

## Evidence

`scripts/deploy.mjs` · `scripts/server-preload.ts` · `.deploy/active.env` · `Caddyfile` ·
`docker-compose.yml` (`app-direct`, `stop_grace_period`, `mem_limit`) ·
`docker-compose.ci.yml` · `.github/workflows/deploy.yml` · `.github/workflows/canary.yml` ·
`src/app/api/readyz/route.ts` · `docs/DEPLOY.md` · `docs/VPS-RECOVERY.md` · `docs/CAPACITY.md`
