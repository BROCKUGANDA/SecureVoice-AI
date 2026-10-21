# Deploying SecureVoice AI to a VPS (docker-compose, production)

This deploys the compose stack **as-is** — Postgres 16, the Next.js app, the
realtime socket service, and Caddy terminating TLS. Nothing else publishes a
port, which is what keeps the `src/proxy.ts` trust model sound.

Estimated time: ~15 minutes on a fresh box.

---

## 1. Provision

- **Server**: 2 vCPU / 4 GB minimum (reference deployment: OVHcloud, `d2-8`, 8 GB) — Next build + Postgres + sockets
  do not fit comfortably in 2 GB. Debian 13 or Ubuntu 24.04.
- **Region**: pick the one closest to where calls are answered (tool
  round-trips are in the voice path; transatlantic latency is audible).
  **OVHcloud region codes, not AWS names**: `GRA11` (Gravelines), `GRA9`,
  `SBG5` (Strasbourg), `BHS5` (Beauharnois), `WBG1` (Warsaw). There is **no UAE
  or GCC region** — if a deployment must promise in-country hosting for PDPL,
  confirm the actual data path with OVHcloud in writing first.
- **Swap** (builds OOM without it on 4 GB):

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile
swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

- **Docker**:

```bash
curl -fsSL https://get.docker.com | sh
docker compose version   # must be >= v2.24 (env_file `path:`/`required:` syntax)
```

- **Log rotation** (compose also sets per-service limits; this is the backstop):

```bash
cat > /etc/docker/daemon.json <<'EOF'
{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"5"},"live-restore":true}
EOF
systemctl restart docker
```

## 2. Firewall (provider cloud firewall if one exists — OVHcloud, Hetzner and DigitalOcean all have them — otherwise ufw. Pick one, not both.)

**On OVHcloud, an OpenStack security group is an allow list**: traffic matching
no rule does not pass, on every interface. That is default-deny in effect, but
it is not a deny _policy_ — there is nothing behind your rules to catch a mistake.
Anything not in the list below is denied by omission, so an omitted rule is a
hole you have to notice rather than one that fails loudly. Postgres (5432) and
the realtime socket service (9090) are unpublished for exactly this reason and
must never appear in this list.

