# VPS Recovery Runbook — production DB unreachable (deploy 38012365047)

_Incident date: 2026-10-10. Author: agent session, from the deploy log evidence._

## What happened

`main` CI went green at 01:08Z and the deploy fired automatically
(38012365047). It failed in 15s at the **health gate** with the origin's own
logs showing:

```
app-1  | prisma:error Connection terminated due to connection timeout
app-1  | Invalid `prisma.outboxEvent.findFirst()` invocation:
app-1  | Can't reach database server at db
retention-worker-1 | [retention-worker] at 2026-10-08/09T06:04:09 dryRun=false ... chainIntact=true
```

So this is **not a code failure** — the promoted commit is fine (CI proved it,
including the migration-drift gate). The _currently deployed_ stack cannot
reach its database at host `db`, which means the bundled `db` container is
down or unreachable. The retention-worker lines timestamped Oct 8–9 are the
same abort recorded in the ledger's disk-full OPS blocker — this is that
incident, still unresolved.

## Step 0 — Access and triage (SSH to the VPS)

```bash
ssh ubuntu@<vps-ip>
cd ~/securevoice-ai
df -h                              # disk is the standing suspect
docker compose ps                  # is db up? healthy?
docker compose logs --no-color --tail 100 db
docker stats --no-stream           # memory pressure?
```

Expected findings, in likelihood order:

1. **Disk full** → Postgres cannot write (WAL, temp, checkpoints) and starts
   refusing connections. Fix: `sudo docker system prune -af --volumes=no`
   (NEVER `--volumes`: `db-data` is production), plus
   `sudo journalctl --vacuum-size=200M` and
   `sudo rm -rf /home/ubuntu/actions-runner/_diag/*`.
2. **The `db` container is down** (aborted roll) → `docker compose up -d db`,
   wait for `healthy`, then `docker compose ps`.
3. **Corrupted volume** → restore the most recent
   `/srv/backups/pre-*.sql.gz` (DEPLOY.md's update path writes one before
   every deploy).

