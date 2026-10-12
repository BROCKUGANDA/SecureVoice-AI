/**
 * Copy the static assets Next.js leaves out of the standalone bundle.
 *
 * `next build` emits `.next/standalone/` without `.next/static` or `public`, which
 * is fine for a dev server and produces a standalone image that serves no CSS or
 * JS at all. This restores both.
 *
 * Exists because the previous shell one-liner was `cp -r …`, which only works on
 * a Unix shell: under Windows the npm/bun script runner resolves it to a binary
 * that rejects `-r` ("cp: illegal option -- r"), so `bun run build` failed after
 * a perfectly good compile. Node's fs is identical on every platform, so this
 * has no shell dependency at all.
 *
 * Failures are fatal by design — a silently incomplete standalone bundle is much
 * worse to debug in a container than a build that stops here.
 */
import { cp, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = resolve(root, ".next", "standalone");

/** [source, destination] pairs, relative to the project root. */
const COPIES = [
  [".next/static", ".next/standalone/.next/static"],
  ["public", ".next/standalone/public"],
  // The graceful-shutdown preload, placed INSIDE the bundle on purpose.
  //
  // The Dockerfile's runner stage copies only `.next/standalone`, so anything the
  // container runs at boot must live in there. `scripts/` currently appears in
  // the output by accident — Next traces the whole project in because of a
  // filesystem access in src/lib/telemetry/store.ts, and that warning is itself
  // something to fix. Relying on it would mean the container's CMD breaks the day
  // that tracing is tightened, so the dependency is made explicit here instead.
  ["scripts/server-preload.ts", ".next/standalone/server-preload.ts"],
];

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

for (const [from, to] of COPIES) {
  const src = resolve(root, from);
  const dest = resolve(root, to);

  if (!(await exists(src))) {
    // `public/` is optional in a Next project; a missing static dir is not.
    if (from === "public") {
      console.log(`[copy-standalone] no ${from}/ — skipping`);
      continue;
    }
    throw new Error(`[copy-standalone] missing ${from}/ — did \`next build\` succeed?`);
  }

  await cp(src, dest, { recursive: true, force: true });
  console.log(`[copy-standalone] ${from} -> ${to}`);
}
