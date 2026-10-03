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

let failed = 0;
for (const f of files) {
  // The capacity gate runs against its own database. It measures how much load
  // the system sustains, and a shared database carries another suite's rows
  // and gauges into that measurement — which shows up as run-to-run drift and
  // an evidence artifact that disagrees with itself. Everything else shares
  // TEST_DATABASE_URL.
  const env = { ...process.env };
  if (f.startsWith("load/")) {
    env.LOAD_DATABASE_URL =
      process.env.LOAD_DATABASE_URL ??
      "postgresql://postgres@127.0.0.1:5432/securevoice_load?connection_limit=20";
  }

  const r = spawnSync(process.execPath, ["test", `tests/${f}`], { stdio: "inherit", env });
  if (r.status !== 0) failed = 1;
}
process.exit(failed);
