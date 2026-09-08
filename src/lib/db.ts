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
  })

if (!isProd) globalForPrisma.prisma = db
