# Runbook: EMAXCONNSESSION — connection pool exhausted

Manual incident response for the failure the retention worker surfaced in the
deploy logs:

```
EMAXCONNSESSION  max clients reached in session mode
                 - max clients are limited to pool_size: 15
```

## What this is, and what it is not

**Not** the retention worker being slow or leaky. It is the last process holding a
connection when the fleet crosses a **pooler** cap, so it gets named in the error
while the arithmetic that caused it is spread across seven containers.

`EMAXCONNSESSION` is a **pgbouncer / Supavisor** error, not a Postgres one. Read
together with `GET /api/readyz` reporting `database: managed-supabase`: production
is not talking to the compose `db` at all, it is talking to Supabase's pooler,
which caps **clients for the whole deployment** at a number that is not set in
this repository.

The arithmetic that produced it, before the fix:

| | before | after (default) |
| --- | --- | --- |
| main pool, per process | `cpus * 2 + 1` (9 on a 4-core VPS) | `1` |
| audit pool, per process | `5` | `1` |
| services sharing the URL | 7 | 7 |
| **worst-case clients** | **~98** | **14** |

The pooler allows 15. That is the bug, and it is why the only knob that mattered
was never the right one: `cpus * 2 + 1` measures the wrong resource. Connection
budget is shared with the other six processes; core count is not.

## Confirm it is this, and not a genuine leak

```sh
curl -s https://securevoiceai.me/api/readyz | jq '.checks[] | select(.name=="database")'
```

`managed-supabase` confirms the pooler. Then check whether processes are actually
holding connections, or merely being refused:

```sh
docker compose logs --tail=200 retention-worker | grep -c EMAXCONNSESSION
```

If the count climbs steadily while traffic is flat, suspect a real leak in that
worker rather than the cap — see step 4.

## 1. Confirm the fix has landed

```sh
docker compose logs app | grep "pool budget"
```

The boot line prints the arithmetic, so it is checkable rather than inferred:

```json
{"kind":"managed-supabase","sharedPooler":true,"main":1,"audit":1,"perProcessTotal":2}
```

An absent line means the running image predates the fix — roll forward before
debugging anything else.

## 2. Override without a rebuild

Both pools are operator knobs, so the first response is a `.env` change and a
restart, not a code edit:

```sh
# ~/securevoice-ai/.env
DB_POOL_MAX=2
DB_AUDIT_POOL_MAX=1
docker compose up -d --no-deps app retention-worker
```

**Do this only together with a quota raise.** Seven services at `2 + 1` is 21
clients against a 15-slot pooler, which is worse than the failure being fixed.
`tests/unit/db-pool.test.ts` pins that arithmetic in both directions precisely so
this cannot be done by accident.

## 3. The actual capacity fix (provisioning, not code)

No per-process value makes session mode comfortable for seven services on 15
slots. Pick one:

**Option A — raise the client quota.** In Supabase: Project Settings → Database →
Connection pooler → increase `pool_size`. Size it as
`services x (DB_POOL_MAX + DB_AUDIT_POOL_MAX)`, plus headroom for migrations and
`db-setup`. Remember each session-mode client pins a real Postgres backend for
its lifetime, so the quota has to fit the instance too.

**Option B — switch to transaction mode (recommended).** Supabase's transaction
pooler multiplexes many logical clients over few backend connections, which
removes this ceiling rather than raising it.

Option B is safe for this codebase, and that is worth stating precisely because
transaction mode normally breaks session state. The two features this system
depends on are both transaction-scoped:

- `src/lib/audit-chain.ts` — `pg_advisory_xact_lock(hashtext(callRef))`, inside
  `dbAudit.$transaction(...)`.
- `src/lib/billing/ledger.ts` — `pg_advisory_xact_lock(hashtext('ledger:' || orgId))`,
  inside its own `$transaction`.

Transaction mode pins one backend connection for the duration of a transaction,
so both locks hold exactly as they do today. There is no `LISTEN`, no
`pg_notify`, and no bare session-level `SET` anywhere in `src/` or `scripts/`
(scripts/walkthrough/node_modules is a vendored Playwright copy and does not
talk to this database).

## 4. If it is a real leak, not the cap

The cap explains a burst. It does not explain a monotone climb. Check whether
any worker is holding a transaction open:

```sh
docker compose exec db psql -U securevoice -d securevoice -c \
  "SELECT state, count(*) FROM pg_stat_activity WHERE datname='securevoice' GROUP BY state;"
```

A single `idle in transaction` row held for minutes is a leaked transaction and
outranks this runbook. The known offenders to check first are the two advisory
lock sites above: both must take the lock INSIDE the transaction and release by
returning, never by holding a client across an `await` on something outside the
database.

## After

`chainIntact=false` in a retention sweep log is this incident's fingerprint — the
chain verification query was the query that could not get a connection. If a
sweep reported a broken chain during an exhaustion window, re-run it once the
cap is resolved and confirm `chainIntact=true` before assuming any evidence was
lost. The chain is append-only, so a failed read cannot corrupt it, but it will
report `broken` until it can actually read every row.