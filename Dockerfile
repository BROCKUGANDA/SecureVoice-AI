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
ARG BETTER_AUTH_URL="https://localhost:3000"

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

ENV DATABASE_URL=${BUILD_DATABASE_URL} \
    BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET} \
    BETTER_AUTH_URL=${BETTER_AUTH_URL} \
    NEXT_PUBLIC_DEMO_LOGIN_EMAIL=${NEXT_PUBLIC_DEMO_LOGIN_EMAIL} \
    NEXT_PUBLIC_DEMO_LOGIN_PASSWORD=${NEXT_PUBLIC_DEMO_LOGIN_PASSWORD}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The client is a build artifact (git- and dockerignored), so the one generated
# in deps is what the bundle compiles against.
COPY --from=deps /app/src/generated ./src/generated
RUN bun run build

# ---------- runner: minimal standalone server ----------
FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL=postgresql://securevoice:securevoice@db:5432/securevoice?schema=public
COPY --from=builder /app/.next/standalone ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server.js"]
