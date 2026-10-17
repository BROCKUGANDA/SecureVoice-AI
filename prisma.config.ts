import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma ORM v7 no longer loads .env itself and no longer accepts `url` /
// `directUrl` / `shadowDatabaseUrl` in the schema's datasource block — the CLI
// reads them from here. The runtime client gets its connection string from the
// `@prisma/adapter-pg` adapters in src/lib/db.ts, not from this file.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // v7 dropped the implicit "migrate dev/reset seeds afterwards" behaviour.
    seed: "node scripts/seed-demo.mjs",
  },
  datasource: {
    url: env("DATABASE_URL"),
    // NOTE: this Prisma version's config type does not accept `directUrl`, so the
    // direct connection for migrations is NOT declared here. The db-setup service
    // in docker-compose.yml points its DATABASE_URL at DIRECT_URL instead, which is
    // how `prisma migrate deploy` reaches an unpooled connection. DDL does not work
    // through a transaction-mode pooler, so this split is required — see
    // docs/runbooks/db-pool-exhaustion.md.
  },
});
