#!/usr/bin/env bun
/**
 * Drift gates.
 *
 * ── What "drift" means here, concretely ────────────────────────────────────
 * Every silent failure this repo has shipped was a definition and a reality
 * disagreeing while nothing compared them:
 *
 *   • `overage-worker` is in docker-compose.yml and has NEVER had a container,
 *     because deploy.yml rolls an explicit service list it was never added to.
 *     Measured on the VPS 2026-10-12: `docker ps -a --filter name=overage` is
 *     empty. Nobody noticed for as long as the service has existed.
 *   • compose pinned `image: ${IMAGE:-securevoice-ai-app:local}` — one tag for
 *     whatever built it — so a smoke build retagged production's image and one
 *     `up -d` would have rolled production backward (docs/VPS-RECOVERY.md #3).
 *   • the secrets-based release.yml was reverted twice by the release branch
 *     resync into main. Both times the revert was silent.
 *   • tests-jest/ThemeMode.test.tsx imported a deleted component and the whole
 *     jest suite exited 1 for a release.
 *   • `next-themes` was a dependency with no importer anywhere in src/.
 *
 * A gate is a comparison that fails loudly. Each check below names the drift it
 * catches, because a check whose motivation is not recorded gets "fixed" by
 * deleting it.
 *
 * Usage:
 *   bun scripts/drift-gates.mjs repo    # runs in any checkout — CI
 *   bun scripts/drift-gates.mjs box     # runs on the VPS, needs docker — deploy
 *   bun scripts/drift-gates.mjs all
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import YAML from "yaml";

const ROOT = resolve(import.meta.dir, "..");
const failures = [];
const notes = [];

function fail(msg) {
  failures.push(msg);
}
function info(msg) {
  notes.push(msg);
}

function read(p) {
  return readFileSync(join(ROOT, p), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 1 — every compose service is accounted for, by name, with a reason
//
// This is the overage-worker gate. deploy.yml rolls an explicit service list;
// compose keeps gaining services; nothing compared them, so an omitted service
// was not an error — it was an absence. Measured on the VPS 2026-10-12:
// `docker ps -a --filter name=overage` is empty. overage-worker has never had a
// container, for as long as it has existed in the file.
//
// The repo gate cannot see the box, so it forces the DECISION: each service is
// either rolled per deploy, a one-shot, or infrastructure that a human has
// declared "created once, not recreated, and verified running by the box gate".
// The BOX gate is what verifies that claim — the two close the loop, and neither
// is sufficient alone.
// ─────────────────────────────────────────────────────────────────────────────
function checkServiceInventory() {
  const compose = YAML.parse(read("docker-compose.yml"));
  const defined = Object.keys(compose.services ?? {});
  if (defined.length === 0) fail("docker-compose.yml parsed with no services");

  const deploy = read(".github/workflows/deploy.yml");
  const m = deploy.match(/docker compose up -d ([^\n]+)/);
  if (!m) {
    fail("deploy.yml: could not find a `docker compose up -d <services>` line");
    return;
  }
  const rolled = new Set(m[1].trim().split(/\s+/).filter(Boolean));

  // Runs and exits 0 by design — migrate + seed. No long-lived container exists,
  // and one must not.
  const ONESHOT = {
    "db-setup": "runs migrate deploy + optional seed, exits 0 by design",
  };

  // Created once by an initial `up`, deliberately NOT recreated on every deploy
  // (recreating Redis or Postgres per deploy would be a disaster), and asserted
  // RUNNING by the box gate below. An entry here is a claim that must stay true.
  const INFRA = {
    db: "stateful; created once, never recreated by a deploy",
    redis: "stateful; created once, never recreated by a deploy",
    litellm: "stateful-ish LLM proxy with a long-lived upstream",
    realtime: "socket server; long-lived, deployed separately",
    caddy: "the TLS edge; recreated only when its definition changes",
    // `outbox-worker` used to live here as "drains a durable outbox; restart-safe,
    // rolled rarely". That classification was the bug: nothing rolled it, so it ran
    // the first image ever built for it, and no gate could see the staleness because
    // the conformance check only inspected the app container. It is now in deploy.yml's
    // roll list; the repo gate above will fail if it is ever quietly demoted again by
    // re-adding it here without removing it there.
    "app-direct": "a debugging bypass of the proxy; not part of the roll",
  };

  // Profile-gated services are opt-in by definition: `up -d` does not start
  // them unless the profile is named. app-direct is the debugging bypass of the
  // proxy (`profiles: ["direct"]`) and must NOT run in production.
  const PROFILED = new Set(
    defined.filter(
      (s) => Array.isArray(compose.services[s]?.profiles) && compose.services[s].profiles.length,
    ),
  );

  const unaccounted = defined.filter(
    (s) => !rolled.has(s) && !ONESHOT[s] && !INFRA[s] && !PROFILED.has(s),
  );
  if (unaccounted.length) {
    fail(
      `compose services with no declared role: ${unaccounted.join(", ")}\n` +
        `       a service is either in deploy.yml's \`up -d\` list (rolled every deploy),\n` +
        `       in ONESHOT (exits 0 by design), in INFRA (created once, never\n` +
        `       recreated, and verified running by the box gate), or behind a compose\n` +
        `       profile (opt-in by design). An undeclared service is exactly how\n` +
        `       overage-worker never got a container.`,
    );
  }

  for (const s of Object.keys(INFRA)) {
    if (!defined.includes(s))
      fail(`INFRA allowlist names a service compose no longer defines: ${s}`);
  }
  const stale = Object.keys(ONESHOT).filter((s) => !defined.includes(s));
  if (stale.length) fail(`ONESHOT allowlist names gone services: ${stale.join(", ")}`);

  // The claim in INFRA is only as good as the box gate, so say so where it lives.
  if (!read(".github/workflows/deploy.yml").includes("drift-gates")) {
    fail("deploy.yml does not run scripts/drift-gates.mjs — the INFRA claims above are unverified");
  }

  info(
    `service inventory: ${defined.length} defined = ${rolled.size} rolled + ` +
      `${Object.keys(INFRA).length} infra + ${Object.keys(ONESHOT).length} one-shot + ` +
      `${PROFILED.size} profile-gated`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 2 — the image tag the stack runs is unambiguous
//
// `image: ${IMAGE:-securevoice-ai-app:local}` is one tag shared by whatever
// builds it. CI and release now pin their own (the isolation fix), so this
// check asserts that ISOLATION IS STILL THERE rather than trusting it. If a
// future edit drops the IMAGE line from a throwaway .env, this fails.
// ─────────────────────────────────────────────────────────────────────────────
function checkImageIsolation() {
  const compose = read("docker-compose.yml");
  const app = YAML.parse(compose).services?.app ?? {};
  const pinned = String(app.image ?? "");
  if (!pinned.includes("${IMAGE")) {
    fail(`compose app.image must be parameterised (\${IMAGE:-...}), found: ${pinned}`);
  }

  for (const wf of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    const body = read(wf);
    const writesEnv = body.includes("cat > .env <<") || body.includes("env-file");
    const pinsImage = body.includes("IMAGE=${{ env.PROJECT }}-app:latest");
    if (writesEnv && !pinsImage) {
      fail(
        `${wf} writes a throwaway .env but does NOT pin IMAGE=<project>-app:latest.\n` +
          `       that .env's compose would resolve app.image to the shared tag and` +
          ` retag production's image. See docs/VPS-RECOVERY.md failure mode #3.`,
      );
    }
  }
  info("app.image is parameterised and both smoke jobs pin their own tag");
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 3 — invariants a branch resync keeps reverting
//
// The v0.2.5 release-branch resync into main took ITS side of release.yml and
// silently reverted the secrets switch, then the same thing happened again.
// This asserts the invariant on whatever branch CI is testing, so the revert
// becomes a red build instead of a surprise two releases later.
// ─────────────────────────────────────────────────────────────────────────────
function checkSecretsProvenance() {
  const rel = read(".github/workflows/release.yml");
  for (const key of ["NEXT_PUBLIC_DEMO_LOGIN_EMAIL", "NEXT_PUBLIC_DEMO_LOGIN_PASSWORD"]) {
    const asVar = new RegExp(`${key}=\\\$\\{\\{\\s*vars\\.`).test(rel);
    const asSecret = new RegExp(`${key}=\\\$\\{\\{\\s*secrets\\.`).test(rel);
    if (asVar) {
      fail(
        `${key} is read from \`vars.\` in release.yml — that is plaintext-readable` +
          ` by anyone with settings access to this repo. It must read from \`secrets.\`.` +
          ` This exact line has been reverted by a release-branch resync twice;` +
          ` re-apply it rather than trusting the ladder.`,
      );
    } else if (!asSecret) {
      fail(`${key} is not passed as a release build-arg at all.`);
    }
  }
  info("release.yml reads the demo login from secrets");
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 4 — test suites import things that exist
//
// ThemeMode.test.tsx imported the deleted ThemeToggle and took the whole jest
// suite down with it. A static import check is cheap and runs before the suite.
// ─────────────────────────────────────────────────────────────────────────────
function checkTestImports() {
  const dirs = ["tests-jest", "tests"];
  let checked = 0;
  for (const d of dirs) {
    const abs = join(ROOT, d);
    if (!existsSync(abs)) continue;
    const walk = (p) => {
      for (const e of readdirSync(p)) {
        const full = join(p, e);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|mjs)$/.test(e)) continue;
        const src = readFileSync(full, "utf8");
        checked++;
        const re = /from\s+"(@\/[^"]+)"/g;
        let m;
        while ((m = re.exec(src))) {
          const spec = m[1].slice(2); // strip @/
          // `src/generated` is gitignored and produced by `prisma generate`, so
          // it is absent in a fresh checkout — a gate that requires it would fail
          // on a clean clone and pass only where someone had already installed.
          // It is also the wrong target: this check exists to find imports of
          // modules a human DELETED (the ThemeToggle case), not to verify
          // generated output, which is `bun install`'s job.
          if (spec.startsWith("generated/")) continue;
          const cands = [
            join(ROOT, "src", spec),
            join(ROOT, "src", `${spec}.ts`),
            join(ROOT, "src", `${spec}.tsx`),
            join(ROOT, "src", spec, "index.ts"),
            join(ROOT, "src", spec, "index.tsx"),
          ];
          if (!cands.some((c) => existsSync(c))) {
            fail(`${full.slice(ROOT.length + 1)} imports "${m[1]}" which does not resolve`);
          }
        }
      }
    };
    walk(abs);
  }
  info(`verified ${checked} test files resolve their @/ imports`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 5 — no dependency without an importer
//
// `next-themes` stayed in package.json with nothing importing it, advertising a
// theming capability the product had already removed. Only the deps actually
// imported from src/, scripts/ and mini-services/ earn their place in
// `dependencies`.
// ─────────────────────────────────────────────────────────────────────────────
function checkUnusedDependencies() {
  const pkg = JSON.parse(read("package.json"));
  const deps = Object.keys(pkg.dependencies ?? {});
  if (!deps.length) return;

  // ROOT CONFIG FILES COUNT AS IMPORTERS. The first version of this check
  // scanned src/, scripts/, mini-services/, tests/ and tests-jest/ only, and
  // declared `tailwindcss-animate` unused on that basis — it is imported by
  // `tailwind.config.ts` as a plugin, and CI's typecheck failed with TS2307
  // "Cannot find module 'tailwindcss-animate'". A config file cannot be
  // grepped by the rules a source file can; it is still an importer.
  const roots = [
    "src",
    "scripts",
    "mini-services",
    "tests",
    "tests-jest",
    // Config files that name packages by import or by plugin.
    "tailwind.config.ts",
    "next.config.ts",
    "vitest.config.ts",
    "jest.config.ts",
    "postcss.config.mjs",
    "bunfig.toml",
    "playwright.config.ts",
  ].map((d) => join(ROOT, d));

  const haystack = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    if (statSync(r).isFile()) {
      haystack.push(readFileSync(r, "utf8"));
      continue;
    }
    const walk = (p) => {
      for (const e of readdirSync(p)) {
        const full = join(p, e);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (/\.(ts|tsx|mjs|js)$/.test(e)) haystack.push(readFileSync(full, "utf8"));
      }
    };
    walk(r);
  }
  const blob = haystack.join("\n");

  // Binaries, runtime config and generator targets referenced by name rather
  // than imported by a bare specifier.
  //
  // `@prisma/client` is the one to be careful about: nothing imports that
  // specifier. The generator is configured to emit into `src/generated/prisma`,
  // and every file in the repo imports the ALIAS (`@/generated/prisma/client`)
  // instead — which is the whole point, since a direct import would break when
  // the output path changes. Treating it as unused here would have been a false
  // positive that read as advice to delete the ORM.
  const BY_NAME = new Set([
    "prisma",
    "@prisma/client",
    "dotenv",
    "typescript",
    "prettier",
    "eslint",
    "jest",
    "bun-types",
  ]);
  const unused = deps.filter(
    (d) =>
      !BY_NAME.has(d) &&
      !new RegExp(`["'\`]${d.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}(/|["'\`])`).test(blob),
  );
  if (unused.length) {
    fail(
      `dependencies with no importer in src/scripts/mini-services/tests: ${unused.join(", ")}\n` +
        `       either something imports them under a path this scan misses (add it to BY_NAME),` +
        ` or they are dead weight like next-themes was.`,
    );
  }
  info(`checked ${deps.length} dependencies for importers`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 6 — no double-encoded text anywhere in the repo
//
// `—` whose UTF-8 bytes were decoded as CP1252 renders as three characters
// instead of one (spelled by code point below, so this file cannot be its own
// offender) and ships looking like a typo the author made. Measured 2026-10-12:
// 55 runs in src/views/Auth.tsx — visible in the sign-in screen's own copy — and
// 61 in docker-compose.yml's header comments, including a run that had been
// encoded twice. A viewer never sees the intent, only the damage, and nothing
// checks for it because every file still parses.
//
// This is the one check a human cannot review away: the pattern is unambiguous
// by code point, so the gate states it rather than describing it.
// ─────────────────────────────────────────────────────────────────────────────
function checkMojibake() {
  const files = execSync("git ls-files", { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter((f) => /\.(tsx?|mjs|js|md|json|css|ya?ml|prisma)$/.test(f));

  const offenders = [];
  for (const f of files) {
    let s;
    try {
      s = readFileSync(join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    // `â` + `€` + one continuation byte: the CP1252 rendering of a 3-byte UTF-8
    // sequence. Stated by code point so this file's own encoding cannot mangle it.
    const runs = s.match(/\u00e2\u20ac[\s\S]/g);
    if (runs) offenders.push(`${f} (${runs.length})`);
  }
  if (offenders.length) {
    fail(
      `double-encoded UTF-8 renders as garbage: ${offenders.join(", ")}\n` +
        `       repair with Buffer.from(run, "latin1").toString("utf8") per run —` +
        ` never blanket-decode a whole file, it eats the Arabic and the accents.`,
    );
  } else {
    info(`no double-encoded text in ${files.length} tracked files`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BOX-SIDE gates — these run on the VPS where docker and the live stack are.
// ─────────────────────────────────────────────────────────────────────────────
// The deploy step runs in the runner's workspace, but the stack lives in the box
// checkout. Compose resolves its `.env` from the project directory, so asking it
// from anywhere else does not return a stale answer — it fails outright. Measured
// 2026-10-13 on the box: from the workspace, `docker compose ps` exits 1 with
// "required variable BETTER_AUTH_SECRET is missing a value" and
// "required variable POSTGRES_PASSWORD is missing a value", while from
// ~/securevoice-ai the same command lists all twelve running services. The old
// `2>/dev/null || true` collapsed those into an empty list, so the gate declared
// every service never-created on a healthy production stack.
const BOX = process.env.BOX_DIR || process.cwd();

function sh(cmd, cwd = BOX) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd }).trim();
}

/**
 * Query the box's compose project. A compose that cannot be asked is reported as
 * compose failing, never as "nothing is running" — the two look identical as an
 * empty string, and only one of them is an outage.
 */
