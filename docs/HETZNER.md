# Deploying SecureVoice AI to a Hetzner VPS (docker-compose, production)

This deploys the compose stack **as-is** — Postgres 16, the Next.js app, the
realtime socket service, and Caddy terminating TLS. Nothing else publishes a
port, which is what keeps the `src/proxy.ts` trust model sound.

Estimated time: ~15 minutes on a fresh box.

---

## 1. Provision

- **Server**: CX32 (2 vCPU / 4 GB) minimum — Next build + Postgres + sockets
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

## 2. Firewall (Hetzner Cloud Firewall — not ufw, pick one)

| Inbound | Why |
| --- | --- |
| TCP 22 | SSH — restrict to your IP |
| TCP 80 | ACME HTTP-01 (Let's Encrypt) |
| TCP 443 | HTTPS |
| UDP 443 | HTTP/3 (optional) |

Nothing else. **5432, 3000, 4000 must stay closed** — the entire edge trust
model depends on the origin being unreachable except through Caddy.

## 3. DNS

```
A    voice.example.com   →  <VPS IPv4>
```

- Do **not** add an AAAA record unless the box actually serves IPv6 — Caddy
  will attempt issuance over it and fail.
- Wait for propagation before first boot: `dig +short voice.example.com @1.1.1.1`

## 4. Clerk (before you build — this is a hard blocker)

`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is **inlined into the bundle at build
time**. If it is not in `.env` when you `docker compose build`, every request
500s and Caddy never starts. Runtime env cannot fix it — you must rebuild.

**If you already have a domain:** create the production Clerk instance now,
put `pk_live_…` / `sk_live_…` in `.env`, mark at least one user
`publicMetadata.role = "operator"`, and never think about this again.

**If you don't (the deploy-first path):** a Clerk production instance requires
DNS verification, so it cannot exist before the domain. Deploy with the dev
keys (`pk_test`/`sk_test`) — that is a supported, working configuration, and
`bun run preflight` will keep reminding you the instance is a dev one. The
swap procedure, when the domain lands:

1. Create the production Clerk instance; complete its DNS verification.
2. Put `pk_live_…` / `sk_live_…` in `.env`.
3. Rebuild **and** redeploy (the publishable key is build-time inlined):
   `docker compose build app db-setup && docker compose up -d`
4. Do this BEFORE onboarding real users. Dev-instance `UserProfile` rows
   (wallets, BYOK keys) are keyed by dev user IDs and do not carry over —
   fine for demo data, fatal for real wallets.
5. Re-create the operator account on the new instance, set
   `publicMetadata.role = "operator"`, sign in once (the profile syncs on
   first login), then top up credits if needed:
   `docker compose exec db psql -U securevoice -c "UPDATE \"UserProfile\" SET credits = 500 WHERE role = 'operator';"`

No domain yet for TLS either? Use `<vps-ip>.sslip.io` as `SITE_ADDRESS` —
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
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...   # dev for now; pk_live_... once the domain exists (see step 4)
CLERK_SECRET_KEY=sk_test_...                    # sk_live_... at the same time

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
including whether voice is DRY-RUN and whether Clerk is still the dev
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
docker compose build --pull     # required — plain `up -d` reuses the stale image
docker compose up -d
docker compose ps && curl -s https://voice.example.com/healthz
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

| Symptom | Cause |
| --- | --- |
| `app` healthy never happens; every page 500s | Clerk publishable key missing at build → set it in `.env` and `docker compose build` again |
| `caddy` unhealthy | leftover from an old config: the healthcheck probes `/healthz` on itself — confirm `SITE_ADDRESS` matches DNS |
| 521 / TLS errors | DNS not propagated, AAAA record without IPv6, or port 80 blocked (ACME needs it) |
| Console shows SSE but never websocket | `REALTIME_INGEST_SECRET` unset, or `REALTIME_URL` overridden to 127.0.0.1 |
| `db-setup` keeps failing | read `docker compose logs db-setup`; after 3 retries it stays down — fix the cause and `docker compose up db-setup` again |
