# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# SecureVoice AI — production image (multi-stage, bun + Next.js standalone)
#
#   docker build -t securevoice-ai .
#   docker run -p 3000:3000 --env-file .env securevoice-ai
#
# or, for the full reproducible demo (schema + seed data included):
#
#   docker compose up --build
#
# DATABASE: the datasource in prisma/schema.prisma is `postgresql`, so the image
# runs Prisma against whatever DATABASE_URL you pass in — which must be a
# `postgresql://` or `postgres://` URL. A `file:` URL is REJECTED by Prisma
# (P1012: "the URL must start with the protocol postgresql://"), so there is no
# SQLite mode: this schema has always been Postgres-only.
#
#   docker compose up --build        → brings up its own Postgres 16 service
#   docker run -p 3000:3000 \
#     -e DATABASE_URL="postgresql://user:pass@host:5432/securevoice?schema=public" \
#     securevoice-ai                → point it at your own Postgres
# ---------------------------------------------------------------------------

# ---------- deps: install dependencies + generate the Prisma client ----------
FROM oven/bun:1-slim AS deps
WORKDIR /app
# Prisma ORM v7 reads the datasource URL from prisma.config.ts and generates
# the client into src/generated/prisma as TypeScript. generate never dials the
# database, but the config still resolves DATABASE_URL, so a syntactically
# valid placeholder is supplied — the same value the builder stage bakes in.
ENV DATABASE_URL=postgresql://securevoice:securevoice@localhost:5432/securevoice?schema=public
COPY package.json bun.lock ./
COPY prisma/schema.prisma ./prisma/
COPY prisma.config.ts ./
RUN bun install --frozen-lockfile \
 && bunx prisma generate

# ---------- builder: compile the Next.js standalone bundle ----------
FROM oven/bun:1-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time page-data collection only instantiates the Prisma client; it does
# not dial it. Allowing this on the throwaway builder layer stops src/lib/db.ts's
# production guard from rejecting the private-network placeholder URL — the
# runtime images keep their own per-service acknowledgement in docker-compose.yml.
ENV DB_ALLOW_PLAINTEXT_PRIVATE_NETWORK=true
# A `db:` host is never reachable from inside a `docker build` run, and the
# build's page-data collection touches Prisma, so the URL that matters at
# build time is a LIVE one. Pass it in: `--build-arg BUILD_DATABASE_URL=...`
# (docker-compose.yml wires this from the host's DATABASE_URL). Falls back to
# the compose-service placeholder for parity with the previous behaviour.
ARG BUILD_DATABASE_URL=postgresql://securevoice:securevoice@db:5432/securevoice?schema=public
# better-auth.ts reads these at module import (it throws if BETTER_AUTH_SECRET
# is missing or <32 chars), and Next.ts evaluates site modules at page-data
# collection time — so the build needs them too. .env is dockerignored, which
# is why `docker compose build` previously threw "BETTER_AUTH_SECRET must be
# set". Compose passes them in from the host .env.
#
# BETTER_AUTH_SECRET deliberately has NO default. A placeholder would either
# fail the 32-char guard (pointless) or pass it while being world-known — and
# either way the value persists in the image layer history via the ENV below.
# A bare `docker build` without --build-arg now fails loudly at better-auth's
# import guard; docker-compose.yml requires the secret from .env with `:?`.
ARG BETTER_AUTH_SECRET
ARG BETTER_AUTH_URL="https://securevoiceai.me"

# The demo shortcut credentials are the ONE category of NEXT_PUBLIC_* that belongs
# in the client bundle, and they must be supplied at build time.
#
# `NEXT_PUBLIC_*` is inlined by the Next.js compiler during `bun run build`, not
# read at runtime. src/views/Auth.tsx gates its one-click judge login on
# `DEMO_READY` (both values non-empty), so a build that does not carry these two
# variables compiles the button OUT of the bundle entirely — not "hides" it,
# removes it. A judge is then left with a bare sign-in form and no explanation.
# That is exactly the failure docs/TODO.md warns about, and it is invisible from
# the host env because the host env is never consulted: only the build is.
#
# This does NOT contradict the BETTER_AUTH_* args above. There are two different
# things and they must not be conflated:
#
#   BETTER_AUTH_SECRET   a real secret. Server-side only. Never NEXT_PUBLIC_*,
#                        never inlined, never in a client bundle. Stays a build
#                        ARG so it reaches better-auth.ts's import guard without
#                        being committed to an image layer.
#
#   DEMO_LOGIN_*         not a secret at all. It is a published demo credential
#                        that already reaches every visitor as literal text in
#                        the JS bundle — that is what a one-click demo shortcut
#                        IS. Baking it into the layer exposes nothing that the
#                        served page does not expose anyway.
#
# Defaults are empty so a deployment that deliberately runs without a demo seat
# still builds; docker-compose.yml passes them from the host .env.
ARG NEXT_PUBLIC_DEMO_LOGIN_EMAIL=""
ARG NEXT_PUBLIC_DEMO_LOGIN_PASSWORD=""

# The canonical public origin. This has to be a BUILD ARG, not just a runtime
# env var, and that is the whole point of this line.
#
# `NEXT_PUBLIC_*` is inlined by the Next.js compiler AT BUILD TIME — it is a
# literal substitution into the bundle, not a lookup at request time. Everything
# that consumes it (metadataBase, the canonical URL, the OG/Twitter image URLs,
# the prerendered sitemap.xml and robots.txt) is therefore frozen when
# `bun run build` runs below. Adding NEXT_PUBLIC_SITE_URL to the VPS .env
# WITHOUT threading it through here leaves production serving a sitemap and a
# canonical tag that point at http://localhost:3000, which is worse than leaving
# it unset: it is actively wrong, and search engines cache it.
#
# docker-compose.yml passes this from the host .env, defaulting to https://<SITE_ADDRESS>
# so a deployment that set SITE_ADDRESS for TLS cannot forget it here too.
ARG NEXT_PUBLIC_SITE_URL=""

