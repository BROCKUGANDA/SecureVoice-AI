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
const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort();

if (files.length === 0) {
  console.error("no test files found in tests/");
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["test", `tests/${f}`], { stdio: "inherit" });
  if (r.status !== 0) failed = 1;
}
process.exit(failed);
