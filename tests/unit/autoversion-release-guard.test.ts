/**
 * Guard the autoVersion release check against the two bugs that broke it.
 *
 * The workflow asserts the bump actually applied by piping the script's output
 * into `grep -qF -- "-> $next"`. That line had TWO independent faults, each of
 * which alone aborted a release after package.json had been rewritten but
 * before any commit or tag:
 *
 *   1. it read `tail -n 1`. The script prints `version 0.2.1 -> 0.2.2` and THEN
 *      `next: git commit …`, so the last line is the hint (or the trailing
 *      empty line) and never the confirmation. The right line is `head -n 1`.
 *
 *   2. the grep pattern begins with a dash, and without `--` grep parses
 *      `-> 0.2.2` as options and exits 2 with `invalid option -- '>'`.
 *
 * This test runs the REAL script (against a copied package.json, so the repo's
 * own version file is never touched) and asserts the resulting `head -n 1` line
 * is greppable with the exact flags the workflow uses — including the negative
 * case, so a weakened check cannot pass by matching nothing.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SCRIPT = join(ROOT, "scripts", "bump-version.mjs");

/** The exact grep invocation the workflow uses. */
function grepMatches(pattern: string, input: string): { matched: boolean; exit: number } {
  try {
    execFileSync("grep", ["-qF", "--", pattern], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
    });
    return { matched: true, exit: 0 };
  } catch (e) {
    return { matched: false, exit: (e as { status?: number }).status ?? -1 };
  }
}

function scriptOutput(next: string): string[] {
  // Mirror the repo layout under a scratch dir — `scripts/bump-version.mjs`
  // resolves package.json relative to ITS OWN location, so a flat copy would
  // look for one directory too high. This still never touches the real files.
  const dir = mkdtempSync(join(tmpdir(), "bump-"));
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  cpSync(SCRIPT, join(scriptsDir, "bump-version.mjs"));
  // Start from a low version so any bump is strictly greater than current.
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ version: "0.0.0" }, null, 2)}\n`);

  const out = execFileSync("bun", [join(scriptsDir, "bump-version.mjs"), next], {
    encoding: "utf8",
  });
  return out.split("\n").filter((l) => l.length > 0);
}

describe("autoVersion release guard (scripts/bump-version.mjs + workflow grep)", () => {
  it("prints the confirmation line first, which is the one the workflow must read", () => {
    const lines = scriptOutput("0.2.2");
    expect(lines[0]).toBe("version 0.0.0 -> 0.2.2");
    // The `next:` hint is what the broken `tail -n 1` used to select.
    expect(lines[1]).toContain("git commit");
    expect(lines[1]).not.toContain("->");
  });

  it("makes the first line greppable with the workflow's exact flags", () => {
    const first = scriptOutput("0.2.2")[0];
    const { matched, exit } = grepMatches("-> 0.2.2", first);
    expect(matched).toBe(true);
    expect(exit).toBe(0);
  });

  it("rejects a version that did not apply — the check must not match nothing", () => {
    const first = scriptOutput("0.2.2")[0];
    expect(grepMatches("-> 0.2.3", first).matched).toBe(false);
  });

  it("fails loudly, without --, proving the separator is load-bearing", () => {
    let exit = -1;
    try {
      execFileSync("grep", ["-qF", "-> 0.2.2"], {
        input: "version 0.0.0 -> 0.2.2",
        encoding: "utf8",
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (e) {
      exit = (e as { status?: number }).status ?? -1;
    }
    // grep exits 2 on a usage error — this is the failure CI hit.
    expect(exit).toBe(2);
  });

  it("refuses to bump to a non-greater version", () => {
    expect(() => execFileSync("bun", [SCRIPT, "0.0.0"], { stdio: "pipe" })).toThrow();
  });
});
