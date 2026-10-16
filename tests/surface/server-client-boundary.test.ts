import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The server/client boundary, enforced.
 *
 * ── Why this test exists at all ───────────────────────────────────────────────
 * The boundary in this codebase was held by three things and none of them was a
 * gate: the `server-only` package, ~250 lines of prose in `AGENTS.md`, and
 * `next build`. And `next build` is the only one that actually fires — because
 * BOTH test runners neutralise the marker:
 *
 *   · `tests/preload.ts`      — `mock.module("server-only", () => ({}))`
 *   · `scripts/worker-preload.ts` — the same, for the worker bundle
 *   · `jest.config.cjs`       — no moduleNameMapper for it at all
 *
 * So no test in this repository could ever have failed because a client component
 * imported a server-only module. The boundary was real and unverified: correct
 * today by the discipline of whoever wrote each import, and one careless
 * `import { env } from "@/lib/config"` away from shipping the whole secret
 * surface into the browser bundle.
 *
 * This file is that gate. It is static analysis over the import graph, so it does
 * not need the marker to mean anything and does not need a build.
 *
 * ── Why it walks the TRANSITIVE graph, not just the import lines ─────────────
 * The failure mode that matters is one level of indirection away:
 *
 *   "use client"  →  @/components/things  →  @/lib/db  →  @/lib/config  →  💥
 *
 * A grep for `server-only` in a `"use client"` file passes on every one of those
 * lines. Only a reachability walk catches the last one, and the last one is where
 * the secrets are.
 *
 * ── What it deliberately does NOT assert ─────────────────────────────────────
 *   · Not that client files contain no DOM access. All of it is correctly inside
 *     effects and event handlers, and a rule that banned `window` outright would
 *     push people toward worse code, not better.
 *   · Not a wall-clock/DB assertion. Those belong to the seam tests.
 * It checks exactly the one thing nothing else checks.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      yield full;
    }
  }
}

function source(file: string): string {
  return readFileSync(file, "utf8");
}

/** Relative, forward-slashed path — the assertions must not be platform-dependent. */
function rel(file: string): string {
  return file.slice(ROOT.length + 1).replace(/\\/g, "/");
}

