import "server-only";
import { cpus } from "node:os";
import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Prisma ORM v7 has no connection pool of its own — `@prisma/adapter-pg` hands
// every query to a `pg.Pool`, so the knobs that used to be Prisma's become
// node-postgres' — and two of them do not carry over:
//
//   - `connection_limit` and `schema` in DATABASE_URL are Prisma-only query
//     params that node-pg silently drops. Both are lifted out of the URL below
//     and handed to the pool explicitly, so the documented `connection_limit`
//     override keeps working and table names still resolve in the schema the
//     operator named rather than in Postgres' default search_path.
//   - v6 had two separate budgets: `connect_timeout` (5s, establishing the
//     socket) and `pool_timeout` (10s, waiting for a free pooled connection).
//     node-postgres has one knob for both — `connectionTimeoutMillis`, default
//     0, i.e. wait forever, so a saturated pool turns into a hung request
//     instead of a fast failure. The LARGER of the two is restored, because it
//     is the one that binds under load: with 100 concurrent writers against a
//     280 ms round trip, a 5s acquire budget fails the requests that v6 served.
//
// This schema is Postgres-only (`provider = "postgresql"`), so the adapter
// manages a real pool against whatever DATABASE_URL the runtime is given.
const databaseUrl = process.env.DATABASE_URL ?? '';
const CONNECT_TIMEOUT_MS = 10_000;
const MAIN_POOL_MAX =
  Number.parseInt(/[?&]connection_limit=(\d+)/.exec(databaseUrl)?.[1] ?? '', 10) ||
  cpus().length * 2 + 1;
const AUDIT_POOL_MAX = 5;
const namedSchema = /[?&]schema=([^&]+)/.exec(databaseUrl)?.[1];
const adapterSchema = namedSchema ? { schema: namedSchema } : undefined;

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
    adapter: new PrismaPg(
      { connectionString: databaseUrl, max: MAIN_POOL_MAX, connectionTimeoutMillis: CONNECT_TIMEOUT_MS },
      adapterSchema,
    ),
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
    adapter: new PrismaPg(
      { connectionString: databaseUrl, max: AUDIT_POOL_MAX, connectionTimeoutMillis: CONNECT_TIMEOUT_MS },
      adapterSchema,
    ),
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
