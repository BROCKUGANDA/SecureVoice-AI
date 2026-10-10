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
