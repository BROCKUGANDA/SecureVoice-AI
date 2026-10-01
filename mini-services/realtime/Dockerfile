# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# SecureVoice realtime service — the Command Center's push path.
#
# Built as its own image rather than added to the main Dockerfile: it has a
# different dependency tree (socket.io, no Prisma, no Next), a different trust
# boundary (it holds a signing secret but no database client), and it must be
# independently restartable — a hung socket layer should never take the API down
# with it.
#
# The build context is mini-services/realtime, NOT the repo root:
#   docker build -t securevoice-realtime mini-services/realtime
# ---------------------------------------------------------------------------

FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# ---------------------------------------------------------------------------
FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
EXPOSE 4000

# Liveness only — /readyz additionally asserts a signing secret is present, which
# a compose healthcheck would (correctly) treat as a restart loop on a fresh
# clone that has not set REALTIME_INGEST_SECRET yet.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/server.ts"]
