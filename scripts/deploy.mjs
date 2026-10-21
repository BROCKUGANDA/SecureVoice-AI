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

/**
 * The image the colour slots resolve to.
 *
 * The blue/green override declares `image: ${IMAGE:?…}` with NO default, on
 * purpose: a slot that resolved to the mutable `securevoice-ai-app:local` tag
 * could be serving a build nobody named, which is the stale-image condition
 * the production deploy path exists to catch. So every compose command
 * against the merged stack needs IMAGE — and a command that does not name an
 * image of its own (a traffic flip, a promote, a rollback) takes it from the
 * deploy state, then the environment, and never guesses.
 */
function resolveImage(explicit) {
  if (explicit) return explicit;
  const state = readState();
  if (state.image) return state.image;
  if (process.env.IMAGE) return process.env.IMAGE;
  return null;
}

function compose(args, opts = {}) {
  const image = opts.env?.IMAGE ?? resolveImage();
  const r = spawnSync("docker", ["compose", ...BASE, ...args], {
    cwd: ROOT,
    stdio: opts.capture ? "pipe" : "inherit",
    encoding: "utf8",
    env: {
      ...process.env,
      ...(opts.env ?? {}),
      ...(image ? { IMAGE: image } : {}),
    },
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
 * Every tunable this script reads, and where it comes from.
 *
 * The deploy script is the one program in this repository that runs ON the
 * production box, by hand, during an incident. A constant in it is a decision
 * nobody can change without a code change on the box, and the box is the one
 * place a code change is hardest. So each of them is an environment variable
 * with a documented default, and the defaults are the values this repository
 * has been shipping.
 *
 * A malformed value takes the default rather than failing: a typo in a
 * deployment variable must not stop a rollback, and a rollback that refuses to
 * run is worse than a rollback that runs with the shipped defaults.
 */
const TUNABLES = {
  /**
   * Granularity of a canary split: 20 slots, so a percentage lands on a 5%
   * step. Not arbitrary — see `upstreamList` for why a split is repetition at
   * all.
   */
  canarySlots: { name: "CANARY_SLOTS", fallback: 20, min: 2, max: 1_000 },
  /** The first split a canary widens TO. */
  canaryStartPercent: { name: "CANARY_START_PERCENT", fallback: 5, min: 0, max: 100 },
  /** The second split, before the release goes to 100%. */
  canaryMidPercent: { name: "CANARY_MID_PERCENT", fallback: 50, min: 0, max: 100 },
  /** How long each split is observed before the next one. */
  canarySoakSeconds: { name: "CANARY_SOAK_SECONDS", fallback: 300, min: 0, max: 86_400 },
  /** How often the soak probes the edge and the colour. */
  canaryProbeIntervalSeconds: {
    name: "CANARY_PROBE_INTERVAL_SECONDS",
    fallback: 30,
    min: 1,
    max: 3_600,
  },
  /** How long a colour is given to become healthy. */
  colourHealthTimeoutMs: { name: "COLOUR_HEALTH_TIMEOUT_MS", fallback: 180_000, min: 1_000 },
  /** How long a missing container is tolerated before the wait gives up. */
  colourContainerGraceMs: { name: "COLOUR_CONTAINER_GRACE_MS", fallback: 20_000, min: 0 },
  /** How often the health wait looks. */
  colourPollIntervalMs: { name: "COLOUR_POLL_INTERVAL_MS", fallback: 3_000, min: 100 },
  /** The port the colour slots serve on, inside the compose network. */
  appPort: { name: "APP_PORT", fallback: 3_000, min: 1, max: 65_535 },
  /** The origin the probes read, from the edge's point of view. */
  probeOrigin: { name: "PROBE_ORIGIN", fallback: "http://127.0.0.1", min: 0 },
  /** The health path the probes read. */
  probePath: { name: "PROBE_PATH", fallback: "/api/readyz", min: 0 },
  /** The liveness path `status` reads — a different path from readiness. */
  healthPath: { name: "HEALTH_PATH", fallback: "/api/health", min: 0 },
  /** How long a single probe may take. */
  probeTimeoutSec: { name: "PROBE_TIMEOUT_SEC", fallback: 15, min: 1, max: 300 },
};

/**
 * Read a tunable.
 *
 * A number that is not a number, or is out of range, takes the default. The
 * alternative — refusing — would mean a typo in a shell variable could stop a
 * rollback, and a rollback that will not run is the worst possible time to
 * discover one.
 */
function tunable(key) {
  const spec = TUNABLES[key];
  if (!spec) throw new Error(`unknown tunable: ${key}`);
  if (key === "probeOrigin" || key === "probePath") {
    const raw = process.env[spec.name];
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : spec.fallback;
  }
  const raw = Number(process.env[spec.name]);
  return Number.isFinite(raw) && raw >= spec.min && raw <= spec.max ? raw : spec.fallback;
}

/** The resolved tunables, read once so every use below agrees. */
const CANARY_SLOTS = tunable("canarySlots");
const APP_PORT = tunable("appPort");
const PROBE_PATH = tunable("probePath");
const HEALTH_PATH = tunable("healthPath");
const PROBE_TIMEOUT_SEC = tunable("probeTimeoutSec");

/**
 * The box's own `.env`, parsed once.
 *
 * The deploy script runs from a shell, so `process.env` does NOT carry the
 * deployment's configuration — that lives in the compose env file, which
 * compose reads and this script does not.
 */
function readDotEnv() {
  const out = {};
  let src;
  try {
    src = readFileSync(resolve(ROOT, ".env"), "utf8");
  } catch {
    return out;
  }
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const at = t.indexOf("=");
    if (at < 1) continue;
    const key = t.slice(0, at).trim();
    let val = t.slice(at + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * The origin the edge is reached at, for a probe that goes THROUGH it.
 *
 * ── Why the loopback address is not the answer ────────────────────────────────
 *
 * The default was `http://127.0.0.1`, which is right on a laptop running the
 * compose stack and WRONG on the production box, where Caddy's port 80 answers
 * an HTTP→HTTPS redirect. The probe asked for `/api/readyz` over plain HTTP
 * and got a **308** — a redirect, not a health answer — so the verification
 * could never succeed, and the first adoption attempt on the production box
 * rolled back a perfectly good flip because the edge was answering exactly as
 * configured.
 *
 * The site's real origin cannot be guessed: the Caddyfile's site list is
 * LITERAL (see the Caddyfile's gotcha 1 — a `{$VAR}` site address collides
 * fatally with a literal block for the same host), so there is no environment
 * variable that names it. The APP's own spelling of the same answer is
 * `NEXT_PUBLIC_SITE_URL` / `SITE_DOMAIN` / `SITE_ADDRESS`, and this mirrors
 * the resolution order in `src/lib/site-origin.ts` so the two cannot drift.
 */
function resolveProbeOrigin() {
  const explicit = process.env.PROBE_ORIGIN?.trim();
  if (explicit) return explicit;
  const dot = readDotEnv();
  const publicUrl = dot.NEXT_PUBLIC_SITE_URL?.trim();
  if (publicUrl) return publicUrl.replace(/\/+$/, "");
  const domain = dot.SITE_DOMAIN?.trim();
  if (domain) return `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  const host = dot.SITE_ADDRESS?.trim();
  if (host && host !== "localhost") return `https://${host}`;
  return tunable("probeOrigin");
}

const PROBE_ORIGIN = resolveProbeOrigin();

/** The upstream one colour serves on. */
const upstreamFor = (colour) => `app-${colour}:${APP_PORT}`;

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
  if (!canary || percent === undefined || percent <= 0) return upstreamFor(active);
  const canarySlots = Math.min(
    CANARY_SLOTS,
    Math.max(0, Math.round((percent / 100) * CANARY_SLOTS)),
  );
  const activeSlots = CANARY_SLOTS - canarySlots;
  return [
    ...Array.from({ length: activeSlots }, () => upstreamFor(active)),
    ...Array.from({ length: canarySlots }, () => upstreamFor(canary)),
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
  const upstream = next.upstream ?? upstreamFor(next.active);
  writeFileSync(
    ENV_ACTIVE,
    `# Written by scripts/deploy.mjs — do not hand-edit.\n` +
      `# Read by the caddy service via env_file in docker-compose.bluegreen.yml.\n` +
      `APP_UPSTREAM=${upstream}\n`,
  );
}

/**
 * The compose project name, read from the base compose file.
 *
 * `docker compose ps -q <service>` would have been the obvious way to ask
 * "is this service running", and it is WRONG here for a specific reason: the
 * blue/green override declares `image: ${IMAGE:?…}` with no default, so
 * compose refuses to PARSE the merged files without IMAGE — and it parses
 * them before it answers anything. A mode probe that depends on an
 * environment variable is a mode probe that reports "unknown" on the one host
 * where the operator has not set it, which is exactly when they are trying to
 * find out what is running.
 *
 * So the probe asks DOCKER directly, using the compose labels every
 * compose-created container carries, and the project name comes from the
 * tracked compose file rather than from an env var.
 */
function projectName() {
  try {
    const src = readFileSync(resolve(ROOT, "docker-compose.yml"), "utf8");
    const m = /^name:\s*(\S+)\s*$/m.exec(src);
    return m?.[1] ?? "securevoice-ai";
  } catch {
    return "securevoice-ai";
  }
}

/**
 * The container ID of a compose service, or "" when it is not running.
 *
 * Resolved through the compose labels rather than by container NAME, and the
 * distinction is not cosmetic. The colour slots used to declare
 * `container_name: securevoice-app-blue`, so `docker inspect app-blue` looked
 * for a container called `app-blue` that does not exist: the real name is the
 * PROJECT-prefixed one. Every health wait and every in-container probe
 * addressed a container that was never there, so a colour that was starting
 * up looked exactly like a colour that had died.
 *
 * The project label is part of the filter because this box serves a second
 * product: a bare service-name filter would find THAT product's `app`.
 */
function containerId(service) {
  const r = spawnSync(
    "docker",
    [
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${projectName()}`,
      "--filter",
      `label=com.docker.compose.service=${service}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return (r.stdout ?? "").trim().split(/\r?\n/).filter(Boolean)[0] ?? "";
}

/**
 * The image a colour slot is actually serving, or "" when it is not running.
 *
 * The flip needs an image to name, because the merged compose files refuse to
 * parse without one. The right image is the one the TARGET colour is serving,
 * not whatever the environment happens to hold: a flip that names the wrong
 * image would bring the colour slots up on the wrong build, which is the
 * stale-image condition the whole release path exists to catch.
 */
function colourImage(colour) {
  const id = containerId(`app-${colour}`);
  if (!id) return "";
  const r = spawnSync("docker", ["inspect", "--format", "{{.Config.Image}}", id], {
    encoding: "utf8",
  });
  return r.stdout?.trim() ?? "";
}

/**
 * The upstream Caddy is ACTUALLY serving, read from the running container.
 *
 * `stackMode()` answers "does a colour slot exist"; this answers "is the edge
 * served by one". They are not the same question, and the difference is the
 * whole difference between an adopted host and an interrupted adoption.
 *
 * Read from DOCKER rather than from `.deploy/active.env`, because the file is
 * what the deploy script WRITES and the container environment is what the
 * edge RUNS on. When a flip fails, the two disagree — the file names the new
 * colour and Caddy is still on the old one — and only the container tells the
 * truth.
 */
function runningUpstream() {
  const id = containerId("caddy");
  if (!id) return "";
  const r = spawnSync(
    "docker",
    ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", id],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const m = /^APP_UPSTREAM=(.*)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return "";
}

/**
 * Wait for the EDGE to answer, through the edge.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 *
 * Caddy is the only public process, and a traffic flip reaches it by
 * recreating the container. The new container needs a moment to bind the port
 * and serve, and a probe fired inside that window gets a connection refused —
 * which is not a verdict on the flip, it is a verdict on the clock.
 *
 * The second adoption attempt on the production box failed exactly this way:
 * the flip SUCCEEDED, the probe ran while Caddy was still "Up Less than a
 * second", it got `000`, and the script rolled back a perfectly good
 * adoption. The rollback was correct; the reason for it was not.
 *
 * So the flip waits for the edge before it returns, and every command that
 * flips (adopt, stage, canary, promote, rollback) inherits the wait.
 */
async function waitForEdge(timeoutMs = tunable("colourHealthTimeoutMs")) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write("  waiting for the edge to answer");
  while (Date.now() < deadline) {
    const r = spawnSync(
      "curl",
      [
        "-sS",
        "-o",
        "/dev/null",
        "--max-time",
        String(PROBE_TIMEOUT_SEC),
        "-w",
        "%{http_code}",
        `${PROBE_ORIGIN}${PROBE_PATH}`,
      ],
      { encoding: "utf8" },
    );
    const code = (r.stdout ?? "").trim();
    if (code === "200") {
      console.log(" 200");
      return true;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  console.log(" no response");
  return false;
}

/**
 * Which stack is actually serving.
 *
 * `bluegreen` — at least one colour slot exists.
 * `plain`     — only the base `app` service exists.
 * `unknown`   — neither. The stack is down, or was never started.
 *
 * The canary workflow branches on this, and the branch is the difference
 * between "roll out a canary" and "there is nothing to canary". Guessing would
 * be the wrong answer in BOTH directions: a canary against a plain stack
 * would leave a second project's containers fighting over ports 80 and 443,
 * and a deploy that assumed blue/green on a plain stack would take the site
 * down.
 */
export function stackMode() {
  if (containerId("app-blue") || containerId("app-green")) return "bluegreen";
  if (containerId("app")) return "plain";
  return "unknown";
}

/** Wait for a colour's container to report healthy, or give up. */
async function waitHealthy(colour, timeoutMs = tunable("colourHealthTimeoutMs")) {
  const service = `app-${colour}`;
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`  waiting for ${service} to be healthy`);
  while (Date.now() < deadline) {
    const id = containerId(service);
    if (!id) {
      // No container: either it has not been created yet or it was removed.
      // Compose creates it within a second of `up`, so a short grace period is
      // right, and beyond that the roll has failed.
      if (Date.now() > deadline - timeoutMs + tunable("colourContainerGraceMs")) {
        console.log(" no container");
        return false;
      }
    } else {
      const r = spawnSync(
        "docker",
        [
          "inspect",
          "--format",
          "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
          id,
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
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, tunable("colourPollIntervalMs")));
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
  const id = containerId(`app-${colour}`);
  if (!id) return { ok: false, code: "no-container" };
  const r = spawnSync(
    "docker",
    [
      "exec",
      id,
      "bun",
      "-e",
      `fetch('http://127.0.0.1:${APP_PORT}${PROBE_PATH}').then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>{console.log('ERR');process.exit(1)})`,
    ],
    { encoding: "utf8" },
  );
  const code = r.stdout?.trim();
  return { ok: r.status === 0, code };
}

async function flipTraffic(colour, split) {
  // ORDER MATTERS: persist the new upstream FIRST, then recreate caddy. Caddy
  // reads APP_UPSTREAM from its process environment, which compose supplies from
  // `.deploy/active.env`; recreating it before that file is updated would bring
  // the container back on the PREVIOUS value and the flip would do nothing.
  const state = readState();

  // THE IMAGE MUST BE NAMED, OR COMPOSE CANNOT PARSE THE MERGED FILES.
  //
  // `docker-compose.bluegreen.yml` declares the colour slots as
  // `image: ${IMAGE:?set IMAGE…}` with NO default, on purpose. Compose resolves
  // that interpolation for EVERY service in the merged file set — not just the
  // ones the command names — so `docker compose up -d --no-deps caddy` on a host
  // whose environment has no IMAGE fails before it does anything:
  //
  //   error while interpolating services.app-blue.image:
  //   required variable IMAGE is missing a value
  //
  // That is not a corner case. `deploy.yml` exports IMAGE, so the automatic
  // deploy path works; `adopt` did not, and it failed on the production box
  // with the pointer file already written — leaving the recorded upstream and
  // the running Caddy disagreeing, which is a state with no operator-facing way
  // back. An operator running a command BY HAND during an incident is the case
  // this matters most for, and that is exactly the case with no IMAGE in the
  // environment.
  //
  // So the flip resolves the image the colour is actually serving, and refuses
  // rather than guessing when it cannot.
  const image = colourImage(colour) ?? resolveImage();
  if (!image) {
    console.error(
      `\n  cannot flip to app-${colour}: no image to give compose. The colour is not ` +
        `running and neither the deploy state nor the environment names one.`,
    );
    process.exit(1);
  }

  writeState({
    ...state,
    active: colour,
    previous: colour === state.active ? state.previous : state.active,
    upstream: split ?? upstreamFor(colour),
  });

  // caddy is the ONLY public process, so recreating just it moves all traffic.
  // The colours are untouched and keep serving while caddy restarts.
  const r = compose(["up", "-d", "--no-deps", "caddy"], { capture: true, env: { IMAGE: image } });

  // A FAILED FLIP MUST LEAVE THE BOX AS IT WAS.
  //
  // The pointer file was written before the recreate, because compose reads it
  // when it creates the container. If the recreate then fails, the file names
  // an upstream that is NOT serving: the file says `app-blue:3000` while the
  // running Caddy still proxies to `app:3000`. The next `adopt` would then
  // report "already running the blue/green stack" and do nothing, and a later
  // `stage` would compute a traffic split against a colour that is not serving.
  // Restoring the previous pointer and state puts the recording back in
  // agreement with reality, which is the only thing the recording is for.
  if (r.status !== 0) {
    console.error(
      `\n  the traffic flip to app-${colour} FAILED — restoring the previous upstream.`,
    );
    writeState(state);
    process.exit(r.status ?? 1);
  }

  // The edge is back; wait until it actually answers before anyone probes it
  // or believes it.
  await waitForEdge();
}

function stopColour(colour) {
  if (!colour) return;
  // Routed through `compose()` so IMAGE is resolved and injected: the merged
  // files refuse to parse without it, and a rollback that fails on a missing
  // env var is a rollback that does not happen.
  compose(["stop", `app-${colour}`], { allowFail: true });
  compose(["rm", "-f", `app-${colour}`], { allowFail: true });
}

async function deploy(image, canaryPercent) {
  if (!image) {
    console.error("usage: bun scripts/deploy.mjs deploy --image <ref> [--canary N]");
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
  //
  // With `--canary N` only N% of requests move to the new colour and the old
  // one keeps serving the rest. That is the shape an AUTOMATIC release wants:
  // the deploy hands the canary workflow a staged, verified, already-widened
  // release, and the canary workflow decides whether it goes to 100% or rolls
  // back. Without it, the deploy flips everything and the canary has nothing
  // left to canary.
  const pct = canaryPercent === undefined ? 100 : Math.min(100, Math.max(0, canaryPercent));
  if (pct >= 100) {
    console.log(`\n  flipping traffic to app-${target}`);
    await flipTraffic(target, upstreamList(target, null, 0));
    writeState({ active: target, previous: serving, image, upstream: upstreamFor(target) });
  } else {
    const slots = Math.round((pct / 100) * CANARY_SLOTS);
    if (slots === 0) {
      console.error(
        `\n  ${pct}% is below this split's ${100 / CANARY_SLOTS}% granularity — use 0 or a multiple of ${100 / CANARY_SLOTS}.`,
      );
      process.exit(1);
    }
    const split = upstreamList(target, serving ?? target, pct);
    console.log(`\n  canary ${slots}/${CANARY_SLOTS} slots → ${pct}% app-${target}`);
    await flipTraffic(target, split);
    // `active` stays the colour taking the majority: `rollback` and `promote`
    // reason about which colour is the safe one, and below 50% the canary is
    // not.
    writeState({
      ...readState(),
      active: serving ?? target,
      previous: serving ?? target,
      canary: { colour: target, percent: pct },
      image,
      upstream: split,
    });
  }

  // 4. Verify THROUGH the proxy, which is the path a caller actually takes.
  console.log(`  verifying through caddy`);
  const viaProxy = spawnSync(
    "curl",
    [
      "-fsS",
      "-o",
      "/dev/null",
      "--max-time",
      String(PROBE_TIMEOUT_SEC),
      "-w",
      "%{http_code}",
      `${PROBE_ORIGIN}${PROBE_PATH}`,
    ],
    { encoding: "utf8" },
  );
  const status = viaProxy.stdout?.trim();
  if (viaProxy.status !== 0 || status !== "200") {
    console.error(
      `\n  ✗ post-switch probe failed (got "${status ?? "no response"}") — ROLLING BACK.`,
    );
    await rollback();
    process.exit(1);
  }

  console.log(`\n  ✓ live on ${target} (${image})`);
  if (serving) {
    console.log(`\n  app-${serving} is still running and warm.`);
    console.log(`  soak, then: bun scripts/deploy.mjs promote   (stops app-${serving})`);
    console.log(`  or revert:  bun scripts/deploy.mjs rollback`);
  }
}

/**
 * Adopt the blue/green slots — the ONE-TIME migration from the plain stack.
 *
 * The plain stack runs a single `app` container and Caddy proxies to it. The
 * blue/green stack runs two colour slots and Caddy proxies to whichever one
 * `.deploy/active.env` names. This command moves a live deployment from the
 * first to the second, with a rollback if any step fails.
 *
 * ── Why it is a separate, MANUAL command ────────────────────────────────────
 *
 * It changes which container serves production. That is not something an
 * automated deploy should do to itself at 03:00, and it is not something a
 * canary canary-ing: there is no old colour to fall back to, because the old
 * colour IS the plain `app` container. So it is an operator step, run once,
 * with the steps below — and every later deploy is automatic.
 *
 * ── The steps, and why they are in this order ───────────────────────────────
 *
 *  1. Read the RUNNING image of the plain `app` container. The colour must
 *     start on the build that is already serving: adopting on a different
 *     build would be an unannounced release, and the whole point of the
 *     adoption is that it changes nothing about what customers see.
 *  2. Start `app-blue` on that image and prove it healthy — in-container
 *     readiness, not just "the container exists". Neither colour publishes a
 *     host port, so this cannot disturb the live edge.
 *  3. Point `.deploy/active.env` at `app-blue:3000` and recreate ONLY caddy
 *     (`--no-deps`, so compose does not pull the base `app` service back up
 *     behind the colours). Caddy is the only public process; the colours
 *     serve throughout.
 *  4. Verify THROUGH Caddy. A colour that answers on its own port but not
 *     through the proxy is exactly the case that must not receive traffic.
 *  5. Only then stop the plain `app` container — and STOP it, not remove it,
 *     so the rollback is a `start` away.
 *
 * If step 3 or 4 fails, the rollback restores the pointer to `app:3000`,
 * recreates caddy and starts the plain container again.
 */
async function adopt() {
  const mode = stackMode();
  const upstream = runningUpstream();

  // ── Is this an adoption, a finished adoption, or an INTERRUPTED one? ────────
  //
  // "A colour slot exists" is not the same question as "the edge is served by
  // a colour", and the difference matters because an adoption can be
  // interrupted: the pointer file is written, then the Caddy recreate fails,
  // and the box is left with a colour running and an edge still on the plain
  // container. The first version of this command answered only the first
  // question, so it said "already running the blue/green stack — nothing to
  // adopt" and REFUSED to finish an adoption it had started. The operator was
  // left with a recording that disagreed with the box and no command that
  // would make them agree.
  //
  // So the command is resumable: if the edge is already served by a colour,
  // there is nothing to do; if a colour is running but the edge is not on it,
  // the adoption is INCOMPLETE and this command finishes it.
  if (mode === "bluegreen" && upstream.startsWith("app-")) {
    // The edge is ALREADY served by a colour. The only thing that can still be
    // unfinished is the retirement: an adoption that stopped before step 5
    // leaves the plain `app` container running, and a running second copy of
    // production that nothing is using is a thing to turn off, not a thing to
    // leave.
    const colour = upstream.split(":")[0].replace(/^app-/, "");
    const plain = containerId("app");
    if (!plain) {
      console.log(`\n  already adopted — the edge is served by ${upstream}.`);
      console.log("    nothing to do.");
      return;
    }
    console.log(`\n  the edge is served by ${upstream}; retiring the plain \`app\` container.`);
    // The image is resolved BEFORE the stop, and passed explicitly: compose
    // parses the whole merged file set to run any command, and the colour
    // slots declare `image: ${IMAGE:?…}` with no default, so a stop without an
    // image fails to parse and the container is never stopped.
    const image = colourImage(colour) || readState().image;
    compose(["stop", "app"], { allowFail: true, env: image ? { IMAGE: image } : {} });
    writeState({
      ...readState(),
      active: colour,
      previous: null,
      image: image ?? readState().image,
      upstream: upstreamFor(colour),
      adopted: true,
    });
    console.log(`  ✓ adopted. Production is served by app-${colour}.`);
    console.log(
      "    the plain `app` container is stopped, not removed: `docker compose start app` brings it back.",
    );
    return;
  }
  if (mode === "bluegreen") {
    console.log(`\n  an adoption was interrupted: ${upstream || "no upstream"} is serving,`);
    console.log("  and a colour slot is running. Finishing the adoption.");
  }
  if (mode === "unknown") {
    console.error(
      "\n  neither the plain `app` service nor a colour slot is running — refusing to adopt a stack that is not up.",
    );
    process.exit(1);
  }

  const plainId = containerId("app");
  const plainImage = plainId
    ? spawnSync("docker", ["inspect", "--format", "{{.Config.Image}}", plainId], {
        encoding: "utf8",
      }).stdout?.trim()
    : "";
  // The image the colour must serve: the PLAIN container's image when it is
  // still running, and otherwise the colour's own image. An adoption must not
  // change what customers see, so it inherits the build that is already
  // serving rather than naming one of its own.
  const imageRef = plainImage || colourImage("blue");
  if (!imageRef) {
    console.error(
      "\n  could not read the running image of the plain `app` container — refusing to adopt.",
    );
    process.exit(1);
  }

  console.log(`\nadopt blue/green`);
  console.log(`  running image   ${imageRef}`);
  console.log(`  staging colour  blue`);

  // 1-2. Stand the first colour up on the build that is ALREADY serving.
  compose(["up", "-d", "app-blue"], { capture: true, env: { ...process.env, IMAGE: imageRef } });
  const healthy = await waitHealthy("blue");
  if (!healthy) {
    console.error("\n  ✗ app-blue never became healthy — the live stack is untouched.");
    stopColour("blue");
    process.exit(1);
  }
  const probe = probeDirect("blue");
  if (!probe.ok) {
    console.error(`\n  ✗ app-blue is healthy but /api/readyz failed in-container (${probe.code}).`);
    stopColour("blue");
    process.exit(1);
  }

  // 3. Move the pointer. `flipTraffic` writes the state file BEFORE recreating
  // caddy — see the ordering note there.
  //
  // The image is recorded FIRST, so the flip can name it and so a later command
  // can resolve it without an environment. `deploy.yml` exports IMAGE, so the
  // automatic path never needed this; `adopt` runs by hand, on a box where
  // nothing exports it, and the merged compose files refuse to parse without
  // one. That is how the first adoption failed on the production box.
  writeState({ ...readState(), image: imageRef });
  console.log("\n  pointing caddy at app-blue");
  await flipTraffic("blue", upstreamList("blue", null, 0));

  // 4. Verify through the proxy.
  const viaProxy = spawnSync(
    "curl",
    [
      "-fsS",
      "-o",
      "/dev/null",
      "--max-time",
      String(PROBE_TIMEOUT_SEC),
      "-w",
      "%{http_code}",
      `${PROBE_ORIGIN}${PROBE_PATH}`,
    ],
    { encoding: "utf8" },
  );
  const status = viaProxy.stdout?.trim();
  if (viaProxy.status !== 0 || status !== "200") {
    console.error(
      `\n  ✗ the edge did not answer after the flip (got "${status ?? "no response"}") — ROLLING BACK to the plain stack.`,
    );
    revertToPlain();
    process.exit(1);
  }

  // 5. Retire the plain container — stopped, not removed, so the rollback is
  // a `start` away.
  console.log("\n  stopping the plain `app` container");
  compose(["stop", "app"], { allowFail: true });

  writeState({
    ...readState(),
    active: "blue",
    previous: null,
    image: imageRef,
    upstream: upstreamFor("blue"),
    adopted: true,
  });
  console.log(`\n  ✓ adopted. Production is served by app-blue (${imageRef}).`);
  console.log(
    "    the plain `app` container is stopped, not removed: `docker compose start app` brings it back.",
  );
}

/**
 * Undo an adoption: point the edge back at the plain `app` container and
 * start it again.
 *
 * Only used when the adoption itself fails part-way. It is deliberately NOT a
 * general "leave blue/green" command, because leaving blue/green with a
 * stopped plain container is a state with no operator-facing way back.
 */
function revertToPlain() {
  console.error("\n  reverting to the plain stack");
  writeState({ ...readState(), active: null, previous: null, upstream: `app:${APP_PORT}` });
  compose(["up", "-d", "--no-deps", "app"], { allowFail: true });
  compose(["up", "-d", "--no-deps", "caddy"], { allowFail: true });
}

async function rollback() {
  const state = readState();
  if (!state.previous) {
    console.error("\n  no previous colour recorded — nothing to roll back to.");
    process.exit(1);
  }
  // A rollback to the colour that is ALREADY serving is a no-op, and saying so
  // is better than "rolling back" to it: the operator learns that the switch
  // was already where they wanted it.
  if (state.previous === state.active) {
    console.log(`\n  already live on app-${state.active} — nothing to roll back to.`);
    return;
  }
  console.log(`\n  rolling back: app-${state.active} → app-${state.previous}`);
  // Flip first, THEN stop. Stopping before the flip is an outage, not a rollback.
  compose(["up", "-d", "--no-deps", `app-${state.previous}`], { capture: true });
  await flipTraffic(state.previous);
  writeState({ ...state, active: state.previous, previous: state.active });
  console.log(`  ✓ live on ${state.previous}. The failed colour was left running for inspection.`);
}

/**
 * Retire the previous colour: it is now the only build that is not serving, and
 * it is stopped so the next deploy has a clean pair of slots.
 *
 * ── THE INVARIANT THIS COMMAND HAS TO HOLD ──────────────────────────────────
 *
 * `promote` STOPS a container. If the colour it stops is the one currently
 * serving, production goes down — and there is a state in which that is
 * exactly what the recorded values say: after a `rollback`, the state file
 * records `active` and `previous` as the SAME colour, because the rollback
 * moved the active colour back to where the previous one already was. A
 * `promote` that trusted those two fields would then stop the serving
 * container.
 *
 * So the check is not "is there a previous colour" but "is the previous colour
 * DIFFERENT from the active one". When they are the same there is nothing to
 * retire, and the command says so instead of stopping the live container.
 */
async function promote() {
  const state = readState();
  if (!state.active || !state.previous) {
    console.error("\n  nothing to promote — no previous colour recorded.");
    process.exit(1);
  }
  if (state.previous === state.active) {
    console.log(
      `\n  nothing to promote: app-${state.active} is both the active and the previous colour.`,
    );
    console.log(
      "  (this is the state a rollback leaves behind — the retired colour was not re-recorded.)",
    );
    writeState({ ...state, previous: null, upstream: upstreamFor(state.active) });
    return;
  }
  console.log(`\n  promoting: stopping app-${state.previous}`);
  stopColour(state.previous);
  writeState({ ...state, previous: null, upstream: upstreamFor(state.active) });
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
async function canary({ to, percent }) {
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
    await flipTraffic(target, upstreamFor(target));
    console.log(`  ✓ all traffic on app-${target}`);
    return;
  }
  if (pct === 0) {
    console.log(`\n  canary 0% → reverting all traffic to app-${state.active}`);
    await flipTraffic(state.active, upstreamFor(state.active));
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
  await flipTraffic(target, split);
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

/**
 * Prove the release is serving, from both sides.
 *
 * Two questions, and a canary needs both answered:
 *
 *   · does the COLOUR answer on its own port? (in-container `/api/readyz`)
 *   · does the EDGE answer? (the public path a caller actually takes)
 *
 * A gate that only asked the second would pass while the canary upstream was
 * broken — which is exactly the failure a canary exists to catch. A gate that
 * only asked the first would pass while the proxy was pointing at the wrong
 * container.
 *
 * Exit code is the contract: 0 when both answer, 1 otherwise. The Canary
 * workflow branches on it.
 */
function probe({ colour }) {
  const problems = [];

  if (colour) {
    const direct = probeDirect(colour);
    if (!direct.ok) {
      problems.push(`app-${colour} did not answer /api/readyz in-container (${direct.code})`);
    } else {
      console.log(`  app-${colour}      readyz ${direct.code}`);
    }
  }

  const edge = spawnSync(
    "curl",
    [
      "-fsS",
      "-o",
      "/dev/null",
      "--max-time",
      String(PROBE_TIMEOUT_SEC),
      "-w",
      "%{http_code}",
      `${PROBE_ORIGIN}${PROBE_PATH}`,
    ],
    { encoding: "utf8" },
  );
  const status = edge.stdout?.trim();
  if (edge.status !== 0 || status !== "200") {
    problems.push(`the edge answered "${status ?? "nothing"}" for /api/readyz`);
  } else {
    console.log(`  via caddy  readyz ${status}`);
  }

  if (problems.length) {
    console.error(`\n  ✗ ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log("  ✓ ready");
}

async function status() {
  const state = readState();
  console.log("\nblue/green status");
  console.log(`  stack      ${stackMode()}`);
  console.log(`  active     ${state.active ?? "(unknown)"}`);
  console.log(`  previous   ${state.previous ?? "(none)"}`);
  console.log(`  image      ${state.image ?? "(unknown)"}`);
  if (state.canary) {
    console.log(`  canary     ${state.canary.percent}% → app-${state.canary.colour}`);
  }
  for (const c of COLOURS) {
    const id = containerId(`app-${c}`);
    if (!id) {
      console.log(`  app-${c.padEnd(6)} (not running)`);
      continue;
    }
    const r = spawnSync(
      "docker",
      [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
        id,
      ],
      { encoding: "utf8" },
    );
    if (r.stdout) console.log(`  app-${c.padEnd(6)} ${r.stdout.trim()}`);
  }
  const plain = containerId("app");
  console.log(`  app        ${plain ? "running (plain stack)" : "(not running)"}`);
  const curl = spawnSync(
    "curl",
    [
      "-fsS",
      "-o",
      "/dev/null",
      "--max-time",
      String(PROBE_TIMEOUT_SEC),
      "-w",
      "%{http_code}",
      `${PROBE_ORIGIN}${HEALTH_PATH}`,
    ],
    {
      encoding: "utf8",
    },
  );
  console.log(`  via caddy  ${curl.stdout?.trim() ?? "unreachable"}`);
}

/**
 * The FULL release pipeline, run as one command.
 *
 *   bun scripts/deploy.mjs auto --image ghcr.io/org/repo:v0.4.0
 *     [--start-percent 5] [--mid-percent 50] [--soak-seconds 300] [--probe-interval 30]
 *
 * stage → canary start% → soak → mid% → soak → 100% → promote, and at ANY
 * point a failed probe reverts the traffic and exits non-zero. This is what
 * the canary workflow calls, so the pipeline that runs when a human is at the
 * keyboard and the pipeline that runs at 03:00 are THE SAME pipeline — a
 * rollback path that only exists in CI is a rollback path nobody has ever
 * tested.
 *
 * ── The preflight, and why it refuses rather than adapts ─────────────────────
 *
 * The first thing `auto` does is ask `stackMode()`. If production is on the
 * plain stack, auto REFUSES: a canary against a plain stack would leave a
 * second project's containers fighting over ports 80/443, and "just adopt"
 * is not a 03:00 decision — `adopt` is a deliberate, manual, one-time step
 * with its own rollback. Refusing here costs a deploy; guessing costs the
 * site. Run `bun scripts/deploy.mjs adopt` once by hand, then auto works.
 *
 * The same refusal fires when the state file still carries an unfinished
 * canary (`state.canary` set): an automatic pipeline that "resumes" a split
 * it did not start widens traffic on a build it never staged. The operator
 * resolves the outstanding canary first (`canary --percent 0` to abandon,
 * `--percent 100` to accept).
 *
 * ── What the soak actually watches ────────────────────────────────────────────
 *
 * Every probe interval it asks BOTH questions of BOTH surfaces:
 *
 *   · does the EDGE answer /api/readyz? (via caddy — the caller's path)
 *   · does the CANARY colour answer /api/readyz? (in-container, its own port)
 *
 * The edge probe catches a proxy/traffic problem; the colour probe catches a
 * colour that is still \"up\" internally but wrong. Either failing reverts
 * immediately — a soak that only sampled the edge would keep 50% of real
 * customers pointed at a colour this script has already proven is not ready.
 *
 * Budget: total soak time is start-soak + mid-soak, each `--soak-seconds`.
 * Sentry/exit-rate gating lives ABOVE this (the workflow), because this
 * script cannot see application errors — only transport-level readiness.
 */
async function auto(image, opts) {
  const startPct = opts.startPercent ?? tunable("canaryStartPercent");
  const midPct = opts.midPercent ?? tunable("canaryMidPercent");
  const soakSeconds = opts.soakSeconds ?? tunable("canarySoakSeconds");
  const probeInterval = opts.probeInterval ?? tunable("canaryProbeIntervalSeconds");

  // The image defaults to the one the deploy workflow ALREADY STAGED.
  //
  // The pipeline is two stages on purpose: the deploy workflow builds,
  // migrates and stages the new colour without moving traffic, and this
  // command widens the split and promotes. Naming the image again on the
  // second command is one more place for the two halves to disagree about
  // which build is being released — and a canary that widens onto a
  // DIFFERENT image than the one that was staged is a canary of nothing.
  const releaseImage = image ?? readState().image ?? undefined;
  if (!releaseImage) {
    console.error(
      "\n  ✗ auto: no image to release. Pass --image, or stage one first " +
        "('bun scripts/deploy.mjs stage --image <ref>').",
    );
    process.exit(1);
  }

  const mode = stackMode();
  if (mode !== "bluegreen") {
    console.error(
      `\n  ✗ auto requires the blue/green stack; stack mode is "${mode}".` +
        `\n    Run 'bun scripts/deploy.mjs adopt' ONCE by hand, deliberately, then re-run auto.` +
        `\n    (see scripts/deploy.mjs 'adopt' — it is manual on purpose)`,
    );
    process.exit(1);
  }
  const state0 = readState();
  if (state0.canary) {
    console.error(
      `\n  ✗ an unfinished canary is outstanding (${state0.canary.percent}% → app-${state0.canary.colour}).` +
        `\n    Resolve it first: 'canary --percent 0' to abandon, or '--percent 100' to accept.`,
    );
    process.exit(1);
  }
  // NO `--image` GUARD HERE, and that is deliberate.
  //
  // The image defaults to the one the deploy workflow already staged — the
  // `releaseImage` resolution above is the contract, and the canary workflow
  // relies on it: it calls `auto` with the percentages and the soak and NOT
  // with an image, because naming the image again on the second command is one
  // more place for the two halves of the release to disagree about which build
  // is being released.
  //
  // A usage guard here would therefore refuse the ONE invocation the
  // automatic path makes, and the automatic path is the whole point of the
  // command. `releaseImage` has already refused the genuinely image-less case
  // ("auto: no image to release"), and it refuses it with an instruction
  // rather than a usage string.

  /** Abort with the traffic reverted, so a failed auto leaves the site serving. */
  const abort = async (step, detail) => {
    console.error(`\n  ✗ auto: ${step} failed${detail ? ` — ${detail}` : ""} — ROLLING BACK.`);
    const state = readState();
    if (state.active && state.previous && state.active !== state.previous) {
      // A full switch in flight (or any state with a distinct warm previous):
      // the previous colour is still running, so the rollback is a flip, not a
      // rebuild. The failed colour is left RUNNING — stopping it is the
      // postmortem's decision, not the abort's urgency.
      await rollback();
    } else if (state.canary) {
      // Split-stage failure: `active` is the majority colour the canary state
      // never displaced; canary(0) reverts all traffic to it.
      await canary({ percent: 0, to: state.canary.colour });
    }
    process.exit(1);
  };

  /** Edge + colour probes, repeated until the soak budget is exhausted. */
  const soak = async (label, colour, seconds) => {
    console.log(
      `\n  soak (${label}): probing edge + app-${colour} every ${probeInterval}s for ${seconds}s`,
    );
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, probeInterval * 1000));
      const edge = spawnSync(
        "curl",
        [
          "-fsS",
          "-o",
          "/dev/null",
          "--max-time",
          String(PROBE_TIMEOUT_SEC),
          "-w",
          "%{http_code}",
          `${PROBE_ORIGIN}${PROBE_PATH}`,
        ],
        { encoding: "utf8" },
      );
      const edgeCode = edge.stdout?.trim();
      if (edge.status !== 0 || edgeCode !== "200") {
        await abort(`${label} soak`, `edge answered "${edgeCode ?? "nothing"}"`);
      }
      const direct = probeDirect(colour);
      if (!direct.ok) {
        await abort(`${label} soak`, `app-${colour} readyz ${direct.code}`);
      }
      process.stdout.write(`.`);
    }
    console.log(` ok`);
  };

  console.log(`\nauto blue/green + canary release`);
  console.log(`  image ${releaseImage}`);

  // canary()/rollback() call process.exit on failure, so the .catch only shields
  // the stage path (the only one that returns rather than exits).
  await stage(releaseImage)
    .catch(async (err) => abort("stage", err?.message))
    .then(() => canary({ percent: startPct }));
  const canaryColour = () => readState().canary?.colour ?? opposite(readState().active);
  await soak("canary", canaryColour(), soakSeconds);
  await canary({ percent: midPct });
  await soak("mid", canaryColour(), soakSeconds);
  await canary({ percent: 100 });

  // The full switch IS the acceptance. Verify the edge once more, then retire
  // the old colour — but only if it is genuinely not the active one (promote's
  // own invariant does that check us no favours: after the 100% switch the
  // state records active=new, previous=old, so a straight promote is correct).
  const edge = spawnSync(
    "curl",
    [
      "-fsS",
      "-o",
      "/dev/null",
      "--max-time",
      String(PROBE_TIMEOUT_SEC),
      "-w",
      "%{http_code}",
      `${PROBE_ORIGIN}${PROBE_PATH}`,
    ],
    { encoding: "utf8" },
  );
  const code = edge.stdout?.trim();
  if (edge.status !== 0 || code !== "200") {
    await abort("post-switch verification", `edge answered "${code ?? "nothing"}"`);
  }
  await promote();
  writeState({ ...readState(), canary: undefined });
  console.log(`\n  ✓ auto release complete: app-${readState().active} is serving ${releaseImage}`);
}

function argValue(rest, flag) {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "deploy": {
    const i = rest.indexOf("--image");
    const c = rest.indexOf("--canary");
    await deploy(i >= 0 ? rest[i + 1] : undefined, c >= 0 ? Number(rest[c + 1]) : undefined);
    break;
  }
  case "rollback":
    await rollback();
    break;
  case "promote":
    await promote();
    break;
  case "canary": {
    const p = rest.indexOf("--percent");
    const t = rest.indexOf("--to");
    await canary({
      percent: p >= 0 ? Number(rest[p + 1]) : undefined,
      to: t >= 0 ? rest[t + 1] : undefined,
    });
    break;
  }
  case "status":
    await status();
    break;
  case "mode":
    // One machine-readable word on stdout, so CI can branch on it without
    // parsing prose. `unknown` is a real answer, not an error: it means the
    // stack is down, and a workflow must not treat that as "plain".
    console.log(stackMode());
    break;
  case "staged-colour": {
    // The colour a release is being canaried on.
    //
    // Read from the deploy state, and printed as ONE word, because the deploy
    // workflow and the canary workflow must agree about which container is the
    // new build. A disagreement there would canary the OLD colour and report
    // success — which is the failure mode a canary must not have.
    const state = readState();
    const colour = state.canary?.colour ?? state.staged ?? "";
    console.log(colour);
    break;
  }
  case "probe": {
    const c = rest.indexOf("--colour");
    probe({ colour: c >= 0 ? rest[c + 1] : undefined });
    break;
  }
  case "adopt":
    await adopt();
    break;
  case "stage": {
    const i = rest.indexOf("--image");
    await stage(i >= 0 ? rest[i + 1] : undefined);
    break;
  }
  case "auto": {
    await auto(argValue(rest, "--image") ?? process.env.IMAGE, {
      startPercent:
        argValue(rest, "--start-percent") !== undefined
          ? Number(argValue(rest, "--start-percent"))
          : undefined,
      midPercent:
        argValue(rest, "--mid-percent") !== undefined
          ? Number(argValue(rest, "--mid-percent"))
          : undefined,
      soakSeconds:
        argValue(rest, "--soak-seconds") !== undefined
          ? Number(argValue(rest, "--soak-seconds"))
          : undefined,
      probeInterval:
        argValue(rest, "--probe-interval") !== undefined
          ? Number(argValue(rest, "--probe-interval"))
          : undefined,
    });
    break;
  }
  default:
    console.error(
      "usage: bun scripts/deploy.mjs <deploy --image REF [--canary N] | auto [--image REF] [--start-percent N --mid-percent N --soak-seconds N] | stage --image REF | rollback | promote | canary --percent N [--to COLOUR] | probe [--colour COLOUR] | adopt | mode | staged-colour | status>",
    );
    process.exit(1);
}
