#!/usr/bin/env bun
/**
 * Blue/green deployment for SecureVoice AI.
 *
 *   bun scripts/deploy.mjs deploy   --image ghcr.io/org/repo:v0.4.0
 *   bun scripts/deploy.mjs rollback
 *   bun scripts/deploy.mjs status
 *   bun scripts/deploy.mjs promote            # after a successful soak, stop the old colour
 *
 * ── Why the switch is health-gated ───────────────────────────────────────────
 * The failure this prevents is deploying a build that starts, answers
 * `/api/health`, and is then unable to reach its database. `healthcheck` alone
 * cannot catch that, because compose considers a container healthy on its own
 * probe; the probe here is `/api/readyz`, which asserts the dependency the
 * instance cannot serve without. `app-blue`/`app-green` in
 * docker-compose.bluegreen.yml both use readyz for the same reason.
 *
 * ── The rollback guarantee ────────────────────────────────────────────────────
 * A colour flip is a one-line change to `APP_UPSTREAM` plus a caddy recreate.
 * The OLD colour is never stopped during `deploy`, so any failure before or
 * immediately after the flip leaves a serving instance untouched. `rollback`
 * therefore never rebuilds — it flips back to a container that is still warm.
 *
 * What this does NOT give you: safety against a bad DATABASE MIGRATION. Code
 * rolls back; a migration that dropped a column does not. Migrate before
 * deploying, and prefer expand/contract so the old build still works against the
 * new schema. See docs/DEPLOY.md.
 *
 * ── State ─────────────────────────────────────────────────────────────────────
 * `.deploy/state.json` records the active and previous colour. It is the single
 * source of truth for `rollback`; nothing else writes it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = resolve(ROOT, ".deploy");
const STATE = resolve(STATE_DIR, "state.json");
const ENV_ACTIVE = resolve(STATE_DIR, "active.env");

const BASE = ["-f", "docker-compose.yml", "-f", "docker-compose.bluegreen.yml"];
const COLOURS = ["blue", "green"];

const opposite = (c) => (c === "blue" ? "green" : "blue");

function compose(args, opts = {}) {
  const r = spawnSync("docker", ["compose", ...BASE, ...args], {
    cwd: ROOT,
    stdio: opts.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`\ndocker compose ${args.join(" ")} failed (exit ${r.status})`);
    if (opts.capture) console.error(r.stderr ?? "");
    process.exit(r.status ?? 1);
  }
  return r;
}

function readState() {
  if (!existsSync(STATE)) return { active: null, previous: null, image: null };
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    // A corrupt state file must not strand the deploy. Default to "unknown" and
    // let `status` re-derive from the running containers.
    return { active: null, previous: null, image: null };
  }
}

function writeState(next) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(next, null, 2));
  writeFileSync(ENV_ACTIVE, `APP_UPSTREAM=app-${next.active}:3000\n`);
}

/** Wait for a colour's container to report healthy, or give up. */
async function waitHealthy(colour, timeoutMs = 180_000) {
  const service = `app-${colour}`;
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`  waiting for ${service} to be healthy`);
  while (Date.now() < deadline) {
    const r = spawnSync(
      "docker",
      [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
        service,
      ],
      { encoding: "utf8" },
    );
    const status = r.stdout?.trim();
    if (status === "healthy") {
      console.log(" ok");
      return true;
    }
    if (status === "unhealthy" || status === "exited" || status === "dead") {
      console.log(` ${status}`);
      return false;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(" TIMEOUT");
  return false;
}

/**
 * Prove the colour answers on its OWN port, not just through Caddy.
 * A colour that is healthy in isolation but unreachable through the proxy is
 * exactly the case that must not receive traffic.
 */
function probeDirect(colour) {
  const r = spawnSync(
    "docker",
    [
      "exec",
      `app-${colour}`,
      "bun",
      "-e",
      "fetch('http://127.0.0.1:3000/api/readyz').then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>{console.log('ERR');process.exit(1)})",
    ],
    { encoding: "utf8" },
  );
  const code = r.stdout?.trim();
  return { ok: r.status === 0, code };
}

function flipTraffic(colour) {
  // caddy is the ONLY public process, so recreating just it moves all traffic.
  // The colours are untouched and keep serving while caddy restarts.
  compose(["up", "-d", "--no-deps", "caddy"], { capture: true });
  const state = readState();
  writeState({ ...state, active: colour, previous: state.active });
}

function stopColour(colour) {
  if (!colour) return;
  spawnSync("docker", ["compose", ...BASE, "stop", `app-${colour}`], {
    cwd: ROOT,
    stdio: "inherit",
  });
  spawnSync("docker", ["compose", ...BASE, "rm", "-f", `app-${colour}`], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

async function deploy(image) {
  if (!image) {
    console.error("usage: bun scripts/deploy.mjs deploy --image <ref>");
    process.exit(1);
  }
  const state = readState();
  const target = state.active ? opposite(state.active) : "blue";
  const serving = state.active;

  console.log(`\nblue/green deploy`);
  console.log(`  image      ${image}`);
  console.log(`  bringing up colour  ${target}`);
  console.log(`  currently serving    ${serving ?? "(none — first deploy)"}`);

  // 1. Bring the NEW colour up ALONGSIDE the running one.
  compose(["up", "-d", `app-${target}`], {
    capture: true,
    env: { ...process.env, IMAGE: image },
  });

  // 2. Gate on its own readiness.
  const healthy = await waitHealthy(target);
  if (!healthy) {
    console.error(`\n  ✗ app-${target} never became healthy — traffic NOT moved.`);
    console.error(`    logs: docker compose logs app-${target}`);
    stopColour(target);
    process.exit(1);
  }

  const probe = probeDirect(target);
  if (!probe.ok) {
    console.error(
      `\n  ✗ app-${target} is healthy but /api/readyz failed in-container (${probe.code}) — traffic NOT moved.`,
    );
    stopColour(target);
    process.exit(1);
  }

  // 3. Move traffic. The old colour is still running.
  console.log(`\n  flipping traffic to app-${target}`);
  flipTraffic(target);
  writeState({ active: target, previous: serving, image });

  // 4. Verify THROUGH the proxy, which is the path a caller actually takes.
  console.log(`  verifying through caddy`);
  const viaProxy = spawnSync(
    "curl",
    ["-fsS", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1/api/readyz"],
    { encoding: "utf8" },
  );
  const status = viaProxy.stdout?.trim();
  if (viaProxy.status !== 0 || status !== "200") {
    console.error(
      `\n  ✗ post-switch probe failed (got "${status ?? "no response"}") — ROLLING BACK.`,
    );
    rollback();
    process.exit(1);
  }

  console.log(`\n  ✓ live on ${target} (${image})`);
  if (serving) {
    console.log(`\n  app-${serving} is still running and warm.`);
    console.log(`  soak, then: bun scripts/deploy.mjs promote   (stops app-${serving})`);
    console.log(`  or revert:  bun scripts/deploy.mjs rollback`);
  }
}

function rollback() {
  const state = readState();
  if (!state.previous) {
    console.error("\n  no previous colour recorded — nothing to roll back to.");
    process.exit(1);
  }
  console.log(`\n  rolling back: app-${state.active} → app-${state.previous}`);
  // Flip first, THEN stop. Stopping before the flip is an outage, not a rollback.
  compose(["up", "-d", "--no-deps", `app-${state.previous}`], { capture: true });
  flipTraffic(state.previous);
  writeState({ ...state, active: state.previous, previous: state.active });
  console.log(`  ✓ live on ${state.previous}. The failed colour was left running for inspection.`);
}

function promote() {
  const state = readState();
  if (!state.active || !state.previous) {
    console.error("\n  nothing to promote — no previous colour recorded.");
    process.exit(1);
  }
  console.log(`\n  promoting: stopping app-${state.previous}`);
  stopColour(state.previous);
  writeState({ ...state, previous: null });
}

async function status() {
  const state = readState();
  console.log("\nblue/green status");
  console.log(`  active     ${state.active ?? "(unknown)"}`);
  console.log(`  previous   ${state.previous ?? "(none)"}`);
  console.log(`  image      ${state.image ?? "(unknown)"}`);
  for (const c of COLOURS) {
    const r = spawnSync(
      "docker",
      [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
        `app-${c}`,
      ],
      { encoding: "utf8" },
    );
    if (r.stdout) console.log(`  app-${c.padEnd(6)} ${r.stdout.trim()}`);
  }
  const curl = spawnSync(
    "curl",
    ["-fsS", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1/api/health"],
    {
      encoding: "utf8",
    },
  );
  console.log(`  via caddy  ${curl.stdout?.trim() ?? "unreachable"}`);
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "deploy": {
    const i = rest.indexOf("--image");
    await deploy(i >= 0 ? rest[i + 1] : undefined);
    break;
  }
  case "rollback":
    rollback();
    break;
  case "promote":
    promote();
    break;
  case "status":
    await status();
    break;
  default:
    console.error(
      "usage: bun scripts/deploy.mjs <deploy --image REF | rollback | promote | status>",
    );
    process.exit(1);
}
