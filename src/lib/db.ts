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
