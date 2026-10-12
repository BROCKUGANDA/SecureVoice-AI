/**
 * Test preload: `server-only` is a Next.js bundler marker that throws when
 * imported outside the RSC bundle. In Bun tests there is no client/server
 * boundary to enforce, so it is a deliberate no-op here.
 */
import { mock } from "bun:test";

mock.module("server-only", () => ({}));

// The ElevenLabs egress guard refuses any live vendor call unless the operator
// attests the account is entitled to commercial use (free tier is
// non-commercial only — ToS §1(c)(i), PUP §9(a)). The suites exercise the live
// path against stubbed vendors, so they attest on behalf of every test; a test
// that wants the refusal deletes the variable itself.
//
// This is deliberately NOT a default in .env.example or docker-compose: the
// attestation has to be a decision someone makes about a real account.
process.env.ELEVENLABS_COMMERCIAL_USE ??= "true";

// No test may reach a carrier.
//
// `src/lib/twilio.ts` refuses to put a request on the wire unless the
// deployment attests live send, and a real deployment sets that in `.env`
// because the product's whole job is calling customers. Bun loads `.env` into
// `bun test`, so the attestation would otherwise be inherited by every suite —
// and the twenty-signal latency gate would send twenty real SMS. It did.
//
// `delete`, not `??=`: this is a hard floor, not a default. A suite that wants
// to exercise an outbound send opts back in explicitly and stubs
// `globalThis.fetch`, so the assertion is about our request and never about a
// handset. See tests/unit/twilio-live-send-guard.test.ts.
delete process.env.TWILIO_LIVE_SEND;

// Same hard floor for the per-case master key (WP-15): a real `.env` has one,
// and a suite that seals without setting it explicitly would silently depend
// on operator config. Suites that exercise sealing set their own (tests/privacy,
// tests/webhooks); the post-call ingest test also asserts the key-less drop.
delete process.env.PRIVACY_MASTER_KEY;

// A test-only Better Auth secret, so a suite that reaches the auth layer runs
// on a machine that has not configured one.
//
// `src/lib/better-auth.ts` refuses to construct with a missing or short
// BETTER_AUTH_SECRET, and the import is what three tenancy suites trip on the
// first time they touch a route (`console-routes`, `crm-and-pull-routes`,
// `isolation`). A developer's `.env` may or may not carry one, so the suite was
// green or red depending on the machine, which is the worst of both.
//
// `??=`, not `=`: a real environment wins, and this value is never a credential.
// It is a constant in a test harness, and anything that reaches an actual Better
// Auth crypto path in a suite should set its own — the same rule the three hard
// floors above already follow.
process.env.BETTER_AUTH_SECRET ??= "test-only-better-auth-secret-not-a-credential-0123456789abcdef";

// The origin Better Auth derives its own URLs from, same reasoning as above: the
// three tenancy suites that construct the auth layer fail to import without it,
// which made them red or green depending on whether the developer's `.env`
// happened to carry it. `??=` again, and a real environment still wins.
process.env.BETTER_AUTH_URL ??= process.env.APP_URL ?? "http://localhost:3000";

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

// Append-only audit log (prisma/migrations/9zzzzzzzzz_immutable_audit and
// ..._audit_immutability_grants) puts a BEFORE UPDATE/DELETE trigger on "AuditLog"
// that raises, so a compromised app credential cannot rewrite history. Production
// keeps it. Several DB-backed suites mutate AuditLog on purpose — teardown wipes
// the rows they seeded, and the chain tamper-detection gates forge a row to prove
// verifyChain() names it — which a fully-migrated database blocks (P0001). This
// preload runs ONLY under `bun test` and disables the trigger on whatever
// DATABASE_URL the run points at, best-effort: a database without the migration
// fails the ALTER and it is ignored.
//
// Read what that costs. `ALTER TABLE ... DISABLE TRIGGER` is persistent TABLE
// state, not session state — it is not reverted when the test process exits, so
// the guard is off for EVERY connection to that database for the rest of the run,
// and until `scripts/run-tests.mjs` restores it, after it. Measured on the dev
// database, not reasoned: `pg_trigger.tgenabled` read 'D' between runs. That
// window is why the control has a second, harness-independent half: the same
// migration REVOKEs UPDATE and DELETE from `sv_tenant`, which keeps binding the
// tenant-scoped path (`src/lib/tenancy/db-scope.ts`) while this is off, and which
// no amount of table-state fiddling from a test process can reach.
//
// So this line is not "the feature is untested and therefore un-masking".
// Prevention is asserted with the trigger live by
// tests/tenancy/audit-immutability.test.ts, which enables it inside a transaction
// it always rolls back, and which then asserts the catalog state it found is the
// state it leaves.
if (process.env.DATABASE_URL) {
  try {
    const { default: pg } = await import("pg");
    const c = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 4000,
    });
    await c.connect();
    await c.query('ALTER TABLE "AuditLog" DISABLE TRIGGER no_modify_audit');
    await c.end();
  } catch {
    // No database reachable, or the trigger does not exist yet — nothing to do.
  }
}
