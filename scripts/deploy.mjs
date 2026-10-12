#!/usr/bin/env bun
/**
 * Blue/green deployment for SecureVoice AI.
 *
 *   bun scripts/deploy.mjs deploy   --image ghcr.io/org/repo:v0.4.0
 *   bun scripts/deploy.mjs rollback
 *   bun scripts/deploy.mjs status
 *   bun scripts/deploy.mjs promote            # after a successful soak, stop the old colour
 *   bun scripts/deploy.mjs canary --percent 5 # send 5% of traffic to the standby colour
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
 * ── How the flip actually reaches Caddy ───────────────────────────────────────
 * Through the FILE `.deploy/active.env`, which the caddy service mounts via
 * `env_file` and which this script is the only writer of. That ordering is not
 * cosmetic: the file must be written BEFORE caddy is recreated, or the new
 * container starts on the previous value and the flip silently does nothing.
 * An earlier version wrote the state file AFTER recreating caddy and also
 * declared `APP_UPSTREAM` as a compose interpolation, which meant
 * `docker compose up -d caddy` aborted outright on any host that had not
 * exported the variable — i.e. every host, since this script never exported it.
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

/**
 * Granularity of a canary split: 20 slots, so a percentage lands on a 5% step.
 * Not arbitrary — see `upstreamList` for why a split is repetition at all.
 */
const CANARY_SLOTS = 20;

/**
 * The `APP_UPSTREAM` value for a traffic split.
 *
 * Caddy 2.11.4 has NO `weighted_round_robin` lb_policy (verified with
 * `caddy validate` against caddy:2-alpine — it accepts random, round_robin,
 * least_conn, first, ip_hash, uri_hash and cookie), and a `weight`
 * subdirective is rejected. So a weighted split is expressed the way Caddy can
 * actually do it: the upstream list is REPEATED proportionally and
 * `lb_policy round_robin` shares requests across it. 5% is the new colour once
 * and the old colour nineteen times.
 *
 * With round_robin the split is exact over any window of 20 requests rather
 * than probabilistic, which is a stronger property than a weighted random
 * policy would have given.
 *
 * `percent` of 0 or undefined yields a single upstream — the plain blue/green
 * flip, and the state every other command expects.
 */
function upstreamList(active, canary, percent) {
  if (!canary || percent === undefined || percent <= 0) return `app-${active}:3000`;
  const canarySlots = Math.min(
    CANARY_SLOTS,
    Math.max(0, Math.round((percent / 100) * CANARY_SLOTS)),
  );
  const activeSlots = CANARY_SLOTS - canarySlots;
  return [
    ...Array.from({ length: activeSlots }, () => `app-${active}:3000`),
    ...Array.from({ length: canarySlots }, () => `app-${canary}:3000`),
  ].join(" ");
}

/**
 * Persist the deploy state AND the upstream file Caddy reads.
 *
 * `active.env` is the only thing that puts `APP_UPSTREAM` into Caddy's process
 * environment (docker-compose.bluegreen.yml gives the caddy service an
 * `env_file` pointing at it). It must therefore be written BEFORE the caddy
 * container is recreated — writing it afterwards, as this did, meant the
 * recreate read the PREVIOUS value and the flip silently did nothing.
 */
function writeState(next) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(next, null, 2));
  const upstream = next.upstream ?? `app-${next.active}:3000`;
  writeFileSync(
    ENV_ACTIVE,
    `# Written by scripts/deploy.mjs — do not hand-edit.\n` +
      `# Read by the caddy service via env_file in docker-compose.bluegreen.yml.\n` +
      `APP_UPSTREAM=${upstream}\n`,
  );
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

function flipTraffic(colour, split) {
  // ORDER MATTERS: persist the new upstream FIRST, then recreate caddy. Caddy
  // reads APP_UPSTREAM from its process environment, which compose supplies from
  // `.deploy/active.env`; recreating it before that file is updated would bring
  // the container back on the PREVIOUS value and the flip would do nothing.
  const state = readState();
  writeState({
    ...state,
    active: colour,
    previous: colour === state.active ? state.previous : state.active,
    upstream: split ?? `app-${colour}:3000`,
  });
  // caddy is the ONLY public process, so recreating just it moves all traffic.
  // The colours are untouched and keep serving while caddy restarts.
  compose(["up", "-d", "--no-deps", "caddy"], { capture: true });
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
  // `flipTraffic` writes the state file itself, before recreating caddy — see
  // the ordering note there.
  console.log(`\n  flipping traffic to app-${target}`);
  flipTraffic(target, upstreamList(target, null, 0));
  writeState({ active: target, previous: serving, image, upstream: `app-${target}:3000` });

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
  writeState({ ...state, previous: null, upstream: `app-${state.active}:3000` });
}

/**
 * Bring the STANDBY colour up on an image and verify it, WITHOUT moving traffic.
 *
 * The missing step that makes a canary possible: `deploy` flips 100% of traffic
 * as soon as the new colour is healthy, so by the time it returns there is
 * nothing left to canary onto. `stage` does the first half only — start, gate on
 * readiness, probe in-container — and leaves the active colour serving.
 *
 * After a successful stage, `canary --percent N` shifts a slice of real traffic
 * onto the staged colour.
 */
