#!/usr/bin/env bun
/**
 * Test runner: executes each tests/*.test.ts in its OWN Bun process.
 *
 * Why not `bun test tests/`? Bun 1.4.x on Windows intermittently panics
 * (bmalloc non-unwinding panic) when multiple test files share one process
 * with a mock preload. One process per file is deterministic everywhere and
 * gives each file a clean module registry — which is what you want for
 * env-mutating flag tests anyway.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = new URL("../tests/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// Optional path filters: `bun scripts/run-tests.mjs tenancy e2e` runs only the
// suites whose path contains one of them. Bare `bun run test` passes none, so
// the default gate still runs everything.
const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
// Recursive: gate tests live in subdirectories (tests/e2e, tests/tools,
// tests/webhooks) and every *.test.ts must run in `bun run test`.
const files = readdirSync(dir, { recursive: true })
  .filter((f) => String(f).endsWith(".test.ts"))
  .map((f) => String(f).split("\\").join("/"))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  // Ordering is a real dependency, not an accident of the alphabet:
  // `docs/load-artifact-consistency.test.ts` checks docs/CAPACITY.md against
  // `evidence/load/results.json`, so the load gate must produce that artifact
  // FIRST. Alphabetically `docs` sorts before `load`, which silently compared
  // the document against the PREVIOUS run's numbers.
  .sort((a, b) => {
    const rank = (f) => (f.startsWith("load/") ? 0 : f.startsWith("docs/") ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

if (files.length === 0) {
  console.error("no test files found in tests/");
  process.exit(1);
}

// The capacity gate's database, named once because two things need it: the suite
// that measures against it, and the guard restoration below that has to switch
// the audit trigger back on in the same place the suite switched it off.
const LOAD_DB =
  process.env.LOAD_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/securevoice_load?connection_limit=20";

let failed = 0;
let ranLoadSuite = false;
for (const f of files) {
  // The capacity gate runs against its own database. It measures how much load
  // the system sustains, and a shared database carries another suite's rows
  // and gauges into that measurement — which shows up as run-to-run drift and
  // an evidence artifact that disagrees with itself. Everything else shares
  // TEST_DATABASE_URL.
  const env = { ...process.env };
  if (f.startsWith("load/")) {
    ranLoadSuite = true;
    env.LOAD_DATABASE_URL = LOAD_DB;
  }

  // Every test process writes its spans to its own scratch log unless it asked
  // otherwise, because the DEFAULT destination of `recordSpanAndPersist` is the
  // COMMITTED artifact `evidence/latency/spans.jsonl`. Two bad things follow from
  // leaving that to the default: a local `bun run test` appends harness traffic to
  // an artifact that is published as measurement (so the developer either commits
  // polluted evidence or remembers to `git checkout` it — a discipline, not a
  // guarantee), and a suite cannot assert that a span was persisted durably without
  // racing whatever the previous suite left in the file.
  //
  // `bun run evidence` is the sanctioned producer of the artifact and sets its own
  // path; a test that genuinely wants to exercise the default path deletes this
  // variable itself, which `tests/telemetry/telemetry.test.ts` already does.
  if (!env.TELEMETRY_SPAN_LOG) {
    const slug = f.replace(/[^\w.-]+/g, "-");
    env.TELEMETRY_SPAN_LOG = join(
      tmpdir(),
      "securevoice-test-spans",
      `${process.pid}-${slug}.jsonl`,
    );
  }

  // Per-test timeout. Bun defaults to 5_000ms, which is unrealistically tight
  // for the DB-backed gates: the shared test database is a REMOTE Postgres at
  // roughly a 2-second round trip, and several suites open a transaction per
  // row. Measured on tests/privacy/privacy.test.ts against that database:
  //
  //     bun test tests/privacy/privacy.test.ts
  //       2 pass / 9 fail   — every failure at exactly ~5000ms
  //     bun test tests/privacy/privacy.test.ts --timeout 120000
  //      11 pass / 0 fail
  //
  // Those nine were never broken; they were being killed by the clock
  // mid-flight. A failure that lands uniformly ON the ceiling is a harness
  // artefact, not a defect, and left unset it turns a green suite red on any
  // machine slower than the developer's.
  //
  // Set here rather than only in bunfig.toml because the flag is honoured
  // everywhere `bun run test` is the entry point, including a bare `bun test`
  // from an editor or CI. Per-gate latency budgets (WP-2's p95, the tool p95)
  // declare their own explicit timeout and are unaffected.
  const r = spawnSync(process.execPath, ["test", `tests/${f}`, "--timeout", "120000"], {
    stdio: "inherit",
    env,
  });
  if (r.status !== 0) failed = 1;
}

// ── Put the audit guard back ─────────────────────────────────────────────────
// `tests/preload.ts` disables the BEFORE UPDATE/DELETE trigger on "AuditLog" so
// the suites that legitimately mutate it (teardown, the chain-forging gates) can
// run. `ALTER TABLE ... DISABLE TRIGGER` is persistent TABLE state, so nothing
// reverts it when a suite's process exits: without this step, every `bun run test`
// ends by leaving a production-shaped database with its append-only guarantee
// switched off, and the application connecting to it cannot be told the table is
// immutable.
//
// Restoration is part of the run's verdict, not housekeeping. A control the test
// harness disabled and did not re-enable is a defect the next reader inherits, and
// a `console.log` they have to notice is not a gate.
const GUARD_READ = `
  SELECT t.tgenabled::text AS enabled
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relname = 'AuditLog' AND t.tgname = 'no_modify_audit' AND NOT t.tgisinternal`;

async function restoreAuditGuard(label, url) {
  if (!url) return `${label}: no database configured — nothing to restore`;
  let client;
  try {
    const { default: pg } = await import("pg");
    client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await client.connect();
    const found = await client.query(GUARD_READ);
    if (found.rows.length === 0) {
      return `${label}: no audit trigger in this database — nothing to restore`;
    }
    if (found.rows[0].enabled !== "O")
      await client.query(`ALTER TABLE "AuditLog" ENABLE TRIGGER no_modify_audit`);
    const after = await client.query(GUARD_READ);
    const state = after.rows[0]?.enabled;
    if (state !== "O") {
      failed = 1;
      return `${label}: FAILED to re-enable the audit guard (catalog says ${JSON.stringify(state)})`;
    }
    return `${label}: audit guard re-enabled (${found.rows[0].enabled} → O)`;
  } catch (e) {
    failed = 1;
    return `${label}: could not restore the audit guard — ${e.message}`;
  } finally {
    await client?.end().catch(() => undefined);
  }
}

const functionalDb = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
console.log("\n— audit immutability guard —");
console.log(await restoreAuditGuard("functional suites", functionalDb));
// Only the database that actually ran a suite: a filtered `bun run test:unit` must
// not be judged on a capacity database it never touched.
if (ranLoadSuite) console.log(await restoreAuditGuard("capacity gate", LOAD_DB));

process.exit(failed);
