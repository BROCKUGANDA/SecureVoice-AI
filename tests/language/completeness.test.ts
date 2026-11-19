/**
 * Language-table completeness gate.
 *
 * The platform speaks six languages (en, ar, hi, ur, fr, sw) and every
 * per-language phrase table MUST cover all of them. A table that silently
 * misses a language answers a speaker of that language in English — the
 * register's "unsupported language" failure, arriving as a bug instead of a
 * documented limitation.
 *
 * The scan is a text scan over production sources, deliberately the same
 * heuristic shape as `run-tests.mjs`' source invariants: find top-level
 * `const NAME: ... = {` objects whose body keys include at least three of the
 * six language codes, and require all six. Tables with fewer than three keys
 * (record shapes, type literals with `en: string`) are not phrase tables and
 * are skipped rather than false-positived.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const LANGS = ["en", "ar", "hi", "ur", "fr", "sw"] as const;

function productionSources(): string[] {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      const stat = statSync(p);
      if (stat.isDirectory()) {
        if (!/node_modules|\.next|generated|dist/.test(p)) walk(p);
      } else if (/\.tsx?$/.test(f) && !/\.test\.|_test/.test(f)) {
        files.push(p);
      }
    }
  })(join(ROOT, "src"));
  return files;
}

type Gap = { where: string; name: string; missing: string[] };

function findGaps(): Gap[] {
  const gaps: Gap[] = [];
  for (const file of productionSources()) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^(?:export )?const (\w+)(?::\s*[^=]+)? = \{/.exec(lines[i] ?? "");
      if (!m) continue;
      // Collect the object body by brace depth until the closing line.
      let depth = 1;
      let j = i;
      const body: string[] = [];
      while (depth > 0 && j < lines.length - 1) {
        j++;
        for (const ch of lines[j] ?? "") {
          if (ch === "{") depth++;
          if (ch === "}") depth--;
        }
        body.push(lines[j] ?? "");
      }
      const bodyStr = body.join("\n");
      if (!/\ben:/.test(bodyStr)) continue;
      const present = LANGS.filter((l) => new RegExp(`\\b${l}:`).test(bodyStr));
      if (present.length >= 3 && present.length < LANGS.length) {
        gaps.push({
          where: `${rel}:${i + 1}`,
          name: m[1] ?? "unknown",
          missing: LANGS.filter((l) => !present.includes(l)),
        });
      }
    }
  }
  return gaps;
}

describe("six-language phrase-table completeness", () => {
  test("every per-language table covers en, ar, hi, ur, fr, sw", () => {
    const gaps = findGaps();
    expect(
      gaps,
      `incomplete language tables (a speaker of a missing language hears English): ${gaps
        .map((g) => `${g.where} ${g.name} missing [${g.missing.join(",")}]`)
        .join("; ")}`,
    ).toEqual([]);
  });

  test("the audit actually scans production sources", () => {
    // The gate must not pass vacuously: the sources list must be populated,
    // and at least one KNOWN complete table must exist in the corpus.
    const files = productionSources();
    expect(files.length).toBeGreaterThan(100);
    const corpus = files.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const table of ["NEVER_ASK_LINE", "SAFE_REFUSAL", "OPENING_DISCLOSURE"]) {
      expect(corpus).toContain(table);
    }
  });
});