| Inbound | Why                          |
| ------- | ---------------------------- |
| TCP 22  | SSH — restrict to your IP    |
| TCP 80  | ACME HTTP-01 (Let's Encrypt) |
| TCP 443 | HTTPS                        |
| UDP 443 | HTTP/3 (optional)            |

Nothing else. **5432, 3000, 4000 must stay closed** — the entire edge trust
model depends on the origin being unreachable except through Caddy.

## 3. DNS

```
A    voice.example.com   →  <VPS IPv4>
```

- Do **not** add an AAAA record unless the box actually serves IPv6 — Caddy
  will attempt issuance over it and fail.
- Wait for propagation before first boot: `dig +short voice.example.com @1.1.1.1`

## 4. Better Auth (before you build - this is a hard blocker)

`BETTER_AUTH_SECRET` is read at **runtime**, so unlike the Clerk setup it is not
inlined into the bundle - but it is still a hard blocker: if it is missing or
shorter than 32 characters, `src/lib/better-auth.ts` throws at import and every
request 500s, so Caddy never starts.

Generate one per environment and commit it only to that environment's secrets:

    node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

`BETTER_AUTH_API_KEY` is optional. Without it the app runs normally and only the
license-gated Better Auth infra features (dash telemetry) are disabled.

**Rotating `BETTER_AUTH_SECRET` invalidates every existing session** and every
stored credential, because it signs the session cookie and encrypts stored
credentials. Treat a rotation as a forced logout of all users.

**Provisioning an operator:** sign-up is invite-only
(`src/lib/auth/signup.ts` refuses public registration). Create the user, add it to
the Better Auth `organization` for its tenant, and grant the member role there -
roles come from organization membership, not from a field on the user row. A user
with no organization gets the default (no-tenant) namespace and cannot reach
another tenant's data.

**No domain yet?** Nothing here depends on one. Auth is same-origin at
`/api/auth/*`, so there is no third-party identity instance to create and no DNS
verification to complete - unlike the retired Clerk flow, which required a
production instance before real users. Deploy directly.

No domain yet for TLS either? The tracked `Caddyfile` serves a literal
`localhost` block with an internal (self-signed) certificate, so the stack is
reachable on the box immediately. To serve a real hostname before DNS exists,
add `<vps-ip>.sslip.io` (free instant DNS that resolves to your IP) as a site
block — `echo '<vps-ip>.sslip.io { import site }' > sites.d/<vps-ip>.sslip.io.caddy`
on the box, then `docker compose up -d --force-recreate caddy`; Let's Encrypt
issues for it. Swap to the real domain later by editing `securevoiceai.me` and
`www.securevoiceai.me` in the `Caddyfile` and restarting Caddy. Note
`SITE_ADDRESS` does NOT choose what Caddy serves — it is the app's own
canonical hostname (see below) and Caddy's site list is separate.

## 5. Configure

```bash
useradd -m -s /bin/bash deploy && usermod -aG docker deploy
su - deploy
git clone <your-repo-url> /srv/securevoice && cd /srv/securevoice
cp .env.example .env && chmod 600 .env
```

Edit `.env`:

```ini
# — Required —
# The app's canonical hostname (canonical links, Twilio media-stream URL). What
# Caddy SERVES is the literal site list in Caddyfile + sites.d/*.caddy — not this.
SITE_ADDRESS=voice.example.com
ACME_EMAIL=ops@example.com
POSTGRES_PASSWORD=<openssl rand -base64 24>
AUTH_SECRET=<openssl rand -base64 48>
WEBHOOK_SECRET=<openssl rand -hex 32>
REALTIME_INGEST_SECRET=<openssl rand -base64 32>
BETTER_AUTH_SECRET=<node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))">   # >=32 chars, runtime env, per environment
# BETTER_AUTH_API_KEY is optional - enables Better Auth dash telemetry only

# — Safe first-boot defaults —
ELEVENLABS_DRY_RUN=true            # flip false only when voice keys are in
AGENT_TOOL_ALLOWED=human_handoff   # add card_freeze only after go-live sign-off
SEED_DEMO=true                     # false for an empty production dashboard
```

**Do not set** `REALTIME_URL` (compose default `http://realtime:4000` is
correct; `127.0.0.1` silently kills the push path) or a full `DATABASE_URL`
(compose builds it from the `POSTGRES_*` parts).

> Note: changing `POSTGRES_PASSWORD` after first boot does nothing — the
> password is baked into the Postgres role when the volume is created.

## 6. First boot (staged — do not cold `up -d`)

```bash
docker compose config --quiet          # parse check
docker compose run --rm --env-file .env db-setup bun scripts/preflight.mjs   # GO/NO-GO
docker compose build --pull            # ~3–5 min on CX32
docker compose up -d db
docker compose up db-setup             # runs prisma migrate deploy + seed; MUST exit 0
docker compose up -d app realtime
docker compose ps                      # app must be (healthy) before continuing
docker compose up -d caddy
docker compose ps                      # ALL services (healthy)
curl -I https://voice.example.com/healthz
```

`preflight` prints the one table that answers "did we forget anything" —
including whether voice is DRY-RUN and whether the Better Auth secret is set
instance. Run it before every demo and every go-live; the same warnings are
also printed at every app boot (`docker compose logs app | grep config`).

Verify the realtime handshake and the certificate:

```bash
curl -s 'https://voice.example.com/realtime/?EIO=4&transport=polling' | head -c 60
echo | openssl s_client -connect voice.example.com:443 2>/dev/null | openssl x509 -noout -issuer
```

Then sign in as the operator in a browser and confirm the Command Center
renders the seeded audit chain.

**Take a baseline backup immediately:**

```bash
mkdir -p /srv/backups
docker compose exec -T db pg_dump -U securevoice securevoice | gzip > /srv/backups/securevoice-init.sql.gz
```

## 7. Update path (every deploy)

```bash
cd /srv/securevoice
docker compose exec -T db pg_dump -U securevoice securevoice | gzip > /srv/backups/pre-$(date -u +%FT%H%M).sql.gz
git pull --ff-only

# BOTH images must be rebuilt, and this is not optional.
#   app       — the application code changed.
#   db-setup  — it runs `prisma migrate deploy` against files baked into its
#               image. A plain `up -d` after a git pull reuses the previous
#               db-setup image, which does not contain the new migration, and
#               reports "No pending migrations to apply" while the database is
#               actually behind. This has silently shipped twice on this
#               project. CI fails the build on schema drift for the same reason.
docker compose build --pull app db-setup
docker compose up -d

docker compose logs db-setup | tail -5     # must say "All migrations have been successfully applied"
docker compose ps && curl -s https://voice.example.com/healthz
curl -s https://voice.example.com/api/readyz | jq .status   # ok | degraded
```

Verify the migration actually landed — this is the check that catches a stale
db-setup image:

```bash
docker compose exec -T db psql -U securevoice -d securevoice \
  -c 'SELECT migration_name FROM _prisma_migrations ORDER BY finished_at;'
```

Schema changes are versioned SQL in `prisma/migrations/` and applied by
`prisma migrate deploy` in db-setup. **Never** reintroduce
`db push --accept-data-loss` — it applies destructive changes silently.

### 7.1 Blue/green + canary (automatic, on the self-hosted runner)

The self-hosted runner deploys with **zero downtime and an automatic
rollback**. It is three commands and one adoption step.

**The rollout:**

```
main ──▶ CI green ──▶ Deploy workflow ──▶ stage the new colour ──▶ first split of traffic
                                       └─▶ Canary workflow (automatic) ──▶ mid split ──▶ 100% ──▶ promote
                                                                                   └─▶ any red gate ──▶ rollback
```

- The **Deploy** workflow builds, migrates, rolls the shared workers and then
  stages the release into the IDLE colour slot, moving the first split of the
  traffic to it. The old colour keeps serving the rest for the whole time.
- The **Canary** workflow fires automatically when the Deploy workflow
  succeeds (`workflow_run`). It gates on the staged colour's own readiness AND
  on the public edge, widens to the mid split and then to 100%, and promotes —
  retiring the old colour only at the very end, because until it runs the
  previous build is still warm and a rollback is a traffic flip rather than a
  cold rebuild.
- **Any red gate rolls back.** The previous colour is restored and the edge is
  probed before the workflow declares success.

**The splits and the soak are DEPLOYMENT SETTINGS, not constants.** The Canary
workflow reads them from repository variables, and `scripts/deploy.mjs` reads
the same names from the environment on the box:

| Variable                        | Default            | What it decides                                       |
| ------------------------------- | ------------------ | ----------------------------------------------------- |
| `CANARY_START_PERCENT`          | `5`                | The first split the canary widens to                  |
| `CANARY_MID_PERCENT`            | `50`               | The second split, before the release goes to 100%     |
| `CANARY_SOAK_SECONDS`           | `300`              | How long each split is observed before the next       |
| `CANARY_PROBE_INTERVAL_SECONDS` | `30`               | How often the soak probes the edge and the colour     |
| `CANARY_SLOTS`                  | `20`               | The granularity of a split: 20 slots, so 5% is a step |
| `CANARY_PROBE_ATTEMPTS`         | `6`                | How many times a gate retries before it fails         |
| `CANARY_PROBE_BACKOFF_SEC`      | `10`               | How long a gate waits between attempts                |
| `CANARY_PROBE_PATH`             | `/api/readyz`      | The path the gates read                               |
| `CANARY_PROBE_TIMEOUT_SEC`      | `15`               | How long a single probe may take                      |
| `COLOUR_HEALTH_TIMEOUT_MS`      | `180000`           | How long a colour is given to become healthy          |
| `COLOUR_POLL_INTERVAL_MS`       | `3000`             | How often the health wait looks                       |
| `COLOUR_CONTAINER_GRACE_MS`     | `20000`            | How long a missing container is tolerated             |
| `APP_PORT`                      | `3000`             | The port the colour slots serve on                    |
| `PROBE_ORIGIN`                  | `http://127.0.0.1` | The origin the probes read                            |

**A malformed value takes the default rather than failing.** A typo in a
deployment variable must not stop a rollback, and a rollback that refuses to run
is the worst possible time to discover one. The split percentages are the
exception: they are passed to the script as ARGUMENTS, so the workflow's value
and the script's value cannot disagree about which one ran.

**The one-time adoption.** A host running the plain single-`app` stack has to
be moved onto the colour slots once. It is an OPERATOR step, not something the
pipeline does to itself, because it changes which container serves production
and there is no old colour to fall back to:

```bash
cd ~/securevoice-ai
bun scripts/deploy.mjs adopt
```

`adopt` stages the first colour on the build that is **already serving** (an
adoption on a different build would be an unannounced release), proves it
healthy in-container, points Caddy at it, proves the edge answers, and only
then stops the plain `app` container. The plain container is STOPPED, not
removed, so the rollback is `docker compose start app` away.

**The production VPS HAS been adopted** (2026-10-21). It runs the blue/green
stack, production is served by `app-blue`, and the Canary workflow now does
real work on it: its preflight reads `bluegreen` and proceeds to the split
instead of exiting with a notice.

Every release BEFORE the adoption rolled the plain single-`app` stack in
place, and an in-place roll of the only upstream leaves the edge with no
origin for about twenty seconds — measured, and written up in
`docs/RUNBOOK.md` §9. From the adoption onward the release is staged into the
IDLE colour, the old colour keeps serving throughout, and the traffic flip is
a one-line `APP_UPSTREAM` change.

The adoption was interrupted once and resumed once, and both facts are worth
knowing: the first attempt failed at the traffic flip because compose could
not parse the merged files without an image to name, and the second because
the verification probe was asking the wrong origin and racing the Caddy
recreate. `adopt` is now resumable and the probe waits for the edge.

**What to check afterwards:**

```bash
bun scripts/deploy.mjs status      # stack, active colour, canary split, edge
bun scripts/deploy.mjs mode        # plain | bluegreen | unknown
```

**The plain container is STOPPED, not removed.** It is the rollback:
`docker compose start app` brings it back, and pointing `.deploy/active.env`
at `app:3000` and recreating Caddy returns the edge to it.

**The override is a MINIMAL override of the SAME project.**
`docker-compose.bluegreen.yml` adds the two colour slots and nothing else —
no `name:`, no `db`, no `db-setup`, no `realtime`, no `caddy`. That is
deliberate and load-bearing: a compose project owns its named volumes, so an
override with its own `name:` and its own `db` service would have started a
SECOND, EMPTY Postgres for the colours to talk to. The colour slots share the
production database, the realtime service, Redis, the workers and the volumes.

**The traffic pointer.** `APP_UPSTREAM` is delivered as a FILE
(`.deploy/active.env`), mounted into the caddy service by the BASE compose
file's `env_file`. It is written BEFORE Caddy is recreated — an earlier version
wrote it after, which is how a deploy could publish an edge config pointing at
a colour that had already been stopped.

**The canary split is proportional repetition.** Caddy 2.11.4 has no
`weighted_round_robin` and rejects a `weight` subdirective, so 5% is the old
colour listed nineteen times and the new colour once, with
`lb_policy round_robin` sharing requests across the list. The split is exact
over any window of twenty requests, and it is per-request — a traffic split for
exposing a build to real load, NOT A/B routing for cohorts.

**Manual operations**, for when the automatic path is not what you want:

```bash
bun scripts/deploy.mjs auto --image <ref>        # one command: stage → 5% → soak → 50% → soak → 100% → promote, auto-rollback on any failed probe
bun scripts/deploy.mjs stage --image <ref>       # bring the idle colour up, move no traffic
bun scripts/deploy.mjs canary --percent 25       # widen the split
bun scripts/deploy.mjs canary --percent 0       # abandon the canary, back to the active colour
bun scripts/deploy.mjs promote                   # retire the old colour
bun scripts/deploy.mjs rollback                  # flip back to the previous colour
bun scripts/deploy.mjs probe --colour blue       # gate: the colour AND the edge
```

`auto` refuses to run on a host that has not adopted the blue/green slots, or
while an unfinished canary is recorded in `.deploy/state.json` — resolving an
outstanding canary is an operator decision (`--percent 0` to abandon,
`--percent 100` to accept), not something an automatic pipeline widens for you.

## 8. Nightly backups

`/etc/cron.d/securevoice-backup`:

```
15 3 * * * root cd /srv/securevoice && docker compose exec -T db pg_dump -U securevoice securevoice | gzip > /srv/backups/db-$(date -u +\%F).sql.gz && find /srv/backups -name 'db-*.sql.gz' -mtime +14 -delete
```

Copy `/srv/backups` off the box. Certs are cheap to re-issue; the database
(including the tamper-evident audit chain) is not.

## 9. Never on the VPS

- `docker compose down -v` — destroys `db-data` **and** `caddy-data`
  (full re-issuance, Let's Encrypt rate limit).
- `--profile direct` — publishes `:3000` and breaks the proxy trust model.
- `docker system prune -a --volumes`.

## Troubleshooting

| Symptom                                      | Cause                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app` healthy never happens; every page 500s | `BETTER_AUTH_SECRET` missing or <32 chars → set it in `.env` and restart the app                                                                                                            |
| `caddy` unhealthy                            | leftover from an old config: the healthcheck probes `/healthz` on itself — confirm the hostname is in the `Caddyfile` site list (or `sites.d/`) and its DNS record is DNS-only (grey cloud) |
| 521 / TLS errors                             | DNS not propagated, AAAA record without IPv6, or port 80 blocked (ACME needs it)                                                                                                            |
| Console shows SSE but never websocket        | `FEATURE_REALTIME` unset (it defaults off), `REALTIME_INGEST_SECRET` unset, or `REALTIME_URL` overridden to 127.0.0.1 — `realtimeConfigured()` is the AND of the first two                  |
| `db-setup` keeps failing                     | read `docker compose logs db-setup`; after 3 retries it stays down — fix the cause and `docker compose up db-setup` again                                                                   |
