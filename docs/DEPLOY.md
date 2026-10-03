# Deploying SecureVoice AI to a VPS (docker-compose, production)

This deploys the compose stack **as-is** — Postgres 16, the Next.js app, the
realtime socket service, and Caddy terminating TLS. Nothing else publishes a
port, which is what keeps the `src/proxy.ts` trust model sound.

Estimated time: ~15 minutes on a fresh box.

---

## 1. Provision

- **Server**: 2 vCPU / 4 GB minimum (current deployment: Akamai/Linode, 8 GB, Frankfurt) — Next build + Postgres + sockets
  do not fit comfortably in 2 GB. Debian 13 or Ubuntu 24.04.
- **Region**: pick the one closest to where calls are answered (tool
  round-trips are in the voice path; transatlantic latency is audible).
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

## 2. Firewall (provider cloud firewall if one exists — Akamai/Linode, Hetzner, DigitalOcean all have them — otherwise ufw. Pick one, not both.)

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

No domain yet for TLS either? Use `<vps-ip>.sslip.io` as `SITE_ADDRESS` -
free instant DNS that resolves to your IP; Let's Encrypt issues for it. Swap
to the real domain later by editing `.env` and restarting Caddy.

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

| Symptom                                      | Cause                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `app` healthy never happens; every page 500s | `BETTER_AUTH_SECRET` missing or <32 chars → set it in `.env` and restart the app                                          |
| `caddy` unhealthy                            | leftover from an old config: the healthcheck probes `/healthz` on itself — confirm `SITE_ADDRESS` matches DNS             |
| 521 / TLS errors                             | DNS not propagated, AAAA record without IPv6, or port 80 blocked (ACME needs it)                                          |
| Console shows SSE but never websocket        | `REALTIME_INGEST_SECRET` unset, or `REALTIME_URL` overridden to 127.0.0.1                                                 |
| `db-setup` keeps failing                     | read `docker compose logs db-setup`; after 3 retries it stays down — fix the cause and `docker compose up db-setup` again |
