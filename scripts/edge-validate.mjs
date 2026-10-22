#!/usr/bin/env bun
/**
 * Validate the shared front door's configuration.
 *
 * ── Why this is a script and not a line in a workflow ────────────────────────────
 *
 * It has to run in three places — CI, a developer's laptop, and the
 * production box before the switch — and the invocation is a `docker run`
 * with two bind mounts, which does not survive being written three times by
 * hand in three shells. It also has to work on Windows, where the path
 * separator in a `-v` argument is a backslash and the shell will not treat
 * `&&` the way a POSIX shell does.
 *
 * ── Why it exists at all ────────────────────────────────────────────────────────
 *
 * The front door is what every public hostname on the box depends on, and
 * NOTHING else in this repository can catch a syntax error in it. `caddy
 * validate` reads the Caddyfile; it does not read the front door's maps, and
 * the maps are what the front door's routing is made of.
 *
 * Two real errors were found by running this, and neither was visible to any
 * other check in the repository:
 *
 *   1. A map entry written without the terminating semicolon that nginx's
 *      `map` syntax requires. `nginx -t` refused the WHOLE configuration
 *      with "unexpected end of file, expecting ; or }" — a total outage of
 *      every public name, from a typo in a two-line file.
 *   2. `$host` used in the `stream` context, where it does not exist. The
 *      variable is an HTTP-module variable; the stream module has
 *      `$ssl_preread_server_name` and nothing that reads a plaintext Host
 *      header. The error was "unknown host variable".
 *
 * The second one is the reason the front door has a `http {}` listener on
 * :80 alongside its L4 `stream` listener on :443: a plaintext connection
 * carries no SNI, so a hostname cannot be read out of one without parsing
 * HTTP. The TLS path — where every credential and every byte of case data
 * travels — is still never parsed.
 *
 * ── What it does ───────────────────────────────────────────────────────────────
 *
 * Runs `nginx -t` in the same image the front door runs (nginx:1.27-alpine),
 * with the configuration and the whole fragment directory mounted exactly as
 * the front door mounts them. `nginx -t` validates the configuration AND
 * every file it includes, which is the point: the maps are included by the
 * config, so the maps are what has to be right.
 *
 * Exits non-zero on failure, so a CI step and a pre-flight check can both
 * rely on it.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The image the front door runs, from edge/compose.yml.
 *
 * Hard-coded here rather than parsed out of the compose file: the compose
 * file's image tag is the thing that has to be right, and a parse that could
 * silently read nothing is worse than a constant that has to be updated in
 * two places. It is asserted against the compose file by
 * tests/unit/edge-isolation.test.ts, so the two cannot drift.
 */
const IMAGE = "nginx:1.27-alpine";

const config = resolve(ROOT, "edge/nginx/edge.conf");
const fragments = resolve(ROOT, "edge/nginx/edge.d");

const r = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    `${config}:/etc/nginx/nginx.conf:ro`,
    "-v",
    `${fragments}:/etc/nginx/edge.d:ro`,
    IMAGE,
    "nginx",
    "-t",
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
if (out) console.log(out);

if (r.error) {
  console.error(`\n  could not run ${IMAGE}: ${r.error.message}`);
  console.error("  docker is required to validate the front door's configuration.");
  process.exit(1);
}
if (r.status !== 0) {
  console.error("\n  the shared front door's configuration is INVALID — nginx refused it.");
  console.error("  every public hostname on the box is served through it.");
  process.exit(r.status ?? 1);
}
console.log("\n  the shared front door's configuration is valid.");