Do not proceed until `docker compose ps` shows `db` healthy and
`curl -s localhost:3000/api/health` (or the app's logs) stops showing DB
errors.

## Step 1 — Settle the production-database question (do this BEFORE re-deploying)

**Evidence on both sides:**

- The deployed app's connection host is `db` — the compose-bundled Postgres.
  Whatever data the Oct 8–9 retention-worker was shredding lives THERE, in the
  `db-data` volume.
- The owner has stated **Supabase is the production database**. The `.env` used
  for dev/CI points at `db.zoxpovjgdakudsycedzc.supabase.co`, and that project
  is fully migrated (31/31, verified 2026-10-10) — but its row counts after the
  e2e cleanup were `WorkflowDoc 0 / Document 0`, i.e. it may not hold the live
  case history the bundled DB holds.

**Decision (per the owner's stated intent): Supabase is production.** The VPS
must be pointed at it explicitly, and the bundled DB's data must be reconciled
first, or the switch silently regresses case history:

```bash
# 1. BACK UP the bundled DB (it may hold the real case history)
docker compose exec -T db pg_dump -U securevoice securevoice | gzip > /srv/backups/pre-supabase-cutover-$(date -u +%FT%H%M).sql.gz

# 2. Compare row counts, both sides, before trusting either
docker compose exec -T db psql -U securevoice -d securevoice -c \
  "select 'cases' t, count(*) from \"Case\" union all select 'audit', count(*) from \"AuditLog\";"
# ...and the same against Supabase with the DATABASE_URL from the team's credentials.

# 3. If the bundled DB is ahead, restore its dump INTO Supabase (schema already
#    matches — 31/31 migrations verified). Restore data-only if you prefer:
#    pg_restore --data-only --no-owner --no-privileges -d "$SUPABASE_URL" dump.sql
```

Then set the VPS `.env` (the compose services read `${DATABASE_URL:-...@db...}`,
so an explicit value overrides the bundled default):

```
DATABASE_URL=postgresql://<user>:<password>@db.zoxpovjgdakudsycedzc.supabase.co:5432/postgres?sslmode=verify-full
```

Take the connection string from the team's credential store — **never commit
it**. Remove `POSTGRES_*` from the VPS `.env` only after the cutover is proven
(a stale `POSTGRES_PASSWORD` is harmless while DATABASE_URL is set).

> **Note for DEPLOY.md:** its "do not set a full DATABASE_URL" rule assumed the
> bundled Postgres was production. With Supabase as production, the explicit
> `DATABASE_URL` is now the correct configuration; that section needs updating
> to match this decision.

## Step 2 — Re-run the deploy

```bash
gh run rerun 38012365047 --failed     # from any machine with gh auth
```

The deploy builds `app dial-worker retention-worker db-setup`, runs
`prisma migrate deploy` (both new migrations are additive — `WorkflowDoc` and
the onboarding columns — so they apply cleanly to either database), rolls the
containers, then health-checks `https://securevoiceai.me/api/health`.

## Step 3 — Verify

```bash
docker compose ps                                   # all healthy
curl -s https://securevoiceai.me/api/health   # 200
curl -s https://securevoiceai.me/api/readyz | jq .status   # ok | degraded
docker compose logs --no-color --tail 50 app | grep -i "prisma:error"   # must be empty
docker compose exec -T db psql -U securevoice -d securevoice \
  -c 'SELECT migration_name FROM _prisma_migrations ORDER BY finished_at;' | tail -5
# (if Supabase is the target, run that migration query against Supabase instead —
#  it must end with 9zzzzzzzzzzzzzz_agent_workflows and 9zzzzzzzzzzzzzzz_enterprise_onboarding)
```

## Standing rules that came out of this

1. The two new migration files are **applied** — never edit them again; further
   schema changes need new migration files (that drift is what
   `2_outbox`/`3_postcall` already carry).
2. Every deploy takes a `pg_dump` first (DEPLOY.md's update path). Keep it.
3. If the runner disk fills again, CI queues rather than fails — a green
   promotion PR can sit unmerged for that reason alone. `df -h` on the VPS is
   the first thing to check when the ladder stalls.

## RESOLUTION (2026-10-10) — what the incident actually was, and what was done

**Diagnosis corrected by hands-on triage.** The disk was never full (19G
free); the pressure was **23 stale CI containers** left by five failed Oct 8–9
runs (three full `svci-*` compose stacks + two `sv-ci-*` db/redis), plus
**15.4GB of build cache** and ~4GB of dead volumes. Load average sat at 2.5.
The app's `Can't reach database server at db` errors were from **Oct 8** —
stale; the app was up and serving the whole time (in-container `/api/health`
→ 200, `uptimeSec` 168376). The origin was never actually down.

**Remediation executed over SSH (deploy key):**

1. Brought down the three stale CI compose projects with `down -v`, removed
   the two leftover CI containers, pruned the build cache (15.4GB), pruned
   unused images (10.9GB) and dangling volumes (3.9GB). Disk: **81% → 30%
   used** (78G → 29G). Production volumes (`securevoice-ai_db-data` et al.)
   untouched; `crucible-*` (the other project on the shared edge) untouched.
2. Merged the Caddyfile: the VPS-local changes were **pure appends** (the
   `crucible.svalley.tech` / `securevoice.svalley.tech` site blocks, 106
   lines — `securevoice.svalley.tech` has since been retired, 2026-10-12), the
   incoming change rewrites lines 104–128 (the `/realtime/media-stream` route).
   Took the incoming file, re-appended the site blocks, `caddy validate` →
   **Valid configuration**, re-asserted skip-worktree. The pull then succeeded
   and the VPS is on `f5396dd`.
3. Dispatched a fresh deploy from main (the CI-green guard passed).

**The Supabase question — first answered wrongly, then settled by evidence.**
The initial pass counted the bundled db and Supabase and declared both empty —
that conclusion was WRONG, because it counted only the four better-auth tables
and two test tables, never the real ones. A full count of every table on both
sides gave the true answer:

|               | bundled (`db` container) | Supabase  |
| ------------- | ------------------------ | --------- |
| `Case`        | 0                        | **1,006** |
| `AuditLog`    | 26                       | **7,992** |
| `UserProfile` | 0                        | **88**    |
| tables        | 19                       | 37        |

**Supabase is the real production database. The bundled volume is an empty
shell that was never populated** — and the app had been pointed at it the whole
time, which is why everything looked healthy while serving nothing: `/api/health`
only proves the connection is up, never that there are rows behind it.

**Cutover performed** (VPS `.env` repointed, then re-rolled):

- Supabase's **direct** connection (`db.<ref>.supabase.co:5432`) is
  **IPv6-only**; the VPS has no IPv6 outbound (`api.ipify.org -6` → 000).
  That is the structural reason the app could never have reached the data.
- Uses Supabase's **IPv4 pooler** instead, session mode:
  `aws-0-eu-central-1.pooler.supabase.com:5432`, user `postgres.<project-ref>`,
  same password, `connection_limit=20`.
- `sslmode=no-verify`, deliberately not verify-full: the pooler terminates TLS
  with an **AWS ELB** certificate, and the slim app image carries no AWS root
  CAs, so verification fails with "self signed certificate in certificate
  chain". `no-verify` still encrypts — the documented pooler pattern for slim
  images. (The committed `supabase-ca.crt` only covers the direct endpoint.)
- 31 migrations, "No pending migrations to apply". Verified live: ~20 pooled
  connections from the app, the dial worker running `UPDATE "dial_job"`, the
  real 1,006 cases served, `/api/health` 200.
- Previous `.env` preserved at `.env.bak-presupabase` on the VPS.
- **The `db` container is left running but is now unused** — no service reads
  it. Its emptiness is not a fault; do not "fix" it.
- **Near-miss recorded:** `docker compose up -d db-setup` runs the service's
  default command, which **seeds demo data into production**. The real deploy
  deliberately overrides the entrypoint to run only `migrate deploy`. Always
  migrate on the VPS with
  `docker compose run --rm --no-deps db-setup sh -c "bunx prisma migrate deploy"`
  — never `up -d db-setup`.

**One real gap found and fixed:** `deploy.yml` built and upped
`app dial-worker retention-worker db-setup` — the union's new
`voice-stream-worker` (the entire Twilio Media Streams plane, plus the
`/realtime/media-stream` Caddy route that targets it) was in neither list, so
a roll would have left the newest plane unstarted and its route 502ing.
Added to both lists (`fix(deploy): roll the voice-stream worker with the app`).

## Failure mode #2 — the deploy's `git pull` refuses on `Caddyfile` (RESOLVED 2026-10-12)

Deploy 38018564836 died at `git pull --ff-only` with:

```
error: Your local changes to the following files would be overwritten by merge:
	Caddyfile
Please commit your changes or stash them before you merge.
```

The VPS Caddyfile was then VPS-local — per-site blocks for the shared edge,
inline — and protected with `git update-index --skip-worktree`. Skip-worktree
preserves the local version, but a merge that would change a skip-worktree'd
file is refused rather than silently dropped: the deployment-local edge config
wins, loudly. So every promoted commit that touched the Caddyfile blocked the
roll until an operator SSH'd in and merged the two copies by hand — and the
hand-merge only unblocked `--ff-only` until the next Caddyfile commit.

**The root cause was the arrangement, not the merge: one tracked file was both
product config and host-local edge config.** The fix (2026-10-12) removes the
conflict instead of resolving it instance by instance:

- The tracked `Caddyfile` is now the SAME BYTES on every machine. Its site
  list is literal (`localhost`, `securevoiceai.me`), and since 2026-10-22 it
  is the WHOLE list: the host-local site directory that used to be imported
  at the bottom of it is gone (failure mode #4). The env-driven `{$SITE_ADDRESS:localhost}` block
  is gone — besides colliding with the literal block (`ambiguous site
definition`, measured), it was the reason the two copies had to diverge.
- Skip-worktree is RETIRED, on the box and in deploy.yml. A promoted
  Caddyfile change now pulls and deploys like any other file.

**If a pull is ever refused on `Caddyfile` again**, the box has hand-edits the
repo does not know about — that is the only way to make the file dirty now.
Run `git update-index --no-skip-worktree Caddyfile Caddyfile.platform` first
(a lingering flag hides the dirtiness from `git diff`), then `git diff --
Caddyfile`; anything worth keeping is a site block that belongs in the tracked
`Caddyfile`, in a reviewed change. Then:

```bash
cd ~/securevoice-ai
git checkout -- Caddyfile Caddyfile.platform
git pull --ff-only origin main
```

Editing the `Caddyfile` needs a Caddy process restart — `admin off` means
there is no reload endpoint: `docker compose up -d --force-recreate caddy`.

## Failure mode #3 — the shared `:local` image tag (RESOLVED 2026-10-12)

`docker-compose.yml:611` pins the app service to
`image: ${IMAGE:-securevoice-ai-app:local}` — **one tag, shared by whatever
compose project builds the app service on this host**. Production's deploy path
builds that tag from `main`; so does every CI smoke test, because the smoke
throwaway `.env` never set `IMAGE`. Measured on the box: the production app
container ran `sha256:2a44dee87a3b` (the v0.2.2 deploy build, dangling/untagged)
while the tag `securevoice-ai-app:local` pointed at `sha256:1db8b90dd056`, a
**v0.2.1** build left by a smoke test of a dev checkout. Any `up -d` from that
state rolls production BACKWARD to the stale image, silently — the health check
would still be 200, because v0.2.1 boots fine.

**What was done:**

1. Rolled `app` forward to the published release artifact
   (`IMAGE=ghcr.io/brockuganda/securevoice-ai:v0.2.2 docker compose up -d
--no-deps --force-recreate app`); verified `/api/health` reports `version:
0.2.2` and the container's image ID is the registry digest.
2. Repaired the box's tag: `docker tag 2a44dee87a3b securevoice-ai-app:local`
   so a future default-tag roll cannot resurrect v0.2.1.
3. Fixed the cause in the workflows: both smoke jobs (ci.yml's
   `compose-smoke`, release.yml's smoke) now write
   `IMAGE=<project>-app:latest` into their throwaway `.env`, so a test build
   can never name itself after production again.
4. Pruned ~30 GB of leaked `svci-*` smoke-stack images (eight ~3.8 GB worker
   images per run, never reclaimed — `down` never touches images). The
   reclaim step in ci.yml now removes `svci-`/`sv-ci-` images by name, with the
   same never-match-production guard its volume loop carries.

**Standing rule:** the disk this runner lives on filled from exactly these
leaks (stacks, caches, images) — three of the same kind of failure, and the
buildkit `graceful_stop` that killed three dev pushes on 2026-10-12 died on the
same 79%-full disk. Check `df -h /` before believing any compose failure here
is a code failure.

## Failure mode #4 — the shared edge (RESOLVED 2026-10-22)

**The failure.** One Caddy container served two products. It reached the other
product's containers **by service name**, which only resolves from inside that
product's Docker network, so it was hand-attached to a network this project's
compose file does not own. `docker compose up` rebuilds a container from _its
own_ compose definition, so every recreate dropped those attachments.

On **2026-10-21** a traffic flip recreated the edge, the attachment was
silently dropped, and the other product answered 502 for every request while
every one of its own containers reported itself healthy. One product's deploy
was the other product's outage.

**The first fix** (this repository, commit `3edcbc4`) preserved the
attachments across a recreate. It worked, and it was the wrong shape: it kept
a cross-project capability alive and left the blast radius exactly where it
was. It is superseded by the arrangement below.

**The resolution.** One edge per project, behind a shared L4 front door.
`docs/adr/009-isolated-edge-per-project.md` is the decision;
`edge/README.md` is the topology.

### The cutover, in order

**The ordering constraint is the whole procedure:** the OTHER product must
already have its own edge behind the front door before this product detaches.
Skipping that step takes the other product offline. There is no ordering that
lets both products be cut over independently on a shared host — which is
precisely why the shared edge had to be scheduled, not merely implemented.

**Step 0 — the other product's half (not this repository's job).**

- That product stands up its own Caddy from its own `Caddyfile`, in its own
  compose project, published on its own loopback port.
- It ships its own map files into the front door's fragment directory:
  `edge/nginx/edge.d/<project>.sni.map` and `<project>.host.map`.
- It verifies its own names answer publicly.

**Step 1 — stand up the front door.**

```bash
mkdir -p /srv/edge/edge.d
cp ~/securevoice-ai/edge/nginx/edge.d/securevoice.*.map /srv/edge/edge.d/
cp ~/securevoice-ai/edge/nginx/edge.conf /srv/edge/edge.conf
cp ~/securevoice-ai/edge/compose.yml /srv/edge/compose.yml

cd /srv/edge
docker compose up -d
docker compose exec router nginx -t     # validates BEFORE it would serve
```

**Step 2 — move this product's edge behind it.** In the host's `.env`:

```ini
CADDY_BIND=127.0.0.1
CADDY_HTTP_PORT=8080
CADDY_HTTPS_PORT=8443
```

Then recreate the edge so the new bindings take effect. **This is the step
that needs a window**: the public `:443` moves from the edge to the front
door, and there is a moment where the socket is being rebound.

```bash
cd ~/securevoice-ai
docker compose up -d --no-deps caddy
```

**Step 3 — verify before detaching anything.**

```bash
bun scripts/deploy.mjs edge-status
```

The report must show: the front door's table matching the ports the edge
actually publishes, and the public names answering. `edge-isolate` re-runs
these as hard preconditions and refuses if any fails.

**Step 4 — cut over.**

```bash
bun scripts/deploy.mjs edge-isolate --yes
```

It detaches the edge from the foreign networks, flips the deploy state to
`isolated`, and re-probes the public path. It refuses without `--yes`,
because the other product's half is not this repository's to verify.

**Step 5 — the steady state.**

- `bun scripts/deploy.mjs edge-status` reports `isolated`.
- The edge is on `securevoice-ai_default` and nothing else.
- The retired `sites.d/` directory on the box is now inert and can be removed
  once the other product's site block has been moved into its own edge.
- The deploy script now **refuses** to recreate the edge if a foreign
  attachment reappears, instead of preserving it. That is the invariant, and
  it is what stops the arrangement from drifting back.

### If the cutover goes wrong

The edge is detached with one command, and re-attaching is one command:

```bash
docker network connect <foreign-network> $(docker ps -q \
  --filter label=com.docker.compose.service=caddy \
  --filter label=com.docker.compose.project=securevoice-ai)
```

`edge-isolate` prints the exact command for each network it detached, and
prints it again if the public path fails after the detach. **Keep that
output.**

### The standing rule

**A container that is attached to a network it does not own is a configuration
error, and it is reported rather than accommodated.** The previous behaviour
— preserve it, because dropping it caused an outage — was a mitigation for a
symptom that had a better fix. `bun scripts/deploy.mjs edge-status` answers
"is this edge still shared?" in one command, and it is safe to run at any
time, including during an incident.
