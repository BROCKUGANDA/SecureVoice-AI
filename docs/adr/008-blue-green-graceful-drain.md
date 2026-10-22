# ADR-008: Blue/green on one box, with a drain that outlasts a call leg

## Context

Deployment interrupts the exact thing that must not be interrupted: a live call to a
customer whose card is being drained. A fraud call is short but not instantaneous, and
a container that dies mid-stream drops an audio socket the customer experiences as
silence from the bank they were told to trust.

The other half of the context is honesty about scale. This is one VPS behind one Caddy.
A document that describes
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

**The override is a MINIMAL OVERRIDE of the SAME compose project.** This is the
part that was wrong and has been changed. `docker-compose.bluegreen.yml` used to carry
its own `name:`, its own `db`, its own `db-setup`, its own `realtime` and its own volumes,
which made it a **second compose project** — and a second project owns a second set of
named volumes, so the colour slots would have been talking to a **second, empty
Postgres** while production's data sat in the first project's volume. The failure mode
is not a crash: it is a colour that starts perfectly happily against an empty
database and serves 200s to a canary, which is precisely the state a canary cannot
detect. The file now adds **only** the two colour slots; the database, the migration
job, realtime, Redis, the workers, the volumes and Caddy all come from the base file,
in the same project. `tests/unit/bluegreen-invariants.test.ts` asserts this about the
compose files rather than about the script that drives them, because the file is where
the second database would have come from.

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
its full container set and a healthy origin — because a job that can `docker compose up`
on the machine serving two products needs that assertion, not a comment.

**The rollout is AUTOMATIC, and the adoption is not.** The `Canary` workflow used to be
`workflow_dispatch` only, so blue/green was a thing an operator had to remember to run —
and a canary nobody runs is not a canary. It now fires on `workflow_run` of the `Deploy`
workflow: the deploy stages the release into the idle colour and moves 5% of the traffic
to it, and the canary workflow gates on the staged colour's own readiness **and** on the
public edge, widens to 25% and then to 100%, and promotes. Any red gate rolls back and
probes the edge before declaring success. On a host that has not adopted the colour
slots the canary workflow exits **successfully** with a notice, because a canary workflow
that goes red on every deploy of a plain host trains everyone to ignore it — and the one
time it would have mattered is the one time it is ignored.

Moving a live deployment ONTO the colour slots stays an operator step
(`bun scripts/deploy.mjs adopt`), because it changes which container serves production
and there is no old colour to fall back to — the old colour _is_ the plain `app`
container. The adoption stages the first colour on the build that is already serving (an
adoption on a different build would be an unannounced release), proves it healthy,
points Caddy at it, proves the edge answers, and only then stops the plain container —
stopped, not removed, so the rollback is a `start` away.

**Container identity is resolved by compose label, not by name.** The colour slots used
to declare `container_name: securevoice-app-blue`, so `docker inspect app-blue` looked for
a container called `app-blue` that does not exist — the real name is the project-prefixed
one. Every health wait and every in-container probe addressed a container that was never
there, so a colour that was starting up looked exactly like a colour that had died.
`scripts/deploy.mjs` now resolves containers through the `com.docker.compose.project` and
`com.docker.compose.service` labels, which are the one thing that survives a rename, a
replica count and a container-name policy change.

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
  race. (The skip-worktree'd edge config that used to block any pull touching
  `Caddyfile` was retired 2026-10-12, and the host-local site directory that replaced
  it was retired 2026-10-12, and the host-local site directory that replaced
  it was retired 2026-10-22: the edge is now one project per edge, configured by a
  tracked `Caddyfile` and a tracked front-door table. See
  `docs/adr/009-isolated-edge-per-project.md` and `docs/VPS-RECOVERY.md` failure
  modes #2 and #3.)
- Blue/green holds two app containers during a deploy, and the memory ceiling for the
  box had to be measured for that overlap rather than for one instance.
- **The canary split is per-request, so a single conversation can be split across two
  colours.** The agent's state lives in the case row and the provider's conversation,
  not in process memory, so this is survivable — but it is not free, and it is a
  property to know about rather than discover.
- **A host that has not adopted the colour slots gets none of this.** The automatic
  path detects that and does the plain thing, so the feature is opt-in on the host
  and automatic on the release.

## Evidence

`scripts/deploy.mjs` · `scripts/server-preload.ts` · `.deploy/active.env` · `Caddyfile` ·
`docker-compose.yml` · `docker-compose.bluegreen.yml` · `tests/unit/bluegreen-invariants.test.ts` ·
`docker-compose.ci.yml` · `.github/workflows/deploy.yml` · `.github/workflows/canary.yml` ·
`src/app/api/readyz/route.ts` · `docs/DEPLOY.md` · `docs/RUNBOOK.md` · `docs/VPS-RECOVERY.md` · `docs/CAPACITY.md`