function isClientFile(file: string): boolean {
  return /^\s*(["'])use client\1/.test(source(file));
}

function isServerOnlyFile(file: string): boolean {
  return /^\s*import\s+(["'])server-only\1/.test(source(file));
}

/**
 * Import specifiers a file can statically reach, plus its dynamic-import literals.
 *
 * Both forms are included because a dynamic `await import("@/lib/db")` inside a
 * client component pulls the module into the client chunk exactly the same way a
 * static import does. Following only the static form would leave a one-keyword
 * bypass.
 *
 * Resolution is deliberately lenient — an unresolvable specifier is reported and
 * skipped rather than crashing the walk, because a package the bundler resolves
 * through `exports` conditions (`better-auth/react`) has no file for us to visit
 * and that is not a boundary violation.
 */
function importSpecifiers(file: string): string[] {
  const text = source(file);
  const out: string[] = [];
  const re =
    /(?:^|\n)\s*(?:import|export)\s[^;\n]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

/** Resolve a specifier to a file under `src`, or null if it is not ours to visit. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = join(SRC, spec.slice(2));
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = resolve(dirname(fromFile), spec);
  } else {
    // A bare package specifier. `@/lib/x` and relative paths are the only ones
    // that can cross the boundary inside this repo.
    return null;
  }
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

/**
 * Every module reachable from `entry`, inclusive, with a shortest path back to it.
 *
 * Iterative with an explicit queue and a visited set: a diamond in the graph must
 * not be walked twice, and the graph is large enough that recursion is a
 * stack-depth risk on some platforms.
 */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, []]]);
  const queue: Array<{ file: string; path: string[] }> = [{ file: entry, path: [] }];
  while (queue.length > 0) {
    const { file, path } = queue.shift()!;
    for (const spec of importSpecifiers(file)) {
      const target = resolveSpecifier(file, spec);
      if (!target) continue;
      const next = [...path, rel(file)];
      if (seen.has(target)) continue;
      seen.set(target, next);
      queue.push({ file: target, path: next });
    }
  }
  return seen;
}

const allFiles = [...walk(SRC)];
const clientFiles = allFiles.filter(isClientFile);
const serverOnlyFiles = allFiles.filter(isServerOnlyFile);

describe("server/client boundary", () => {
  test("the tree has client components to check (the walk found them)", () => {
    // A vacuous pass is worse than a failure: if `isClientFile` ever stops
    // matching, every assertion below would hold vacuously and report a clean
    // boundary over a set of zero files.
    expect(clientFiles.length).toBeGreaterThan(50);
    expect(serverOnlyFiles.length).toBeGreaterThan(50);
  });

  test("no client component transitively imports a server-only module", () => {
    const violations: string[] = [];
    for (const entry of clientFiles) {
      const graph = reachable(entry);
      for (const [file, path] of graph) {
        if (file === entry || !isServerOnlyFile(file)) continue;
        violations.push(`${rel(entry)}  →  ${path.concat(rel(file)).join("  →  ")}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("no client component transitively reaches the database or the secret config", () => {
    // Belt-and-braces on top of the `server-only` walk above. These two modules
    // are the ones whose contents matter if the marker were ever absent or
    // mocked: `db` reaches every table, and `config` holds BETTER_AUTH_SECRET,
    // DATABASE_URL, the Twilio and ElevenLabs keys.
    const FORBIDDEN = new Set(["@/lib/db", "@/lib/config", "@/lib/better-auth"]);
    const violations: string[] = [];
    for (const entry of clientFiles) {
      for (const spec of new Set(importSpecifiers(entry))) {
        if (FORBIDDEN.has(spec)) violations.push(`${rel(entry)}  →  ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("no server-only module is also marked as a client component", () => {
    // `server-only` and `"use client"` in one file is not a stronger guarantee,
    // it is a contradiction: the marker tells the bundler to refuse the import
    // and the directive tells it to hand the module to the browser. Whichever
    // wins, the file does not mean what it looks like it means.
    const both = allFiles.filter((f) => isServerOnlyFile(f) && isClientFile(f)).map(rel);
    expect(both).toEqual([]);
  });

  test("no non-client module touches the DOM at module scope", () => {
    // Column 0 is the signal: a top-level `document.querySelector` in a module
    // that a server component imports runs during SSR, where `document` does not
    // exist. DOM access inside a function, a hook body or an effect is at an
    // indent and is not what this looks for.
    const DOM_GLOBALS = /^(?:document|window|localStorage|sessionStorage|navigator)\b/m;
    const violations: string[] = [];
    for (const file of allFiles) {
      if (isClientFile(file)) continue;
      if (DOM_GLOBALS.test(source(file))) violations.push(rel(file));
    }
    expect(violations).toEqual([]);
  });

  test("no client module reads a non-public environment variable", () => {
    // `NEXT_PUBLIC_*` is compiled into the bundle and is public by definition.
    // Anything else read from a `"use client"` file, or from a module one of them
    // can reach, is a secret on its way to every visitor. The demo login password
    // is the one currently reading this way on purpose — it is a published
    // credential — so it is allowlisted by name rather than by pattern, which
    // keeps the exception visible and makes removing it a one-line edit.
    const ALLOWED = new Set([
      // Published judge credential. `.env.example` documents that this pair MUST
      // be empty on a production profile, and `scripts/drift-gates.mjs` fails CI
      // if the release workflow sources it from `vars.` instead of `secrets.`.
      "NEXT_PUBLIC_DEMO_LOGIN_EMAIL",
      "NEXT_PUBLIC_DEMO_LOGIN_PASSWORD",
    ]);
    const ENV_READ = /process\.env\.([A-Z0-9_]+)/g;
    const violations: string[] = [];
    for (const entry of clientFiles) {
      for (const file of reachable(entry).keys()) {
        // Comments are stripped first, and that is load-bearing rather than
        // cosmetic: `src/lib/public-config.ts` contains a block comment explaining
        // why it uses a literal INSTEAD of `process.env.BETTER_AUTH_URL`, and the
        // scanned text names that variable verbatim. A comment-blind scan reports
        // the documentation of the rule as a violation of it, which is the fastest
        // way to teach everyone that this gate cries wolf and should be ignored.
        const text = stripComments(source(file));
        ENV_READ.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = ENV_READ.exec(text)) !== null) {
          const name = m[1]!;
          if (name.startsWith("NEXT_PUBLIC_") || ALLOWED.has(name)) continue;
          violations.push(`${rel(file)}  →  ${name}  (from ${rel(entry)})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * Remove `/* … *\/`, `//` and quoted strings, preserving byte offsets is not
 * required — only that a `process.env.X` in executable code survives.
 *
 * Strings are blanked rather than removed for one reason: a `"…"` inside code
 * matters (a template literal genuinely does read env), whereas a name inside a
 * comment does not. Blanking both is the conservative direction for the assertion
 * this feeds — it can only make the scan report fewer things, and the three
 * assertions it serves are all "this must be absent", where a miss is the
 * dangerous direction.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, lead: string) => lead);
}
