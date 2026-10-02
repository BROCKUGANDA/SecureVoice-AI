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
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgresql://securevoice:securevoice@db:5432/securevoice?schema=public
# NEXT_PUBLIC_* vars are INLINED into the bundle at build time — runtime env has
# no effect. The Clerk publishable key must therefore arrive as a build arg or
# clerkMiddleware 500s every request and the stack never becomes healthy.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
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
