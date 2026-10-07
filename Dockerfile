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
ARG BETTER_AUTH_SECRET="replace-with-openssl-rand-base64-32-please!!"
ARG BETTER_AUTH_URL="https://localhost:3000"
ENV DATABASE_URL=${BUILD_DATABASE_URL} \
    BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET} \
    BETTER_AUTH_URL=${BETTER_AUTH_URL}
# NOTE: no NEXT_PUBLIC_* auth build arg. Clerk needed one because its publishable
# key had to be inlined into the client bundle; Better Auth is entirely server-side
# (BETTER_AUTH_SECRET / BETTER_AUTH_API_KEY), so both are runtime env and the build
# stays free of auth secrets. Baking a secret into an image layer was the real
# hazard the old plumbing created.
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
