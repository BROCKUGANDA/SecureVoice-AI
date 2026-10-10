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
containers, then health-checks `https://57.130.80.158.sslip.io/api/health`.

## Step 3 — Verify

```bash
docker compose ps                                   # all healthy
curl -s https://57.130.80.158.sslip.io/api/health   # 200
curl -s https://57.130.80.158.sslip.io/api/readyz | jq .status   # ok | degraded
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
   lines), the incoming change rewrites lines 104–128 (the
   `/realtime/media-stream` route). Took the incoming file, re-appended the
   site blocks, `caddy validate` → **Valid configuration**, re-asserted
   skip-worktree. The pull then succeeded and the VPS is on `f5396dd`.
3. Dispatched a fresh deploy from main (the CI-green guard passed).

**The Supabase question — first answered wrongly, then settled by evidence.**
The initial pass counted the bundled db and Supabase and declared both empty —
that conclusion was WRONG, because it counted only the four better-auth tables
and two test tables, never the real ones. A full count of every table on both
sides gave the true answer:

| | bundled (`db` container) | Supabase |
|---|---|---|
| `Case` | 0 | **1,006** |
| `AuditLog` | 26 | **7,992** |
| `UserProfile` | 0 | **88** |
| tables | 19 | 37 |

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


## Failure mode #2 — the deploy's `git pull` refuses: "local changes to Caddyfile would be overwritten"

Deploy 38018564836 died at `git pull --ff-only` with:

```
error: Your local changes to the following files would be overwritten by merge:
	Caddyfile
Please commit your changes or stash them before you merge.
```

The VPS Caddyfile is deliberately VPS-local (per-site blocks for the shared
edge) and protected with `git update-index --skip-worktree` — and the deploy
re-asserts that flag before pulling. It still refused because the promoted
commits **modify the Caddyfile itself** (the union added the
`handle /realtime/media-stream` block that routes the voice-stream worker's
Twilio Media Streams websocket). Skip-worktree preserves the local version, but
a merge that would change a skip-worktree'd file is refused rather than
silently dropped — the deployment-local edge config wins, loudly.

This is the correct behavior; the VPS-local Caddyfile now needs the new block
merged into it by hand. On the VPS:

```bash
cd ~/securevoice-ai
git fetch origin main
# 1. See what the VPS-local version adds (the per-site blocks to KEEP):
git diff HEAD -- Caddyfile Caddyfile.platform
# 2. See what the incoming commits add (the block to TAKE):
git diff HEAD origin/main -- Caddyfile Caddyfile.platform
```

Then merge: keep the VPS-local per-site blocks and add the incoming
`handle /realtime/media-stream { reverse_proxy voice-stream-worker:8080 … }`
block (and any other incoming hunks) to the VPS file, so the file becomes
"VPS-local + incoming". Commit it locally, or if the VPS-local diff turns out
to be empty/stale, simply `git checkout -- Caddyfile Caddyfile.platform`. Then:

```bash
git update-index --skip-worktree Caddyfile Caddyfile.platform
git pull --ff-only origin main
```

Do this **before or together with** the db remediation — the deploy runs the
pull first, so an unmerged Caddyfile blocks the roll regardless of the db
state.
