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
