#!/usr/bin/env bun
/**
 * Coverage gate.
 *
 * Why this exists instead of `bun test --coverage`: scripts/run-tests.mjs runs
 * each tests/*.test.ts in its OWN process (Bun 1.4.x on Windows panics when
 * several files share a process with a mock preload). `--coverage` is per
 * process, so no single invocation sees the whole suite. This script does what
 * the runner does — one process per file — but asks each for an lcov profile,
 * then merges the profiles and enforces thresholds over the union.
 *
 * Two details that are load-bearing rather than incidental:
 *
 *   · Bun emits Windows-style backslash paths in `SF:`. Every path is normalised
 *     to forward slashes before merging, because two spellings of one file would
 *     otherwise register as two files and silently halve its denominator.
 *   · A line hit by two different processes is ONE hit. Merging counts the union
 *     of hit sets rather than summing counts, so overlap between suites cannot
 *     inflate the numerator.
 *
 * The denominator is the whole `src/` tree, not just the files the suite
 * happened to import. A file no test ever loads is 0% — that is the fact this
 * gate exists to surface.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TESTS = resolve(ROOT, "tests");
const RAW = resolve(ROOT, ".coverage");
const OUT = resolve(ROOT, "coverage");

// Thresholds are ENFORCED, not advisory. `overall` was raised from 80 to 85:
// 85% is the bar for a merge to `main`, and a number that is measured and then
// ignored is worse than no gate — it is a gate everyone has learned to look
// past. The per-tier numbers stay as they are, because they describe what each
// tier is FOR (integration proves wiring, e2e proves the surface); only
// `overall` is a claim about the codebase as a whole.
//
// COVERAGE_MIN_OVERALL lets CI state the bar for the branch it is gating — 85 on
// the way into `main`, report-only on the way into `dev`/`staging` — so this
// value is the default rather than the only option.
const THRESHOLDS = {
  overall: Number(process.env.COVERAGE_MIN_OVERALL ?? 85),
  unit: 70,
  integration: 20,
  e2e: 10,
};

/**
 * Which tier a source file counts toward, and whether it counts at all.
 * Generated Prisma output and vendored shadcn components are excluded: they are
 * machine-written, and including them is the difference between a number that
 * means something and one that does not.
 */
function tierOf(rel) {
  if (rel.startsWith("src/generated/")) return null;
  if (rel.startsWith("src/components/")) return null; // vendored shadcn/ui
  if (rel.endsWith(".d.ts")) return null;
  if (rel.includes("/node_modules/")) return null;

  // e2e: the surface a browser actually loads. Pages are what a journey runs
  // through, so views and the app entry files are the e2e denominator.
  if (rel.startsWith("src/views/")) return "e2e";
  if (rel === "src/app/page.tsx" || rel === "src/app/layout.tsx") return "e2e";

  // integration: correctness depends on the database, a transaction, or an
  // outbound provider call. These cannot be exercised as pure functions.
  if (rel.startsWith("src/app/api/")) return "integration";
  const integrationModules = [
    "src/lib/db.ts",
    "src/lib/store.ts",
    "src/lib/outbox.ts",
    "src/lib/idempotency.ts",
    "src/lib/audit-chain.ts",
    "src/lib/activity-feed.ts",
    "src/lib/twilio.ts",
    "src/lib/tts-quota.ts",
    "src/lib/notifications.ts",
    "src/lib/admission.ts",
    "src/lib/capacity.ts",
    "src/lib/connection-state.ts",
    "src/lib/agent-tool-auth.ts",
  ];
  const integrationDirs = [
    "src/lib/auth/store",
    "src/lib/billing/",
    "src/lib/payments/",
    "src/lib/elevenlabs/",
    "src/lib/tenancy/",
    "src/lib/identity/",
    "src/lib/privacy/",
    "src/lib/compliance/",
    "src/lib/contracts/",
    "src/lib/redteam/",
    "src/lib/abuse/",
    "src/lib/telemetry/",
  ];
  if (integrationModules.includes(rel)) return "integration";
  if (integrationDirs.some((p) => rel.startsWith(p))) return "integration";

  // Everything else in the app/worker tree is treated as unit-reachable: pure
  // logic that does not need a database to be exercised.
  if (rel.startsWith("src/")) return "unit";
  return "unit";
}

/** Parse one lcov.info into { file -> {lines:Set, hit:Set} }. */
function parseLcov(text) {
  const files = new Map();
  let file = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      file = line.slice(3).replace(/\\/g, "/");
      if (!files.has(file)) files.set(file, { lines: new Set(), hit: new Set() });
    } else if (line.startsWith("DA:") && file) {
      const [num, count] = line.slice(3).split(",");
      const entry = files.get(file);
      entry.lines.add(num);
      if (Number(count) > 0) entry.hit.add(num);
    } else if (line === "end_of_record") {
      file = null;
    }
  }
  return files;
}

/** Union of profiles. A line hit anywhere is a hit; overlap never double-counts. */
function merge(profiles) {
  const merged = new Map();
  for (const p of profiles) {
    for (const [file, data] of p) {
      const entry = merged.get(file) ?? { lines: new Set(), hit: new Set() };
      for (const n of data.lines) entry.lines.add(n);
      for (const n of data.hit) entry.hit.add(n);
      merged.set(file, entry);
    }
  }
  return merged;
}

