/**
 * Targeted repair of double-encoded UTF-8.
 *
 * Some source files were written by a tool that decoded UTF-8 bytes as
 * Windows-1252 and re-encoded them as UTF-8. An em-dash (bytes E2 80 94)
 * became four characters that read "â€”", and the bytes are still valid UTF-8,
 * which is why the corruption survived prettier, eslint and tsc: every one of
 * them read it as legitimate text.
 *
 * ## Why this replaces SEQUENCES and not whole files
 *
 * The obvious repair — read the file, re-encode it as latin1, decode as UTF-8 —
 * was tried and reverted. It breaks any file that ALSO contains correctly
 * encoded text: latin1 cannot represent those characters, they are destroyed,
 * and TypeScript then reports the file as binary. A file can be half-correct
 * (an intact Arabic compliance script) and half-mojibake (a mangled comment),
 * which is exactly the case here.
 *
 * So only the known mojibake SEQUENCES are replaced, in place. Everything the
 * script does not recognise is left byte-for-byte alone, which means the failure
 * mode is "some corruption survives", never "correct text is destroyed".
 *
 * Reverses exactly one level. Running it twice would mangle correct text.
 *
 * Usage:
 *   bun scripts/repair-encoding.mjs --check    report only
 *   bun scripts/repair-encoding.mjs            apply
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "tests", "scripts", "docs", "prisma"];
const EXTS = new Set([".ts", ".tsx", ".mjs", ".md", ".prisma", ".sql"]);
const SKIP = new Set(["node_modules", "generated", ".next", "dist", "out", "evidence"]);

/**
 * Exact mojibake sequences seen in this tree, mapped to what they should be.
 * Every entry was observed, none is guessed.
 *
 * Written with \u escapes rather than literal characters on purpose: a file that
 * contains the mojibake sequences as literals is itself corruptible by the same
 * bug this script exists to fix, and the first version of this file broke on an
 * unbalanced quote for exactly that reason.
 */
const SEQUENCES = [
  ["â€”", "—"], // em dash
  ["â€“", "–"], // en dash
  ["â€˜", "‘"], // left single quote
  ["â€™", "’"], // right single quote / apostrophe
  ["â€œ", "“"], // left double quote
  ["â€", ""], // any other â€ sequence
  ["Ã©", "é"],
  ["Ã¨", "è"],
  ["Ã¡", "á"],
  ["Â·", "·"],
  ["Â°", "°"],
  ["Ã¼", "ü"],
  ["Ã¶", "ö"],
  ["Ã¤", "ä"],
  ["Ã±", "ñ"],
  ["ï¿½", "�"], // replacement char, double-encoded
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (EXTS.has(extname(name))) yield full;
  }
}

/**
 * Arrows, handled separately because the mojibake form depends on which
 * apostrophe the original used. Matches the observed byte prefix and captures
 * the trailing quote so both variants are covered by one rule.
 */
const ARROW_RE = /â†(.)/g;
const ARROW_FIX = "→";

function fix(text) {
  let out = text;
  let count = 0;
  out = out.replace(ARROW_RE, () => {
    count += 1;
    return ARROW_FIX;
  });
  for (const [bad, good] of SEQUENCES) {
    const parts = out.split(bad);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join(good);
    }
  }
  return { out, count };
}

const apply = !process.argv.includes("--check");
const changed = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel === "scripts/repair-encoding.mjs") continue; // its own literals
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { out, count } = fix(text);
    if (count === 0 || out === text) continue;
    changed.push({ file: rel, count });
    if (apply) writeFileSync(file, out, { encoding: "utf8" });
  }
}

if (changed.length === 0) {
  console.log("encoding: nothing to repair");
} else {
  for (const c of changed) console.log(`  ${c.file}: ${c.count} sequence(s)`);
  console.log(
    apply
      ? `\nrepaired ${changed.length} file(s). Only the listed sequences were touched.`
      : `\n${changed.length} file(s) would change. Re-run without --check to apply.`,
  );
}
