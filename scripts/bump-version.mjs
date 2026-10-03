/**
 * Keep package.json's version in step with a release tag.
 *
 * The release workflow treats the TAG as the version authority and fails if
 * package.json disagrees. That only works if there is a way to move package.json
 * without hand-editing it, which is this script:
 *
 *   bun run version:bump 0.3.0     # or `v0.3.0`, the prefix is optional
 *
 * It refuses to bump to a version that is not strictly greater than the current
 * one, so a re-tag or a typo cannot quietly republish an older number.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = resolve(root, "package.json");

const raw = process.argv[2];
if (!raw) {
  console.error("usage: bun run version:bump <version>   e.g. 0.3.0");
  process.exit(1);
}

const next = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`"${raw}" is not a plain semver version (expected MAJOR.MINOR.PATCH)`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version ?? "0.0.0";

/** Numeric compare, so 0.10.0 correctly sorts above 0.9.0. */
const cmp = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
};

if (cmp(next, current) <= 0) {
  console.error(`refusing to move ${current} -> ${next}: versions must increase`);
  process.exit(1);
}

pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`version ${current} -> ${next}`);
console.log(
  `next: git commit -am "chore: release v${next}" && git tag v${next} && git push --follow-tags`,
);