async function stage(image) {
  if (!image) {
    console.error("usage: bun scripts/deploy.mjs stage --image <ref>");
    process.exit(1);
  }
  const state = readState();
  const target = state.active ? opposite(state.active) : "blue";
  const serving = state.active;

  console.log(`\nstage (no traffic move)`);
  console.log(`  image              ${image}`);
  console.log(`  staging colour     ${target}`);
  console.log(`  still serving      ${serving ?? "(none — first deploy)"}`);

  compose(["up", "-d", `app-${target}`], {
    capture: true,
    env: { ...process.env, IMAGE: image },
  });

  const healthy = await waitHealthy(target);
  if (!healthy) {
    console.error(`\n  ✗ app-${target} never became healthy.`);
    console.error(`    logs: docker compose logs app-${target}`);
    stopColour(target);
    process.exit(1);
  }

  const probe = probeDirect(target);
  if (!probe.ok) {
    console.error(
      `\n  ✗ app-${target} is healthy but /api/readyz failed in-container (${probe.code}).`,
    );
    stopColour(target);
    process.exit(1);
  }

  writeState({ ...state, image, staged: target });
  console.log(`\n  ✓ app-${target} is staged and verified. Traffic has NOT moved.`);
  console.log(`    next: bun scripts/deploy.mjs canary --percent 5`);
}

/**
 * Send a PERCENTAGE of traffic to the non-active colour.
 *
 *   bun scripts/deploy.mjs canary --percent 5              # 5% to the standby colour
 *   bun scripts/deploy.mjs canary --percent 50             # half
 *   bun scripts/deploy.mjs canary --percent 100            # full switch (== deploy's flip)
 *   bun scripts/deploy.mjs canary --percent 0              # back to the active colour only
 *
 * The standby colour must already be running: this command never builds or
 * starts anything, because a canary that deploys code as a side effect is a
 * deploy with extra steps. Run `deploy --image …` first (which brings the new
 * colour up and, by default, moves 100% of traffic to it), or start the standby
 * colour deliberately, then canary onto it.
 *
 * `--to <colour>` targets an explicit colour; omitted, the standby colour is the
 * one that is not currently serving.
 */
function canary({ to, percent }) {
  const state = readState();
  if (!state.active) {
    console.error("\n  no active colour recorded — run `deploy` first.");
    process.exit(1);
  }
  if (percent === undefined || Number.isNaN(percent)) {
    console.error("usage: bun scripts/deploy.mjs canary --percent <0-100> [--to blue|green]");
    process.exit(1);
  }
  const target = to ?? opposite(state.active);
  if (!COLOURS.includes(target)) {
    console.error(`\n  unknown colour "${target}" — expected one of ${COLOURS.join(", ")}.`);
    process.exit(1);
  }

  const pct = Math.min(100, Math.max(0, Math.round(percent)));

  // A 100% canary IS a flip, and a 0% canary is a revert to the active colour.
  // Both are expressed as the plain single-upstream form so the state file never
  // records a split that means "one colour" — a reader should not have to work
  // out that twenty identical entries are really one upstream.
  if (pct === 100) {
    console.log(`\n  canary 100% → app-${target} (full switch)`);
    flipTraffic(target, `app-${target}:3000`);
    console.log(`  ✓ all traffic on app-${target}`);
    return;
  }
  if (pct === 0) {
    console.log(`\n  canary 0% → reverting all traffic to app-${state.active}`);
    flipTraffic(state.active, `app-${state.active}:3000`);
    console.log(`  ✓ all traffic on app-${state.active}`);
    return;
  }

  const slots = Math.round((pct / 100) * CANARY_SLOTS);
  if (slots === 0) {
    console.error(
      `\n  ${pct}% is below this split's ${100 / CANARY_SLOTS}% granularity — use 0 or a multiple of ${100 / CANARY_SLOTS}.`,
    );
    process.exit(1);
  }

  const split = upstreamList(state.active, target, pct);
  console.log(
    `\n  canary ${slots}/${CANARY_SLOTS} slots → ${pct}% app-${target}, ${100 - pct}% app-${state.active}`,
  );
  console.log(
    `  upstreams: ${split.split(" ").length} entries (repetition + lb_policy round_robin)`,
  );
  flipTraffic(target, split);
  // `active` stays the colour taking the majority: `rollback` and `promote`
  // reason about which colour is the safe one, and at <50% the canary is not.
  writeState({
    ...readState(),
    active: state.active,
    previous: state.previous,
    canary: { colour: target, percent: pct },
    upstream: split,
  });
  console.log(`\n  ✓ split live. Watch Sentry, then:`);
  console.log(`      bun scripts/deploy.mjs canary --percent 100   # accept the canary`);
  console.log(`      bun scripts/deploy.mjs canary --percent 0     # abandon it`);
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
  case "canary": {
    const p = rest.indexOf("--percent");
    const t = rest.indexOf("--to");
    canary({
      percent: p >= 0 ? Number(rest[p + 1]) : undefined,
      to: t >= 0 ? rest[t + 1] : undefined,
    });
    break;
  }
  case "status":
    await status();
    break;
  case "stage": {
    const i = rest.indexOf("--image");
    await stage(i >= 0 ? rest[i + 1] : undefined);
    break;
  }
  default:
    console.error(
      "usage: bun scripts/deploy.mjs <deploy --image REF | stage --image REF | rollback | promote | canary --percent N [--to COLOUR] | status>",
    );
    process.exit(1);
}
