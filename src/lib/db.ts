import "server-only";
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const isProd = process.env.NODE_ENV === 'production'

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Query logging is a dev affordance; in production it leaks query params to
    // stdout and adds per-query overhead. Errors always surface.
    log: isProd ? ['error'] : ['query', 'error', 'warn'],
    // This schema is Postgres-only (`provider = "postgresql"`), so Prisma
    // manages a real connection pool. The default size (num_cpus * 2 + 1) is
    // usually fine; override via the connection_limit query param:
    //   postgresql://user:pass@host:5432/db?connection_limit=20&timeout=3000
  })

if (!isProd) globalForPrisma.prisma = db

// ── Audit-chain dedicated client ──
// The audit chain's fire-and-forget appends must never compete with the hot
// path (the combined idempotency+consent check) for a connection from the
// main pool. A dedicated client with its own small pool isolates the two:
// a burst of audit writes can never starve the synchronous path.
const globalForPrismaAudit = globalThis as unknown as {
  prismaAudit: PrismaClient | undefined
}

export const dbAudit =
  globalForPrismaAudit.prismaAudit ??
  new PrismaClient({
    log: isProd ? ['error'] : ['error'],
    datasources: {
      db: {
        url: (process.env.DATABASE_URL ?? '') + '&connection_limit=5',
      },
    },
  })

if (!isProd) globalForPrismaAudit.prismaAudit = dbAudit

// ── Boot-time housekeeping (runs once per process) ──
// Evict expired idempotency keys so the table doesn't grow unboundedly.
// Best-effort: failures are logged but never block startup.
if (isProd) {
  db.idempotencyKey
    .deleteMany({ where: { expiresAt: { lte: new Date() } } })
    .then(({ count }) => {
      if (count > 0) console.log(`[db] evicted ${count} expired idempotency keys`)
    })
    .catch(() => {})
}
