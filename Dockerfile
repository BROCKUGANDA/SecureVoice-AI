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
# ---------------------------------------------------------------------------

# ---------- deps: install dependencies + generate the Prisma client ----------
FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma/schema.prisma ./prisma/
RUN bun install --frozen-lockfile \
 && bunx prisma generate

# ---------- builder: compile the Next.js standalone bundle ----------
FROM oven/bun:1-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=file:/app/db/custom.db
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# ---------- runner: minimal standalone server ----------
FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL=file:/app/db/custom.db
RUN mkdir -p /app/db
COPY --from=builder /app/.next/standalone ./
EXPOSE 3000
CMD ["bun", "server.js"]
