#!/usr/bin/env node
/**
 * Idempotent .env upsert for the overage + email wiring.
 *
 * Upserts by KEY: an existing line with the same key is replaced in place (so
 * the value can change without duplicating the key), a missing key is appended
 * under a labelled block. Re-running is a no-op.
 *
 * Usage: node scripts/env-upsert.mjs <file> <json-of-key-values>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [file, json] = process.argv.slice(2);
if (!file || !json) {
  console.error("usage: node scripts/env-upsert.mjs <file> <json>");
  process.exit(2);
}
const pairs = JSON.parse(json);

let text = existsSync(file) ? readFileSync(file, "utf8") : "";
const lines = text.split(/\r?\n/);
const replaced = new Set();

for (const [key, value] of Object.entries(pairs)) {
  const line = `${key}=${JSON.stringify(String(value))}`;
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    // Match `KEY=` at line start, optionally with `export ` and leading spaces.
    if (new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(lines[i])) {
      lines[i] = line;
      found = true;
      replaced.add(key);
      break;
    }
  }
  if (!found) {
    lines.push(line);
    replaced.add(key);
  }
}

// Normalise: ensure the file ends with exactly one newline.
text = lines.join("\n").replace(/\n*$/, "\n");
writeFileSync(file, text, "utf8");
console.log(`upserted ${replaced.size} key(s) into ${file}`);