# The Paddle price ids, for the same reason as NEXT_PUBLIC_SITE_URL above and with
# the same consequence if this line is missing: the ids are inlined into the
# bundle, so a value that never reaches the builder is not "unset at runtime", it
# is ABSENT, and `paddlePriceIds()` throws while prerendering the pricing page.
#
# This was not a hypothetical. The CI compose smoke test builds against a
# disposable loopback origin and died at
#
#     Error: NEXT_PUBLIC_PADDLE_PRICES is not set to a complete price map.
#
# with no ARG anywhere to pass one, which also means no Docker deployment could
# have set it either — the Buy buttons were being compiled out of the production
# bundle for the same reason the demo-login pair is threaded through two lines up.
ARG NEXT_PUBLIC_PADDLE_PRICES=""

# The Paddle checkout environment ("sandbox" | "production") and the CLIENT-side
# Paddle.js token, for the same reason as the price ids two lines up: all three
# are inlined into the browser bundle at build time. A missing ARG here is not
# "unset at runtime" — it is ABSENT from the bundle, and paddleEnvironment()
# then throws in every visitor's console ("got undefined") while every Buy
# button is dead. The token is the client-side Paddle.js token, public by
# design; the server-side PADDLE_API_KEY never passes through this stage.
ARG NEXT_PUBLIC_PADDLE_ENVIRONMENT=""
ARG NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=""

ENV DATABASE_URL=${BUILD_DATABASE_URL} \
    BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET} \
    BETTER_AUTH_URL=${BETTER_AUTH_URL} \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_PADDLE_PRICES=${NEXT_PUBLIC_PADDLE_PRICES} \
    NEXT_PUBLIC_PADDLE_ENVIRONMENT=${NEXT_PUBLIC_PADDLE_ENVIRONMENT} \
    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=${NEXT_PUBLIC_PADDLE_CLIENT_TOKEN} \
    NEXT_PUBLIC_DEMO_LOGIN_EMAIL=${NEXT_PUBLIC_DEMO_LOGIN_EMAIL} \
    NEXT_PUBLIC_DEMO_LOGIN_PASSWORD=${NEXT_PUBLIC_DEMO_LOGIN_PASSWORD}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The client is a build artifact (git- and dockerignored), so the one generated
# in deps is what the bundle compiles against.
COPY --from=deps /app/src/generated ./src/generated
RUN bun run build

# ---------- worker: the long-lived scripts, and only what they can use ---------
#
# SEVEN services used to ask for `target: builder`. The builder stage is the
# heaviest thing in this file by design — it carries every devDependency, the
# whole source tree, and the Next.js `.next/` output that `bun run build`
# produces, none of which a background worker ever opens. Measured on the box
# 2026-10-12 with `docker history` on the dial-worker: 762 MB of install layer,
# 2 GB of node_modules, 130 MB of source, 4.07 GB total, seven services' worth
# of it on one disk.
#
# This stage is the same runtime with the build weight left behind. It runs NO
# install and NO build: `node_modules` and the generated Prisma client are
# copied from the stages that already produced them, so nothing here can drift
# from what the app image runs against.
#
# It also closes a leak the builder-target images were carrying. The builder
# stage bakes `ENV DATABASE_URL=${BUILD_DATABASE_URL}` (plus BETTER_AUTH_SECRET
# and the demo-login pair) so that page-data collection can instantiate Prisma
# during the build. Because the workers shared that stage, every worker image
# on this host carried the PRODUCTION DATABASE URL — password included — as an
# ENV layer and in its build history. Compose supplies DATABASE_URL at runtime
# for each service, so nothing needs it baked. A worker image that does not
# contain the database credentials is strictly better, and this stage does not
# set any of those variables.
FROM oven/bun:1-slim AS worker
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
# The full dependency tree, from the stage that already installed and validated
# it against the lockfile. Deliberately NOT a fresh `--production` install:
# measured, that saves only ~100 MB of the 2 GB while re-introducing a second
# install whose scripts (esbuild's binary download, prisma's postinstall) could
# differ from the one the app image used. Same tree, one source of truth.
COPY --from=deps /app/node_modules ./node_modules
# The Prisma client is a build artifact of the deps stage and a runtime
# dependency of every worker. `prisma` and `dotenv` are in `dependencies`, not
# `devDependencies`, so db-setup's `bunx prisma migrate deploy` works here too —
# which is why all seven services, migrations included, can use this stage.
COPY --from=deps /app/src/generated ./src/generated
COPY package.json tsconfig.json ./
# Prisma 7's CLI reads its schema and migrations paths from here, so db-setup
# needs this file at runtime, not just at build time.
COPY prisma.config.ts ./
# mini-services/ is NOT optional: src/lib/realtime-client.ts and
# src/lib/realtime-token.ts import from it, so any worker that speaks to the
# realtime bus fails to resolve without it.
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
COPY mini-services ./mini-services

# ---------- runner: minimal standalone server ----------
FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL=postgresql://securevoice:securevoice@db:5432/securevoice?schema=public
COPY --from=builder /app/.next/standalone ./
# Run as the non-root `bun` user this base image already ships (uid 1000).
# Previously the runner stage had no USER directive, so the app ran as root.
#
# The image provides the user, so no `adduser` is needed. Nothing in the
# standalone output is written at runtime — `/app` is root-owned and 755, so it
# stays readable, and scratch files go to `/tmp` — so dropping from root to
# 1000 does not change what this container can reach, only what an attacker
# gains from a compromise of it.
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "--preload", "./server-preload.ts", "server.js"]