function composeQuery(args) {
  try {
    return { out: sh(`docker compose --project-directory "${BOX}" ${args}`) };
  } catch (e) {
    const where = e.stderr?.toString?.() || e.message || String(e);
    const lines = where
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return { error: lines.slice(-2).join(" / ") || "docker compose failed with no message" };
  }
}

function checkBoxInventory() {
  const declared = YAML.parse(read("docker-compose.yml"));
  const defined = Object.keys(declared.services ?? {});

  const runningQ = composeQuery("ps --services --filter status=running");
  if (runningQ.error) {
    fail(
      `compose could not be queried for running services (project directory ${BOX}):\n` +
        `       ${runningQ.error}\n` +
        `       this is NOT evidence anything is down — it means the gate could not ask.` +
        ` Set BOX_DIR to the checkout that owns the stack's .env.`,
    );
    return;
  }
  const running = new Set(runningQ.out.split("\n").filter(Boolean));
  const allQ = composeQuery("ps -a --services");
  const all = new Set(allQ.out ? allQ.out.split("\n").filter(Boolean) : []);

  const ONESHOT = new Set(["db-setup"]);
  // Profile-gated: opt-in by design, so a plain `up -d` correctly leaves them out.
  const PROFILED = new Set(
    defined.filter(
      (s) => Array.isArray(declared.services[s]?.profiles) && declared.services[s].profiles.length,
    ),
  );

  const missing = defined.filter((s) => !ONESHOT.has(s) && !PROFILED.has(s) && !running.has(s));
  if (missing.length) {
    fail(
      `compose services with NO running container: ${missing.join(", ")}\n` +
        `       never-created vs exited matters, so both are listed:` +
        ` created-but-not-running: ${[...all].filter((s) => !running.has(s)).join(", ") || "(none)"}\n` +
        `       a service that compose defines but nothing rolled is silently absent —` +
        ` that is how overage-worker ran no overage billing at all.`,
    );
  } else {
    info(
      `all ${defined.length - ONESHOT.size - PROFILED.size} deployable compose services are running`,
    );
  }
}

