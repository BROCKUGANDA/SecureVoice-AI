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
