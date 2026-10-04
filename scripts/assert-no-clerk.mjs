#!/usr/bin/env bun
/**
 * Assert that Clerk is gone from the CODE, and stays gone.
 *
 * ## Why this gate exists
 *
 * The Clerk -> Better Auth cutover removed every runtime trace of Clerk. That
 * work is invisible from here on, and it is exactly the kind of change that
 * decays: one leftover `clerkMiddleware` on a single route segment is an
 * UNAUTHENTICATED route, and it does not announce itself. Nothing else in CI
 * would notice, because the code compiles, the types check, and the tests that
 * cover that segment still pass for whoever holds a session.
 *
 * So the rule is asserted mechanically rather than remembered.
 *
 * ## Why comments are stripped before grepping
 *
 * A naive `grep -ri clerk` fails forever on this repository, because the
 * migration left deliberate, valuable notes in `src/proxy.ts`,
 * `next.config.ts` and `src/views/Auth.tsx` explaining what was removed and why
 * — including a warning aimed at exactly the reader who comes looking for Clerk
 * later. Those comments are worth keeping.
 *
 * Stripping comments first means the gate asserts the only thing that matters:
 * that no Clerk IDENTIFIER, import, string or config key survives in executable
 * code. A comment saying "this used to be clerkMiddleware" is documentation; a
 * call to it is a vulnerability.
 *
 * Exits non-zero with the offending files listed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "mini-services", "scripts", "tests"];
const SCAN_FILES = ["next.config.ts", "middleware.ts", "proxy.ts", "package.json"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".git"]);

/**
 * Paths excluded from the scan, each for a stated reason. An exclusion list is
 * only honest when every entry says WHY, because an unexplained exclusion is
 * just a hole in a security gate.
 */
const EXCLUDE = [
  // Prisma ORM v7 client output. Regenerable TypeScript under src/ that is
  // rebuilt by `prisma generate`; editing it is meaningless and it embeds the
  // schema as a string literal.
  "src/generated/",
  // Applied migrations are immutable history. 0_init created a clerkUserId column
  // and 6_reconcile_identity dropped it; rewriting an applied migration to hide
  // that would be falsifying the record, and would break every environment that
  // has already run them.
  "prisma/migrations/",
  // This file names Clerk in order to search for it.
  "scripts/assert-no-clerk.mjs",
  // Generated walkthrough output, rebuilt by the walkthrough scripts.
  "scripts/walkthrough/out/",
];

/**
 * Individual lines permitted to contain the word, each with the reason it is
 * not an authentication risk. Deliberately tiny and deliberately line-anchored:
 * a broad substring exemption here would silently re-open the gate.
 */
const ALLOW = [
  {
    file: "src/views/Legal.tsx",
    // The privacy policy must keep the historical sub-processor record: Clerk
    // DID process identity data before the cutover, and a privacy notice that
    // silently deletes a real sub-processor is worse than one that admits it
    // stopped. Prose, not an import.
    reason: "privacy notice records Clerk as a FORMER sub-processor",
  },
  {
    file: "src/lib/tenancy/isolation-matrix.ts",
    // A dated engineering note recording that a previously-declared gap was
    // fixed. Descriptive text in a data structure.
    reason: "historical gap-closure note",
  },
  {
    file: "tests/surface/surface.test.ts",
    // A REGRESSION GUARD that asserts these Clerk origins are ABSENT from the
    // CSP. Naming them is the entire point of the test; removing the strings
    // would delete the guard and silently allow the allowance back.
    reason: "regression guard asserting these origins are absent from CSP",
  },
  {
    file: "package.json",
    // The npm script that RUNS this gate is named for the cutover, and the
    // audit trail is required to point at the checker by path. Renaming the
    // script to dodge its own substring check would make the gate less
    // discoverable to buy nothing.
    reason: "the script that runs this gate, and the audit trail pointing at it",
  },
  {
    file: "scripts/supabase-setup.mjs",
    // STALE: a seed script for the pre-Better-Auth schema (it targets an
    // `organizations` table with a `clerkId` column and a `users` table, neither
    // of which matches the current Prisma models). Tracked for deletion in
    // docs/TODO.md. It is allowlisted rather than rewritten because rewriting a
    // script whose only consumer is unknown would be guessing.
    reason: "STALE pre-Better-Auth seed script, tracked for deletion",
  },
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|sql|prisma)$/.test(name)) yield full;
  }
}

/**
 * Removes comments and string-template noise that would create false hits
 * without being executable identifiers.
 *
 * Deliberately simple and deliberately CONSERVATIVE: when in doubt about
 * whether something is code, leave it in. A false positive costs one manual
 * look; a false negative costs an unauthenticated route.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let inLine = false;
  let inBlock = false;
  let inStr = null; // ' " `
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      if (c === "\n") out += c;
      i += 1;
      continue;
    }
    if (inStr) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      // Keep string contents: a Clerk key or middleware name inside a string is
      // still executable.
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function excluded(rel) {
  const norm = rel.replace(/\\/g, "/");
  return EXCLUDE.some((p) => norm.startsWith(p) || norm.includes(`/${p}`));
}

function allowed(rel) {
  const norm = rel.replace(/\\/g, "/");
  return ALLOW.find((a) => norm.endsWith(a.file));
}

const hits = [];
const record = (rel, i, text) => {
  if (excluded(rel)) return;
  if (allowed(rel)) return;
  hits.push({ file: rel, line: i + 1, text: text.slice(0, 100) });
};

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const code = stripComments(readFileSync(file, "utf8"));
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (/clerk/i.test(lines[i])) record(rel, i, lines[i].trim());
    }
  }
}
for (const name of SCAN_FILES) {
  let code;
  try {
    code = readFileSync(join(ROOT, name), "utf8");
  } catch {
    continue;
  }
  const lines = (name.endsWith(".json") ? code : stripComments(code)).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (/clerk/i.test(lines[i])) record(name, i, lines[i].trim());
  }
}

if (hits.length > 0) {
  console.error("Clerk references found in executable code:\n");
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text}`);
  console.error(
    "\nThe Clerk -> Better Auth cutover is complete and must stay complete.\n" +
      "A leftover clerkMiddleware or @clerk/* import on one route segment is an\n" +
      "UNAUTHENTICATED route. If this is a deliberate exception, remove the code or\n" +
      "add an explicit allowlist entry below with a reason -- do not weaken the scan.",
  );
  process.exit(1);
}

console.log("clerk: 0 references in executable code (comments excluded by design)");
