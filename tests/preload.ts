/**
 * Test preload: `server-only` is a Next.js bundler marker that throws when
 * imported outside the RSC bundle. In Bun tests there is no client/server
 * boundary to enforce, so it is a deliberate no-op here.
 */
import { mock } from "bun:test";

mock.module("server-only", () => ({}));

// Latency gates (docs/VERIFICATION.md WP-3) assume the production topology
// from docs/HETZNER.md: Postgres co-located with the app. When a caller
// provides TEST_DATABASE_URL, every test runs against that database instead
// of the dev Supabase instance — whose ~270 ms round trip makes a sub-300 ms
// tool p95 physically impossible regardless of code. Without the override,
// tests keep using DATABASE_URL from the environment exactly as before.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// The load gate (WP-19) measures CAPACITY, so it gets its own database. It
// shares nothing with the functional suites: a capacity number contaminated by
// another suite's rows is not a capacity number, and the run-to-run drift that
// causes is exactly what makes an evidence artifact worthless.
if (process.env.LOAD_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.LOAD_DATABASE_URL;
}