function checkBoxCurrency() {
  let head = "";
  try {
    head = sh("git rev-parse HEAD");
  } catch {
    fail(`cannot read the box's git HEAD in ${BOX}`);
    return;
  }
  const remote = sh("git ls-remote origin refs/heads/main").split(/\s+/)[0] ?? "";
  if (!remote) {
    info("no origin/main reachable from the box — skipping currency comparison");
    return;
  }
  if (head !== remote) {
    fail(
      `the box is at ${head.slice(0, 7)} but origin/main is ${remote.slice(0, 7)}\n` +
        `       production is serving a commit that is not main's tip.`,
    );
  } else {
    info(`box HEAD == origin/main (${head.slice(0, 7)})`);
  }
}

function checkBoxImageConformance() {
  // The running container for EVERY service the deploy claims to roll must use an
  // image some tag still points at. This used to inspect `securevoice-ai-app-1`
  // alone — which is how `outbox-worker` could run a months-old build indefinitely:
  // the gate was named for image conformance and was looking at one container.
  //
  // A dangling image id means the tag has moved on (or never existed) while the
  // container stayed put: the next `up -d` resolves that service's image to whatever
  // the tag says now, which may be a different build from the one serving traffic.
  const deploy = read(".github/workflows/deploy.yml");
  const m = deploy.match(/docker compose up -d ([^\n]+)/);
  if (!m) {
    fail("deploy.yml: no `docker compose up -d <services>` line to verify against");
    return;
  }
  const rolled = m[1].trim().split(/\s+/).filter(Boolean);
  if (rolled.length < 2) {
    fail(
      `deploy.yml roll list resolved to ${rolled.length} service(s); refusing to certify a roll of one container`,
    );
    return;
  }

  const tagged = new Set(
    sh("docker images --format '{{.ID}}'")
      .split("\n")
      .map((s) => s.replace("sha256:", "").slice(0, 12))
      .filter(Boolean),
  );

  const problems = [];
  const checked = [];
  for (const svc of rolled) {
    let cid = "";
    try {
      cid = sh(`docker compose --project-directory "${BOX}" ps -q ${svc}`);
    } catch (e) {
      const where = e.stderr?.toString?.() || e.message || String(e);
      problems.push(
        `${svc}: compose could not be asked for its container — ${where.split("\n").filter(Boolean).slice(-1)[0] ?? where}`,
      );
      continue;
    }
    if (!cid) {
      // checkBoxInventory already fails on a missing running container; this is the
      // same fact seen from the image side, so record rather than double-fail.
      problems.push(`${svc}: compose reports no container id`);
      continue;
    }
    const image = sh(`docker inspect ${cid} --format '{{.Image}}'`)
      .replace("sha256:", "")
      .slice(0, 12);
    if (!image) {
      problems.push(`${svc}: container ${cid.slice(0, 12)} has no image id`);
      continue;
    }
    if (!tagged.has(image)) {
      problems.push(
        `${svc}: running image ${image} is tagged by nothing — the tag has moved and this container has not`,
      );
      continue;
    }
    checked.push(`${svc}@${image}`);
  }

  if (problems.length) {
    fail(
      `deployed containers are not conforming to the images the deploy rolled:\n` +
        `       ${problems.join("\n       ")}\n` +
        `       a service can be recreated or forgotten individually, so every rolled\n` +
        `       service is inspected — checking only the app container let a worker go stale unseen.` +
        ` The next \`up -d\` resolves a stale service's image to whatever the tag says now,\n` +
        `       which may be a build that has never served traffic.`,
    );
  } else {
    info(`all ${checked.length} rolled containers run a tagged image: ${checked.join(", ")}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
const SUITES = {
  repo: [
    checkServiceInventory,
    checkImageIsolation,
    checkSecretsProvenance,
    checkTestImports,
    checkUnusedDependencies,
    checkMojibake,
  ],
  box: [checkBoxInventory, checkBoxCurrency, checkBoxImageConformance],
};

const which = (process.argv[2] ?? "repo").toLowerCase();
const suites = which === "all" ? ["repo", "box"] : [which];

for (const s of suites) {
  if (!SUITES[s]) {
    console.error(`unknown suite "${s}" — use repo, box, or all`);
    process.exit(2);
  }
  console.log(`\n── drift gates: ${s} ──`);
  for (const fn of SUITES[s]) {
    try {
      fn();
    } catch (e) {
      fail(`${fn.name} threw: ${String(e).slice(0, 200)}`);
    }
  }
}

for (const n of notes) console.log(`  ok   ${n}`);
for (const f of failures) console.log(`  FAIL ${f}`);

console.log(`\n${failures.length ? `DRIFT DETECTED (${failures.length})` : "no drift detected"}`);
process.exit(failures.length ? 1 : 0);