/** Every .ts/.tsx under src/ — the denominator, including never-imported files. */
function sourceUniverse() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(resolve(ROOT, "src"));
  return out;
}

/**
 * Instrumentable lines for a file Bun never reported on: every line that is not
 * blank and not a comment. This is a deliberate approximation — it is what makes
 * an untested file count as 0% rather than silently vanishing from the report.
 */
function approximateLines(text) {
  const count = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;
  return count;
}

const pct = (hit, total) => (total === 0 ? 100 : (hit / total) * 100);

function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const skipSlow = process.argv.includes("--fast");

  const testFiles = readdirSync(TESTS, { recursive: true })
    .map(String)
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f.endsWith(".test.ts"))
    .filter((f) => !skipSlow || !/^(load|chaos|e2e)\//.test(f))
    .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
    // Same ordering dependency as run-tests.mjs: the load gate must produce
    // evidence/load/results.json before docs/load-artifact-consistency reads it.
    .sort((a, b) => {
      const rank = (f) => (f.startsWith("load/") ? 0 : f.startsWith("docs/") ? 1 : 2);
      return rank(a) - rank(b) || a.localeCompare(b);
    });

  if (testFiles.length === 0) {
    console.error("no test files found in tests/");
    process.exit(1);
  }

  rmSync(RAW, { recursive: true, force: true });
  mkdirSync(RAW, { recursive: true });

  const profiles = [];
  let failed = 0;

  for (const f of testFiles) {
    const slug = f.replace(/[/.]/g, "_");
    const env = { ...process.env };
    if (f.startsWith("load/")) {
      env.LOAD_DATABASE_URL =
        process.env.LOAD_DATABASE_URL ??
        "postgresql://postgres@127.0.0.1:5432/securevoice_load?connection_limit=20";
    }
    const r = spawnSync(
      process.execPath,
      [
        "test",
        `tests/${f}`,
        "--coverage",
        "--coverage-reporter=lcov",
        `--coverage-dir=${RAW}/${slug}`,
      ],
      {
        stdio: ["ignore", "ignore", "inherit"],
        env,
      },
    );
    const lcov = resolve(RAW, slug, "lcov.info");
    if (existsSync(lcov)) {
      profiles.push(parseLcov(readFileSync(lcov, "utf8")));
    } else if (r.status !== 0) {
      console.error(`  [coverage] no lcov from tests/${f} (exit ${r.status})`);
    }
    if (r.status !== 0) {
      failed = 1;
      console.error(`FAIL tests/${f} (exit ${r.status})`);
    }
  }

  const merged = merge(profiles);
  const byAbs = new Map([...merged.keys()].map((p) => [resolve(ROOT, p), merged.get(p)]));

  const tiers = {
    unit: { hit: 0, total: 0 },
    integration: { hit: 0, total: 0 },
    e2e: { hit: 0, total: 0 },
  };
  const rows = [];

  for (const abs of sourceUniverse()) {
    const rel = relative(ROOT, abs).replace(/\\/g, "/");
    const tier = tierOf(rel);
    if (tier === null) continue;

    const data = byAbs.get(abs);
    const total = data ? data.lines.size : approximateLines(readFileSync(abs, "utf8"));
    const hit = data ? data.hit.size : 0;

    tiers[tier].total += total;
    tiers[tier].hit += hit;
    rows.push({ rel, tier, hit, total, pct: pct(hit, total) });
  }

  const overall = {
    hit: tiers.unit.hit + tiers.integration.hit + tiers.e2e.hit,
    total: tiers.unit.total + tiers.integration.total + tiers.e2e.total,
  };

  rows.sort((a, b) => a.pct - b.pct || a.rel.localeCompare(b.rel));

  // Full report: every file, so the number is auditable rather than a bare total.
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    resolve(OUT, "coverage-summary.txt"),
    [
      "file".padEnd(56),
      "tier".padEnd(13),
      "hit".padStart(6),
      "total".padStart(7),
      "pct".padStart(7),
      "",
      ...rows.map(
        (r) =>
          `${r.rel.padEnd(56)} ${r.tier.padEnd(13)} ${String(r.hit).padStart(6)} ${String(r.total).padStart(7)} ${r.pct.toFixed(1).padStart(6)}%`,
      ),
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    resolve(OUT, "coverage.json"),
    JSON.stringify({ thresholds: THRESHOLDS, overall, tiers, rows }, null, 2),
    "utf8",
  );

  const show = only.length > 0;
  console.log("");
  if (show) {
    for (const r of rows.filter((x) => x.pct < 80)) {
      console.log(`  ${r.pct.toFixed(1).padStart(6)}%  ${r.tier.padEnd(12)} ${r.rel}`);
    }
    console.log("");
  }

  let gateFailed = failed === 1;
  console.log("── coverage ──");
  for (const [name, t] of Object.entries({ overall, ...tiers })) {
    const p = pct(t.hit, t.total);
    const need = THRESHOLDS[name];
    const mark = p >= need ? "PASS" : "FAIL";
    console.log(
      `  ${name.padEnd(12)} ${p.toFixed(2).padStart(6)}%  (${t.hit}/${t.total} lines)  need ${need}%  ${mark}`,
    );
    if (p < need) gateFailed = true;
  }
  console.log(`  report: coverage/coverage-summary.txt`);
  if (gateFailed && !show) console.log("  (test failures also fail this gate)");

  process.exit(gateFailed ? 1 : 0);
}

main();
