import "server-only";
import { cpus } from "node:os";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { recordQuery, type PrismaQueryEvent } from "@/lib/telemetry/query-counter";
import { assertDatabaseTarget } from "@/lib/db-target";

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
const databaseUrl = process.env.DATABASE_URL ?? "";

/**
 * A production database connection must be encrypted.
 *
 * `DATABASE_URL` is passed to the pool verbatim, so a URL without an SSL mode
 * sends every case row, transcript and phone number across the network in
 * plaintext — while everything above it (Caddy, HSTS, CSP) makes the deployment
 * LOOK TLS-protected. The one place a plaintext hop is defensible is a private
 * network the operator controls, so that case is allowed only by explicit
 * opt-in rather than by silence.
 */
function assertTransportIsEncrypted(url: string): void {
  if (!url) return; // the pool's own error is more specific than ours
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.DB_ALLOW_PLAINTEXT_PRIVATE_NETWORK === "true") return;

  const mode = /[?&]sslmode=([^&]+)/.exec(url)?.[1]?.toLowerCase();
  const encrypted = mode === "require" || mode === "verify-ca" || mode === "verify-full";
  if (!encrypted) {
    throw new Error(
      "DATABASE_URL must set sslmode=require (or verify-ca/verify-full) in production. " +
        "Case rows, transcripts and phone numbers would otherwise cross the network in " +
        "plaintext. On a private network you control, set " +
        "DB_ALLOW_PLAINTEXT_PRIVATE_NETWORK=true to acknowledge that explicitly.",
    );
  }
}
assertTransportIsEncrypted(databaseUrl);
// Opt-in (REQUIRE_VPS_DATABASE=true): refuse to boot production against anything
// but the VPS's own Postgres. See src/lib/db-target.ts for why it is opt-in.
assertDatabaseTarget(databaseUrl);

const CONNECT_TIMEOUT_MS = 10_000;
const MAIN_POOL_MAX =
  Number.parseInt(/[?&]connection_limit=(\d+)/.exec(databaseUrl)?.[1] ?? "", 10) ||
  cpus().length * 2 + 1;
const AUDIT_POOL_MAX = 5;
const namedSchema = /[?&]schema=([^&]+)/.exec(databaseUrl)?.[1];
const adapterSchema = namedSchema ? { schema: namedSchema } : undefined;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const isProd = process.env.NODE_ENV === "production";

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // AA-1.1 - query counting.
    //
    // The `emit` hook is what makes src/lib/telemetry/query-counter.ts observable.
    // It is deliberately installed ONLY in non-production: a per-query event for
    // every statement has a real cost, and paying it on a live path to satisfy a
    // test would be the wrong trade. `recordQuery` is also a no-op unless a
    // request is inside `runWithQueryCounter()`, so the counter cannot leak
    // between concurrent requests.
    log: isProd ? ["error"] : [{ level: "query", emit: "event" }, "query", "error", "warn"],
    adapter: new PrismaPg(
      {
        connectionString: databaseUrl,
        max: MAIN_POOL_MAX,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      },
      adapterSchema,
    ),
  });

if (!isProd) globalForPrisma.prisma = db;

// AA-1.1 — deliver query events to the counter.
//
// Prisma 7 delivers `emit: "event"` events through the client's own event bus,
// not through a constructor callback: `log: [{ level, emit }]` DECLARES that
// events are emitted, and `$on('query', cb)` is where they ARRIVE. Omitting the
// subscription is the failure mode worth naming — the level is declared, no
// error is raised, and the counter silently observes nothing, so every query
// budget in tests/routes/query-budgets.ts would pass for the wrong reason.
//
// Non-production only, matching the `log` config above: a per-query listener
// costs something on every request and nothing in production consumes the
// result. `recordQuery` is itself a no-op unless the current request is inside
// `runWithQueryCounter()`, so the subscription costs one AsyncLocalStorage
// lookup per query and cannot leak state between requests.
// Prisma 7 types `$on` as `<V extends LogOpts>(eventType: V, ...)`, inferring
// the valid event names from THIS client's `log` config. `isProd` is computed
// from NODE_ENV, so the type of the `log` array is the union of both branches —
// and TypeScript then cannot prove "query" is a member of it, collapsing the
// parameter to `never`. The subscription below is guarded by the same runtime
// condition and is genuinely absent in production, so the declaration above is
// accurate; this is purely a typing gap in Prisma's inference, not a bug in
// the wiring. Cast the event name rather than dropping the listener, which
// would silently disable query counting and make every budget in
// tests/routes/query-budgets.ts pass for the wrong reason.
if (!isProd) {
  db.$on("query" as Parameters<typeof db.$on>[0], (event: PrismaQueryEvent) => recordQuery(event));
}

// ── Audit-chain dedicated client ──
// The audit chain's fire-and-forget appends must never compete with the hot
// path (the combined idempotency+consent check) for a connection from the
// main pool. A dedicated client with its own small pool isolates the two:
// a burst of audit writes can never starve the synchronous path.
const globalForPrismaAudit = globalThis as unknown as {
  prismaAudit: PrismaClient | undefined;
};

export const dbAudit =
  globalForPrismaAudit.prismaAudit ??
  new PrismaClient({
    log: isProd ? ["error"] : ["error"],
    adapter: new PrismaPg(
      {
        connectionString: databaseUrl,
        max: AUDIT_POOL_MAX,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      },
      adapterSchema,
    ),
  });

if (!isProd) globalForPrismaAudit.prismaAudit = dbAudit;

// ── Boot-time housekeeping (runs once per process) ──
// Evict expired idempotency keys so the table doesn't grow unboundedly.
// Best-effort: failures are logged but never block startup.
if (isProd) {
  db.idempotencyKey
    .deleteMany({ where: { expiresAt: { lte: new Date() } } })
    .then(({ count }) => {
      if (count > 0) console.log(`[db] evicted ${count} expired idempotency keys`);
    })
    .catch(() => {});
}
