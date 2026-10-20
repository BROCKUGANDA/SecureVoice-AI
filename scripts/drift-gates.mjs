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
// ─────────────────────────────────────────────────────────────────────────────
// CHECK 1b — the services deploy.yml ROLLS are the services it BUILDS
//
// deploy.yml declares `ROLLED=(…)` once and expands it in both
// `docker compose build "${ROLLED[@]}"` and `docker compose up -d app
// "${ROLLED[@]}"`. Parsing that one declaration — rather than either command
// line — is the point: the file used to carry two literal lists, they had
// drifted apart, and each line looked authoritative on its own.
//
// Measured 2026-10-17, on a deploy that passed every gate and reported success:
// `up -d` named overage-worker and outbox-worker, `build` named neither, so
// compose reused whatever image each tag last pointed at. The TLS-anchor fix
// sits in the Dockerfile's `worker` stage — the stage both build from — and
// never reached them: overage-worker was still failing
// `paddleSubscription.findMany()` with ENOENT on supabase-ca.crt.
//
// Pure over the workflow text, so the self-test below can hand it a fabricated
// file. A gate that only ever sees the real deploy.yml cannot be shown to fail.
// ─────────────────────────────────────────────────────────────────────────────
const ROLLED_DECL = /^[ \t]*ROLLED=\(([^)]*)\)[ \t]*$/m;
const UP_LINE = /^[ \t]*docker compose up -d ([^\n]+)$/m;
const BUILD_LINES = /^[ \t]*docker compose build ([^\n]+)/gm;
const ROLLED_EXPANSION = "${ROLLED[@]}";

// Quote-stripped whitespace/comma tokens. The quotes only ever wrap the
// expansion, and leaving them on would glue them to the first and last name.
function listTokens(line) {
  return line
    .replace(/["']/g, "")
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
}

function parseRollLists(deploy) {
  const problems = [];
  const decl = deploy.match(ROLLED_DECL);
  const workers = decl ? listTokens(decl[1]) : [];
  if (!decl)
    problems.push(
      "deploy.yml has no `ROLLED=(...)` declaration — the roll list must be declared once and expanded by both build and up",
    );

  const up = deploy.match(UP_LINE);
  if (!up) problems.push("deploy.yml has no `docker compose up -d <services>` line");
  else if (!up[1].includes(ROLLED_EXPANSION))
    problems.push(
      `\`up -d\` names services literally (${up[1].trim()}) instead of expanding ROLLED`,
    );

  const builds = [...deploy.matchAll(BUILD_LINES)].map((m) => m[1]);
  if (builds.length === 0)
    problems.push("deploy.yml has no `docker compose build <services>` line");
  builds.forEach((raw, i) => {
    const label = `build #${i + 1}`;
    if (!raw.includes(ROLLED_EXPANSION)) {
      problems.push(
        `${label} names services literally (${raw.trim()}) instead of expanding ROLLED`,
      );
      return;
    }
    const built = new Set(listTokens(raw.replace(ROLLED_EXPANSION, workers.join(" "))));
    const missing = workers.filter((w) => !built.has(w));
    if (missing.length)
      problems.push(
        `${label} does not build rolled service(s) ${missing.join(", ")} — a rolled service that is never built keeps whatever image its tag happened to point at`,
      );
    if (!built.has("db-setup"))
      problems.push(`${label} omits db-setup, so the image that runs migrate deploy goes stale`);
  });

  // The release path must NOT build `app` (that would replace the published,
  // provenance-stamped artifact with a fresh local compile); the branch path must.
  // Exactly one of them naming `app` is the shape that encodes both rules.
  const appBuilds = builds.filter((raw) => listTokens(raw).includes("app")).length;
  if (builds.length && appBuilds !== 1)
    problems.push(
      `${builds.length} build command(s) and ${appBuilds} name \`app\`; exactly one must — the branch path builds it, the release path pulls it`,
    );

  return { workers, rolled: ["app", ...workers], problems };
}

function checkBuildRollSymmetry() {
  const { rolled, problems } = parseRollLists(read(".github/workflows/deploy.yml"));
  if (problems.length) {
    fail(
      `deploy.yml's build list and roll list are not one list:\n` +
        problems.map((p) => `       ${p}`).join("\n"),
    );
  }
  info(`rolled and built from one list: ${rolled.join(", ")}`);
}

function selfTestSymmetryGate() {
  const good = [
    "      ROLLED=(dial-worker email-worker overage-worker)",
    '      if [ "$DEPLOY_SOURCE" = "release" ]; then',
    '        docker compose build "${ROLLED[@]}" db-setup',
    "      else",
    '        docker compose build app "${ROLLED[@]}" db-setup',
    "      fi",
    '      docker compose up -d app "${ROLLED[@]}"',
  ].join("\n");

  // Each control changes exactly one thing about the fixture. `want: true` means
  // the detector MUST report it — a control nobody can turn red is not a test.
  const controls = [
    // The shape deploy.yml has now.
    { text: good, want: false, label: "one list, expanded by both" },
    // The 2026-10-17 condition, restored: a build line that lists services by
    // hand, so a service added to ROLLED is rolled and never built.
    {
      text: good.replace(
        'docker compose build app "${ROLLED[@]}" db-setup',
        "docker compose build app dial-worker email-worker db-setup",
      ),
      want: true,
      label: "build line lists services by hand",
    },
    // A roll that names its services literally rather than expanding the list.
    {
      text: good.replace('up -d app "${ROLLED[@]}"', "up -d app dial-worker"),
      want: true,
      label: "up -d lists services literally",
    },
    // No declaration to expand at all.
    {
      text: good.replace("      ROLLED=(dial-worker email-worker overage-worker)\n", ""),
      want: true,
      label: "no ROLLED declaration",
    },
    // db-setup missing from a build line: the migration image goes stale.
    {
      text: good.replace(
        'docker compose build "${ROLLED[@]}" db-setup',
        'docker compose build "${ROLLED[@]}"',
      ),
      want: true,
      label: "build omits db-setup",
    },
    // Both paths building app would overwrite the published release artifact.
    {
      text: good.replace(
        'docker compose build "${ROLLED[@]}" db-setup',
        'docker compose build app "${ROLLED[@]}" db-setup',
      ),
      want: true,
      label: "release path also builds app",
    },
    // Shrinking ROLLED is consistent by construction — build and roll shrink
    // together, so there is no asymmetry left to report. This is the case the
    // old two-literal-list file could not express.
    {
      text: good.replace(
        "ROLLED=(dial-worker email-worker overage-worker)",
        "ROLLED=(dial-worker email-worker)",
      ),
      want: false,
      label: "ROLLED shrank consistently",
    },
    // Prose that merely mentions the command must not parse as a build line.
    {
      text: `${good}\n      # and a manual \`docker compose build\` typed by an operator`,
      want: false,
      label: "comment mentioning docker compose build",
    },
  ];

  const wrong = controls.filter((c) => parseRollLists(c.text).problems.length > 0 !== c.want);
  if (wrong.length)
    fail(`roll-list symmetry self-test failed on: ${wrong.map((c) => c.label).join(", ")}`);
}

function checkServiceInventory() {
  const compose = YAML.parse(read("docker-compose.yml"));
  const defined = Object.keys(compose.services ?? {});
  if (defined.length === 0) fail("docker-compose.yml parsed with no services");

  const deploy = read(".github/workflows/deploy.yml");
  const lists = parseRollLists(deploy);
  if (lists.problems.length) {
    // checkBuildRollSymmetry already names the defect; a roll list that will not
    // parse makes every service look unaccounted, which is noise, not evidence.
    info("service inventory: NOT CHECKED — the roll list did not parse (see symmetry)");
    return;
  }
  const rolled = new Set(lists.rolled);

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
// CHECK — every image that is told to verify TLS actually ships the anchor
//
// On 2026-10-17 the deploy failed for the first time in a way that reached the
// roll step, and what it exposed was this: `src/lib/db.ts` demands
// `sslmode=verify-full&sslrootcert=supabase-ca.crt`, `scripts/copy-standalone.mjs`
// puts that certificate into the APP image, and the `worker` Dockerfile stage —
// which 7 of the 9 built services use, migrations included — copied `src/`,
// `prisma/`, `scripts/` and `node_modules` and never the file. Every worker query
// failed with `ENOENT ... 'supabase-ca.crt'`. The dial worker logged it 57,053
// times, once per tick, at error level, while `/api/health` answered `ok: true`
// because the web tier's image was fine. One service (outbox) worked only because
// its image was six days old and predated the stage split.
//
// The general shape, recorded because it recurs: a config value that names a file
// is a build dependency, and a build that does not satisfy it fails at RUNTIME in
// whichever process reads it — which here was every process except the one with a
// health endpoint.
// ─────────────────────────────────────────────────────────────────────────────

/** Split a Dockerfile into `{ stage, body }` per `FROM ... AS stage`. */
function dockerStages(text) {
  const out = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^FROM\s+.*\sAS\s+([A-Za-z0-9_.-]+)\s*$/i.exec(line.trim());
    if (m) {
      current = { stage: m[1], body: "" };
      out.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  return out;
}

/**
 * Does this stage's resulting image contain the trust anchor? True if it copies the
 * file itself, or copies the standalone output that `copy-standalone.mjs` fills with
 * it (the app tier's route).
 */
function stageCarriesAnchor(body, anchor) {
  return (
    new RegExp(`^COPY\\b[^\\n]*\\b${anchor}\\b`, "m").test(body) ||
    /^COPY\s+--from=\S+\s+\S*\.next\/standalone/m.test(body)
  );
}

function checkTlsAnchorInImages() {
  const anchor = "supabase-ca.crt";
  const composeText = read("docker-compose.yml");
  const dockerfile = read("Dockerfile");

  // Which anchor does the runtime actually demand? Read it from the documented
  // production URL rather than hard-coding a second source of truth.
  const envExample = read(".env.example");
  const demandsAnchor = new RegExp(`sslrootcert=${anchor}`).test(envExample);
  if (!demandsAnchor) {
    info(`no sslrootcert documented in .env.example — anchor check has nothing to guard`);
    return;
  }
  if (!existsSync(resolve(ROOT, anchor))) {
    fail(`.env.example demands sslrootcert=${anchor} but that file is not in the repository.`);
    return;
  }

  const targets = new Set(
    [...composeText.matchAll(/target:\s*([A-Za-z0-9_.-]+)/g)].map((m) => m[1]),
  );
  const stages = dockerStages(dockerfile);
  const byName = new Map(stages.map((s) => [s.stage, s]));

  // Tripwire on the gate itself: an empty target set or an unparsed Dockerfile makes
  // every assertion below pass over nothing.
  if (targets.size === 0 || stages.length === 0) {
    fail(
      `anchor check found ${targets.size} compose build targets and ${stages.length} Dockerfile ` +
        `stages — the parse broke, so this check is certifying nothing.`,
    );
    return;
  }

  const missing = [];
  for (const t of targets) {
    const s = byName.get(t);
    if (!s) {
      missing.push(`${t} (no such stage in Dockerfile)`);
      continue;
    }
    if (!stageCarriesAnchor(s.body, anchor)) missing.push(`${t} (stage does not ship ${anchor})`);
  }
  if (missing.length) {
    fail(
      `DATABASE_URL verifies TLS against ${anchor}, but these image stages do not contain it: ` +
        `${missing.join(", ")}. Every query from those containers fails ENOENT while the` +
        ` health endpoint of any image that happens to have the file stays green.`,
    );
    return;
  }
  info(
    `TLS anchor ships in every built image stage (${[...targets].join(", ")} → ${anchor} present)`,
  );
}

/**
 * Self-test, because this check exists precisely to catch a line that used to be
 * absent: if its regex could not see an absent COPY, it would have passed for a year.
 */
function selfTestAnchorGate() {
  const controls = [
    // A stage with no anchor and no standalone copy: MUST be reported.
    { body: "WORKDIR /app\nCOPY src ./src\n", want: false, label: "worker-like stage" },
    // Direct copy: MUST be accepted.
    { body: "COPY supabase-ca.crt ./\n", want: true, label: "explicit COPY" },
    // The app tier's route, via the standalone bundle: MUST be accepted.
    {
      body: "COPY --from=builder /app/.next/standalone ./\n",
      want: true,
      label: "standalone copy",
    },
    // A comment that merely mentions the file is not a copy: MUST be reported.
    { body: "# supabase-ca.crt goes here eventually\n", want: false, label: "comment only" },
    // An unrelated COPY of another cert is not this anchor: MUST be reported.
    { body: "COPY other-ca.crt ./\n", want: false, label: "different file" },
  ];
  const wrong = controls.filter((c) => stageCarriesAnchor(c.body, "supabase-ca.crt") !== c.want);
  if (wrong.length)
    fail(`anchor detector self-test failed on: ${wrong.map((c) => c.label).join(", ")}`);

  const unparsed = dockerStages("RUN echo no stages here\n");
  if (unparsed.length !== 0) fail("dockerStages matched a Dockerfile with no FROM ... AS");
  const one = dockerStages("FROM x AS a\nCOPY k ./\nFROM y AS b\nCOPY src ./src\n");
  if (one.length !== 2 || one[1].stage !== "b") fail("dockerStages did not split two stages");
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
/** Extensions that are bytes rather than text; everything else tracked is scanned. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|svgz|mp4|m4v|webm|mov|mp3|m4a|wav|ogg|flac|aac|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|jar|class|so|dylib|dll|exe|wasm|node|pyc|onnx|pt|db|sqlite3?)$/i;

function isScannable(path) {
  return !BINARY_EXT.test(path);
}

/**
 * Both shapes of "the bytes no longer say what the text meant:"
 *
 *   \u00b7 U+00E2 then U+20AC then one more character \u2014 the CP1252 rendering of a
 *     3-byte UTF-8 sequence, which is how an em dash leaves a copy-paste round
 *     trip through a Windows console;
 *   \u00b7 a lone U+FFFD, the replacement character some earlier write left where an
 *     em dash or a section sign was.
 *
 * Spelled by code point, in escapes, so this file cannot be its own offender.
 */
function mojibakeRuns(text) {
  return [...(text.match(/\u00e2\u20ac[\s\S]/g) ?? []), ...(text.match(/\ufffd/g) ?? [])];
}

/**
 * The gate's own positive control. Without it this check cannot tell "the repo is
 * clean" from "the check is blind" \u2014 and the blindness is how 14 runs survived in
 * `.env.example`, the file every operator copies when configuring a deployment,
 * because the filter below was an extension ALLOWLIST and `.env.example` has no
 * extension in the sense a regex like `\.(ts|md|json)$` means. The U+FFFD class
 * was invisible for the opposite reason: the pattern looked for one shape of
 * damage while 25 more lines carried the other.
 */
function selfTestMojibakeGate() {
  const problems = [];
  const run = "\u00e2\u20ac\u201d"; // the mojibake of an em dash, as found in the wild
  const fffd = "\ufffd";
  if (mojibakeRuns(`a note ${run} about the URL`).length !== 1)
    problems.push("control 1 failed: the planted double-encoded run was not detected");
  if (mojibakeRuns(`a note ${fffd} about the URL`).length !== 1)
    problems.push("control 2 failed: a planted replacement character was not detected");
  if (mojibakeRuns("a note \u2014 about the URL").length !== 0)
    problems.push("control 3 failed: a correct em dash was reported as damage");
  // Arabic and accents are the content this product ships, not the bug. A check
  // that flags them gets switched off the first time it annoys someone.
  if (
    mojibakeRuns(
      "\u0627\u0644\u0645\u062d\u0641\u0638 \u2014 \u0063\u0061\u0066\u00e9 \u0072\u00e9\u0073\u0075\u006d\u00e9",
    ).length !== 0
  )
    problems.push("control 4 overcorrects: legitimate non-ASCII was reported");
  if (!isScannable(".env.example"))
    problems.push("control 5 failed: `.env.example` is out of scope again \u2014 the exact hole");
  if (!isScannable("docker-compose.yml"))
    problems.push("control 6 failed: compose is out of scope");
  if (isScannable("public/mark.png")) problems.push("control 7 overcorrects: a PNG is scanned");
  if (problems.length) {
    fail(
      `checkMojibake self-test is BROKEN \u2014 the scan below cannot be trusted:\n` +
        `${problems.join("\n       ")}`,
    );
    return false;
  }
  info("checkMojibake self-test: planted run + planted replacement caught, Arabic left alone");
  return true;
}

function checkMojibake() {
  selfTestMojibakeGate();

  const files = execSync("git ls-files", { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter((f) => f && isScannable(f));

  const offenders = [];
  for (const f of files) {
    let s;
    try {
      s = readFileSync(join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    const runs = mojibakeRuns(s);
    if (runs.length) offenders.push(`${f} (${runs.length})`);
  }
  if (offenders.length) {
    fail(
      `double-encoded UTF-8 renders as garbage: ${offenders.join(", ")}\n` +
        `       repair each run by its code point ("\u00e2\u20ac\u201d" → "\u2014"). Do NOT round-trip it through latin1:\n` +
        `       Buffer.from("â‚¬", "latin1") takes the low byte (0xAC), not CP1252's 0x80,\n` +
        `       so that recipe quietly writes new garbage over the old. And never\n` +
        `       blanket-decode a whole file — it eats the Arabic and the accents that are\n` +
        `       meant to be there.`,
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

/**
 * Is this box running the blue/green colour slots?
 *
 * Asked of DOCKER, through the compose labels, for the same reason
 * `scripts/deploy.mjs mode` asks docker rather than compose: the blue/green
 * override declares `image: ${IMAGE:?…}` with no default, so a compose
 * command against the merged files refuses to parse without IMAGE. A gate
 * that cannot ask must not answer "no" — it must answer "unknown" and let
 * the operator look.
 */
function blueGreenMode() {
  try {
    const out = sh(
      'docker ps --format "{{.Labels}}" --filter "label=com.docker.compose.service=app-blue"',
    );
    return out.includes("app-blue");
  } catch {
    return false;
  }
}

/**
 * The compose services of the RUNNING containers in this project, read from
 * docker's own labels.
 *
 * The project label matters because this host serves more than one product: a
 * bare service-name filter would find the other product's `app`.
 */
function runningServicesByLabel() {
  const project = (YAML.parse(read("docker-compose.yml")).name ?? "securevoice-ai").toString();
  try {
    const out = sh(
      `docker ps --format '{{.Label "com.docker.compose.service"}}' ` +
        `--filter "label=com.docker.compose.project=${project}"`,
    );
    return new Set(
      out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
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

  // BLUE/GREEN. In colour-slot mode the base `app` service is deliberately
  // STOPPED — it is the container the adoption replaced, kept only so the
  // rollback is a `start` away. A gate that demands it be running would fail
  // every blue/green box, and the honest way to avoid that is to change what
  // the gate DEMANDS, not to leave `app` running beside the colours and
  // quietly serve traffic from two places.
  const blueGreen = blueGreenMode();
  if (blueGreen) {
    // The stopped plain container is the rollback, not a forgotten service.
    ONESHOT.add("app");
    // The colour slots are NOT in docker-compose.yml — they live in the
    // blue/green override, which this gate cannot ask compose about (the
    // merged files refuse to parse without IMAGE). So the running set is
    // completed from DOCKER's own labels, which is where the truth is.
    for (const service of runningServicesByLabel()) {
      running.add(service);
      if (!defined.includes(service)) defined.push(service);
    }
  }

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

/**
 * The whole point of this gate is "production is serving a commit that CI proved".
 *
 * It used to ask a different question — is the box on main's tip? — and that phrasing
 * made it wrong twice on the same day. Deploy run 39173983527 rolled `53b3554`
 * successfully, then tripped here because `autoversion` cut `121a860` onto main while
 * the deploy was in flight: the box was exactly where this deploy should have put it,
 * and the gate called that drift. Worse than a red X, because the step after it —
 * "Health check the rolled origin" — was skipped, so a good deploy produced no health
 * evidence at all.
 *
 * `judgeCurrency` is pure so the self-test can plant the real numbers, including the
 * false failure above, without needing a box.
 *
 * @param head        the box checkout's HEAD
 * @param dispatched  the SHA this deploy was triggered for (the upstream CI run's
 *                    head_sha). Empty on a `workflow_dispatch`, where there is no
 *                    upstream run to name and the tip comparison is the honest rule.
 * @param tip         origin/main as it reads right now
 */
function judgeCurrency({ head, dispatched, tip }) {
  if (!tip && !dispatched)
    return { verdict: "skip", note: "no origin/main reachable from the box" };
  if (!dispatched) {
    return head === tip
      ? { verdict: "ok", note: `manual deploy: box HEAD == origin/main (${head.slice(0, 7)})` }
      : {
          verdict: "fail",
          note:
            `the box is at ${head.slice(0, 7)} but origin/main is ${tip.slice(0, 7)} — ` +
            `a manual deploy must roll main's tip, and it is not on it.`,
        };
  }
  if (head !== dispatched) {
    return {
      verdict: "fail",
      note:
        `the box is at ${head.slice(0, 7)} but this deploy was dispatched for ` +
        `${dispatched.slice(0, 7)} (the commit CI proved). ` +
        (tip ? `origin/main now reads ${tip.slice(0, 7)}. ` : "") +
        `Production is serving a commit that the proving run was not about — either the ` +
        `roll pulled past it, or it pulled a tip that never went green.`,
    };
  }
  if (tip && tip !== dispatched) {
    return {
      verdict: "ok",
      warn:
        `box is on the dispatched ${dispatched.slice(0, 7)} and that is correct for this ` +
        `run; main has since moved to ${tip.slice(0, 7)}, which a later deploy will prove ` +
        `and roll. Not drift — the race this gate used to fail on.`,
      note: `box HEAD == dispatched (${dispatched.slice(0, 7)})`,
    };
  }
  return { verdict: "ok", note: `box HEAD == dispatched == origin/main (${head.slice(0, 7)})` };
}

function selfTestCurrencyGate() {
  const cases = [
    // The false failure that red-dened a good deploy (run 39173983527, measured):
    // box on the dispatched SHA, main moved on. Must NOT fail.
    {
      name: "measured race 53b3554 vs tip 121a860",
      in: {
        head: "53b3554cf506ddac283dd641e396e760f87fa302",
        dispatched: "53b3554cf506ddac283dd641e396e760f87fa302",
        tip: "121a86043a3e26494d02e9b7e3e370e85f323cc7",
      },
      want: "ok",
      wantWarn: true,
    },
    // A box that pulled past the proven commit must still fail, loudly.
    {
      name: "box pulled the unproven tip",
      in: {
        head: "121a86043a3e26494d02e9b7e3e370e85f323cc7",
        dispatched: "53b3554cf506ddac283dd641e396e760f87fa302",
        tip: "121a86043a3e26494d02e9b7e3e370e85f323cc7",
      },
      want: "fail",
    },
    // The clean case: nothing moved during the deploy.
    {
      name: "all three agree",
      in: { head: "a".repeat(40), dispatched: "a".repeat(40), tip: "a".repeat(40) },
      want: "ok",
    },
    // Manual dispatch: no upstream SHA, so the tip is the contract.
    {
      name: "manual deploy off tip",
      in: { head: "b".repeat(40), dispatched: "", tip: "c".repeat(40) },
      want: "fail",
    },
    {
      name: "manual deploy on tip",
      in: { head: "b".repeat(40), dispatched: "", tip: "b".repeat(40) },
      want: "ok",
    },
    // Neither reference available: skip, never pretend.
    {
      name: "no reference at all",
      in: { head: "d".repeat(40), dispatched: "", tip: "" },
      want: "skip",
    },
  ];

  const broken = [];
  for (const c of cases) {
    const r = judgeCurrency(c.in);
    if (r.verdict !== c.want) broken.push(`${c.name}: wanted ${c.want}, got ${r.verdict}`);
    if (c.wantWarn && !r.warn) broken.push(`${c.name}: expected a warning about the moved-on tip`);
    if (r.verdict === "fail" && !r.note.includes("box"))
      broken.push(`${c.name}: failure text names nothing`);
  }
  if (broken.length) {
    fail(
      `currency self-test is BROKEN — the real check below cannot be trusted:\n       ${broken.join("; ")}`,
    );
    return;
  }
  info(
    "currency self-test: measured race passes, unproven-tip pull still fails, manual path intact",
  );
}

function checkBoxCurrency() {
  let head = "";
  try {
    head = sh("git rev-parse HEAD");
  } catch {
    fail(`cannot read the box's git HEAD in ${BOX}`);
    return;
  }
  const tip = sh("git ls-remote origin refs/heads/main").split(/\s+/)[0] ?? "";
  // The commit this deploy was dispatched for — the upstream CI run's head_sha. It is
  // what "proven" means here; an empty value is a workflow_dispatch, which has no
  // upstream run and falls back to the tip comparison above.
  const dispatched = (process.env.DEPLOY_SHA ?? "").trim();

  const r = judgeCurrency({ head, dispatched, tip });
  if (r.verdict === "fail") fail(r.note);
  else if (r.verdict === "skip") info(r.note);
  else {
    if (r.warn) info(`${r.note}\n       WARN ${r.warn}`);
    else info(r.note);
  }
}

/**
 * The container id of a compose service, by whichever means answers.
 *
 * `docker compose ps -q <svc>` cannot see the blue/green colour slots: they
 * live in the override file, which this gate cannot ask compose about (the
 * merged files refuse to parse without IMAGE). So compose is tried first —
 * it is the proven path for the base services — and DOCKER's own labels are
 * the fallback.
 */
function containerIdForService(svc) {
  try {
    const viaCompose = sh(`docker compose --project-directory "${BOX}" ps -q ${svc}`);
    if (viaCompose) return viaCompose.split("\n")[0].trim();
  } catch {
    // compose could not answer; the label lookup below may still.
  }
  const project = (YAML.parse(read("docker-compose.yml")).name ?? "securevoice-ai").toString();
  try {
    const viaLabel = sh(
      `docker ps -q --filter "label=com.docker.compose.project=${project}" ` +
        `--filter "label=com.docker.compose.service=${svc}"`,
    );
    return viaLabel.split("\n")[0]?.trim() ?? "";
  } catch {
    return "";
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
  //
  // What this CANNOT see is a service that is rolled but never built: compose reuses
  // the existing image, it is still tagged, and the row looks conforming. That is how
  // overage-worker passed this gate on 2026-10-17 while failing every DB query on a
  // missing TLS anchor. `checkBuildRollSymmetry` is the gate for that condition; this
  // one only proves the container matches some tagged image.
  const deploy = read(".github/workflows/deploy.yml");
  const lists = parseRollLists(deploy);
  if (lists.problems.length) {
    fail(
      `deploy.yml roll list will not parse on the box gate:\n` +
        lists.problems.map((p) => `       ${p}`).join("\n"),
    );
    return;
  }
  const rolled = lists.rolled;
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
  // In blue/green mode the traffic-bearing container is a COLOUR SLOT, not the
  // base `app` service — and the base `app` container is deliberately stopped,
  // so inspecting it would certify a container that serves nothing. The slots
  // that exist are checked instead.
  const blueGreen = blueGreenMode();
  const rolledServices = blueGreen
    ? [
        ...rolled.filter((s) => s !== "app"),
        ...["app-blue", "app-green"].filter((s) => containerIdForService(s)),
      ]
    : rolled;
  for (const svc of rolledServices) {
    let cid = "";
    try {
      cid = containerIdForService(svc);
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
// CHECK 7 — .env.example and the code that reads env are the same set
//
// The recurring defect this repo keeps shipping is a knob that exists, looks
// authoritative, and does nothing: `planTier` read by no query, latency spans
// with no producer, an env var documented and hard-coded elsewhere. The env
// surface is where the next one will hide, so both directions are gated:
//
//   1. READ → DOCUMENTED: every env name read statically in src/ or scripts/
//      (process.env.X, process.env["X"], numSetting/numEnv("X"), the
//      NAME_ENV = "X" indirection, and `X_${...}` template families) appears
//      in .env.example. A live knob nobody documented is the provisioning
//      trap in reverse: it cannot be found, so it cannot be set.
//   2. DOCUMENTED → READ (or infra-named): every KEY documented in
//      .env.example is either named in the src/+scripts/ code blob (comments
//      stripped — a stale comment is not a consumer, that is how
//      NEXT_PUBLIC_SUPABASE_URL survived: its "reader" component was adapted
//      away years ago and only the prose remained) or named by an infra
//      consumer: compose, Dockerfiles, Caddyfile(s), sites.d/, the workflows,
//      mini-services/, or agent/*.yaml (the id_env contract scripts/agent-apply.ts
//      resolves). Category (b) knobs stay legal; "named by nobody at all" fails.
//
// Scope honestly: dynamic dispatch the extractor cannot see (flags.ts registry
// indirection, abuse per-org `__<ORG>` suffixes, retention's ENV_* consts are
// caught via the const pattern) means direction 1 UNDER-reports; direction 2
// never does — every documented name is checked. The self-test below feeds the
// finders a synthetic orphan key and a synthetic undocumented read and fails
// the gate if either survives, because a check with no positive control is
// decoration (this has been bitten twice this week; see the claims-gate regex).
// ─────────────────────────────────────────────────────────────────────────────

// Host/CI/tool variables that are legitimately absent from a deployment
// template. Everything here is an OS/CI contract, not a product knob; adding a
// name to this set is adding an exemption and must stay small and named.
const ENV_FRAMEWORK_ALLOW = new Set([
  "NODE_ENV", // config.ts fallback for APP_ENV; set by the runtime, not the operator
  "PORT", // the process listen port; set by compose/Dockerfile CMD
  "HOSTNAME",
  "HOME",
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "CI", // CI contract
  "BOX_DIR", // drift-gates box-suite pointer (documented in this file's header)
  "EDITOR",
  "DISPLAY",
  "NEXT_PHASE", // Next.js internal phase marker (read-only in auth/origins.ts)
  "NEXT_RUNTIME", // Next.js runtime selector (instrumentation.ts)
  "RENDER_INSTANCE_ID", // legacy Render hosting marker, set by that platform
  "LOCALAPPDATA", // Windows OS location of the Chrome install (lighthouse.mjs)
  "PYTHON", // interpreter override for local tooling (build-evidence.ts)
  "CHROME_PATH", // puppeteer-family convention for locating Chrome
]);
const envAllowed = (name) =>
  ENV_FRAMEWORK_ALLOW.has(name) || name.startsWith("GITHUB_") || name.startsWith("npm_");

/** Extract statically-visible env reads from one source text. */
function extractEnvReads(src) {
  const names = new Set();
  const prefixes = new Set(); // template families: `X_${...}` binds X_<anything>
  const add = (m) => m && /^[A-Z][A-Z0-9_]{2,}$/.test(m) && names.add(m);
  for (const m of src.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]{2,})\b/g)) add(m[1]);
  for (const m of src.matchAll(/\bprocess\.env\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g)) add(m[1]);
  for (const m of src.matchAll(
    /\b(?:numSetting|numEnv|envDays|envList|envMinor)\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
  ))
    add(m[1]);
  // `const SOME_ENV_NAME = "X"` — the indirection retention/breaker/session use.
  for (const m of src.matchAll(
    /\b[A-Z][A-Z0-9_]*ENV[A-Z0-9_]*\s*=\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
  ))
    add(m[1]);
  // Shell/PowerShell readers under scripts/ ($env:X, ${X}, "$envMap["X"]").
  for (const m of src.matchAll(/\$env:([A-Z][A-Z0-9_]{2,})\b/g)) add(m[1]);
  for (const m of src.matchAll(/\$envMap\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g)) add(m[1]);
  // Template family: process.env[`ELEVENLABS_VOICE_${...}`] etc.
  for (const m of src.matchAll(/\bprocess\.env\[\s*`([A-Z][A-Z0-9_]{3,})\$\{/g)) prefixes.add(m[1]);
  return { names, prefixes };
}

/** Every KEY documented in .env.example, commented examples included. */
function parseDocumentedKeys(envText) {
  const keys = new Set();
  for (const m of envText.matchAll(/(?:^|\n)\s*(?:export\s+)?#*\s*([A-Z][A-Z0-9_]{2,})\s*=/g))
    keys.add(m[1]);
  return keys;
}

function findUndocumentedReads(reads, documented) {
  return [...reads.names].filter(
    (n) =>
      !envAllowed(n) && !documented.has(n) && ![...reads.prefixes].some((p) => n.startsWith(p)), // covered by a family it belongs to
  );
}

function findUnreadKeys(documented, consumerBlob, templatePrefixes) {
  return [...documented].filter(
    (k) =>
      !consumerBlob.includes(k) &&
      // template families bridge `X_${...}` reads to every documented X_… member
      ![...templatePrefixes].some((p) => k.startsWith(p)),
  );
}

/** Remove whole-line // and # comments and /* *\/ blocks: prose is not a consumer. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|#)/.test(l))
    .join("\n");
}

function walkCodeFiles(dir, out, skipNodeModules = true) {
  for (const e of readdirSync(dir)) {
    if (skipNodeModules && (e === "node_modules" || e === ".next" || e === "dist")) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) {
      walkCodeFiles(full, out, skipNodeModules);
      continue;
    }
    if (/\.(ts|tsx|mjs|js|ps1|sh|cjs)$/.test(e)) out.push(full);
  }
  return out;
}

/**
 * Self-test: the finders are fed a fixture with a planted orphan key (documented,
 * read by nothing) and a planted undocumented read (read, documented nowhere).
 * If either survives the diff, the regexes or the set logic are broken and the
 * gate declares ITSELF dead rather than reporting a clean repo.
 */
function selfTestEnvGate() {
  const FIX_ENV = [
    "# fixture",
    'GATE_SELFTEST_ORPHAN="set but read by nobody"',
    'GATE_SELFTEST_PAIR="set and read"',
    "# GATE_SELFTEST_COMMENTED=also orphan",
  ].join("\n");
  const FIX_SRC = [
    "const a = Number(process.env.GATE_SELFTEST_READ);",
    'const b = numSetting("GATE_SELFTEST_READ2", 5);',
    'const READ3_ENV = "GATE_SELFTEST_READ3";',
    'const c = process.env["GATE_SELFTEST_READ4"];',
    "const d = process.env[`GATE_SELFTEST_FAMILY_${x}`];",
    'const e = numEnv("GATE_SELFTEST_PAIR", 1); // numEnv, documented pair',
    "// a commented-out read is NOT a read; a comment naming an orphan is not a consumer:",
    "// const z = process.env.GATE_SELFTEST_PROSE_READ;",
  ].join("\n");

  const documented = parseDocumentedKeys(FIX_ENV);
  const blob = stripComments(FIX_SRC);
  const reads = extractEnvReads(blob);
  const problems = [];

  // Fixture wiring is itself asserted, or the controls prove nothing:
  if (!documented.has("GATE_SELFTEST_ORPHAN") || !documented.has("GATE_SELFTEST_PAIR"))
    problems.push("parseDocumentedKeys missed fixture keys");
  if (
    ![
      "GATE_SELFTEST_READ",
      "GATE_SELFTEST_READ2",
      "GATE_SELFTEST_READ3",
      "GATE_SELFTEST_READ4",
    ].every((n) => reads.names.has(n))
  )
    problems.push("extractEnvReads missed fixture reads (literal/numSetting/const-bracket forms)");
  if (!reads.prefixes.has("GATE_SELFTEST_FAMILY_"))
    problems.push("extractEnvReads missed the template-family form");
  if (reads.names.has("GATE_SELFTEST_PROSE_READ"))
    problems.push("comment stripping leaked: a read named only inside a comment was extracted");

  const undoc = findUndocumentedReads(reads, documented);
  if (!undoc.includes("GATE_SELFTEST_READ"))
    problems.push("control 1 failed: undocumented read survived the diff");
  const unread = findUnreadKeys(documented, blob, reads.prefixes);
  if (!unread.includes("GATE_SELFTEST_ORPHAN") || !unread.includes("GATE_SELFTEST_COMMENTED"))
    problems.push("control 2 failed: orphan key (bare AND commented) survived the diff");
  if (unread.includes("GATE_SELFTEST_PAIR"))
    problems.push("positive control overcorrects: a documented+read key was reported as orphan");

  if (problems.length) {
    fail(
      `checkEnvDocs self-test is BROKEN — the real scan below cannot be trusted:\n` +
        `       ${problems.join("\n       ")}`,
    );
    return false;
  }
  info("checkEnvDocs self-test: planted orphan + planted undocumented read both caught");
  return true;
}

function checkEnvDocs() {
  const broken = selfTestEnvGate();

  const readerFiles = [];
  for (const d of ["src", "scripts"]) walkCodeFiles(join(ROOT, d), readerFiles);
  // This file is excluded from the READ scan: its self-test fixtures are
  // deliberate fake reads (`process.env.GATE_SELFTEST_*` in string literals),
  // which would contaminate direction 1. Its only real read (BOX_DIR) is on
  // the framework allowlist below, so the exclusion opens no hole the gate
  // would otherwise see.
  const reads = { names: new Set(), prefixes: new Set() };
  const readerBlobParts = [];
  for (const f of readerFiles) {
    if (f.endsWith("drift-gates.mjs")) continue;
    // Comments are stripped BEFORE extraction too: a prose mention of
    // `process.env.X` is not a read (that is how `PADDLE_SANDBOX_API_KEY`
    // survived as a comment-narrated myth in the scripts for weeks).
    const text = stripComments(readFileSync(f, "utf8"));
    const ex = extractEnvReads(text);
    for (const n of ex.names) reads.names.add(n);
    for (const p of ex.prefixes) reads.prefixes.add(p);
    readerBlobParts.push(stripComments(text));
  }

  // Infra consumers for direction 2. Names here count as read-by-deployment.
  const infraParts = [];
  const infraFiles = [];
  for (const pat of [
    "docker-compose.yml",
    "docker-compose.ci.yml",
    "docker-compose.bluegreen.yml",
  ]) {
    if (existsSync(join(ROOT, pat))) infraFiles.push(join(ROOT, pat));
  }
  for (const e of readdirSync(ROOT)) {
    if (e.startsWith("Dockerfile") || e.startsWith("Caddyfile")) infraFiles.push(join(ROOT, e));
  }
  // Extension-agnostic walk: these are consumers (Caddyfiles, yaml, README'd
  // directory notes, service package.json), not code to extract reads from.
  const walkAny = (p, out) => {
    for (const e of readdirSync(p)) {
      if (e === "node_modules" || e === ".next" || e === "dist") continue;
      const full = join(p, e);
      if (statSync(full).isDirectory()) walkAny(full, out);
      else out.push(full);
    }
    return out;
  };
  for (const d of ["sites.d", ".github/workflows", "agent", "mini-services"]) {
    const abs = join(ROOT, d);
    if (existsSync(abs)) walkAny(abs, infraFiles);
  }
  for (const f of infraFiles) {
    if (!statSync(f).isFile()) continue;
    infraParts.push(readFileSync(f, "utf8"));
  }

  const consumerBlob = readerBlobParts.join("\n") + "\n" + infraParts.join("\n");
  const documented = parseDocumentedKeys(read(".env.example"));

  const undocumentedReads = findUndocumentedReads(reads, documented);
  const unreadKeys = findUnreadKeys(documented, consumerBlob, reads.prefixes);

  if (undocumentedReads.length) {
    fail(
      `env reads with no .env.example entry (direction 1): ${undocumentedReads.sort().join(", ")}\n` +
        `       an undocumented live knob cannot be set by an operator who follows the docs.\n` +
        `       document it, or the read is wrong — do NOT add it to the framework allowlist\n` +
        `       unless it is genuinely an OS/CI contract.`,
    );
  }
  if (unreadKeys.length) {
    fail(
      `.env.example keys read by nobody in src/, scripts/, compose, Dockerfiles, Caddyfiles,\n` +
        `       sites.d/, the workflows, mini-services/ or agent/*.yaml (direction 2): ${unreadKeys.sort().join(", ")}\n` +
        `       this is the knob-that-does-nothing class: an operator sets it, believes\n` +
        `       behaviour changed, and nothing changes. Delete the entry (with any getter\n` +
        `       that only exists for it), or wire it for real. A stale code comment does NOT\n` +
        `       count — comments are stripped before this comparison.`,
    );
  }
  if (!broken) {
    info(
      `env docs: ${documented.size} documented keys, ${reads.names.size} static reads, ` +
        `${reads.prefixes.size} template families — both directions clean`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK — an append-only audit file may not SHRINK across a merge
//
// `docs/GAP-REGISTER.md` is the audit log. It merges cleanly in the wrong
// direction, which is why it keeps losing sections: two numbered entries are
// just text, so git never calls it a conflict — the shorter side is simply
// taken. Measured twice on 2026-10-18 in the same half hour:
//
//   • `f32083b` "Merge branch 'staging' into dev" resolved the register toward
//     staging and dropped §42. 2618 lines became 2525, and
//     `git diff 607b002 origin/dev -- docs/GAP-REGISTER.md` reported ZERO added
//     lines. The merge did not disagree with dev; it deleted dev.
//   • A fresh `git merge origin/staging` afterwards printed
//     "Merge made by the 'ort' strategy" and removed §37–§41, which staging had
//     already lost. Both merges exited 0.
//
// Nothing else in the tree can see this: the file is prose, so lint, typecheck,
// the test suites and the citation gate all stay green while history disappears.
// Counting section markers against each merge parent catches it, because an
// append-only log has exactly one legal change across a merge — grow.
// ─────────────────────────────────────────────────────────────────────────────
const APPEND_ONLY_FILES = ["docs/GAP-REGISTER.md"];

function countSections(text) {
  return (text.match(/^### \d+\./gm) ?? []).length;
}

/**
 * Pure so the self-test can plant history it does not have to earn.
 *
 * Returns one violation per (file, parent) pair where the merge result has fewer
 * sections than a parent. A parent that lacks the file entirely is skipped: that
 * is a branch where the log has not been born yet, not a deletion.
 */
function findAppendOnlyShrink(files, mergeCommit, parents, readAt) {
  const bad = [];
  for (const f of files) {
    const mine = readAt(mergeCommit, f);
    if (mine === null) continue;
    const mineCount = countSections(mine);
    for (const [i, parent] of parents.entries()) {
      const theirs = readAt(parent, f);
      if (theirs === null) continue;
      const theirsCount = countSections(theirs);
      if (mineCount < theirsCount) {
        bad.push(
          `${f}: ${mergeCommit.slice(0, 7)} has ${mineCount} numbered sections but merge ` +
            `parent #${i + 1} (${parent.slice(0, 7)}) has ${theirsCount} — an append-only ` +
            `audit log shrank across a merge. git resolved it toward the SHORTER side ` +
            `without calling a conflict. Restore the missing sections (that parent's copy ` +
            `is the superset) before this lands.`,
        );
      }
    }
  }
  return bad;
}

function repoGit(cmd) {
  try {
    return sh(cmd, ROOT);
  } catch {
    return null;
  }
}

/** git-backed reader for findAppendOnlyShrink; null means "ref or file absent". */
function gitShow(ref, file) {
  return repoGit(`git show ${ref}:${file}`);
}

function parentsOf(ref) {
  return (repoGit(`git rev-list --parents -n 1 ${ref}`) ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(1);
}

function selfTestAppendOnlyGate() {
  const broken = [];

  // Branch 1 — the shrink IS detected.
  const planted = findAppendOnlyShrink(["x.md"], "HEAD", ["aaa"], (ref) =>
    ref === "HEAD" ? "### 1.\n" : "### 1.\n### 2.\n### 3.\n",
  );
  if (planted.length !== 1) broken.push("planted SHRINK (3 sections -> 1) was not reported");

  // Branch 2 — growth is legal.
  const grew = findAppendOnlyShrink(["x.md"], "HEAD", ["bbb"], (ref) =>
    ref === "HEAD" ? "### 1.\n### 2.\n### 3.\n" : "### 1.\n### 2.\n",
  );
  if (grew.length !== 0) broken.push("planted LEGITIMATE append was reported as drift");

  // Branch 3 — a parent that never had the file is not a deletion.
  const unborn = findAppendOnlyShrink(["x.md"], "HEAD", ["ccc"], (ref) =>
    ref === "HEAD" ? "### 1.\n" : null,
  );
  if (unborn.length !== 0) broken.push("planted absent-parent case was reported as drift");

  // Branch 4 — the real cases, from this repository's own history. Both are merges
  // that LOST register sections and exited 0 while doing it:
  //   f32083b "Merge branch 'staging' into dev"   43 sections in, 42 out (§42 lost)
  //   851d531 "Merge origin/staging into ladder-dev" 42 sections in, 37 out (§37-§41 lost)
  // If the checkout is deep enough to have them, the detector MUST name them; if
  // not, the summary says it skipped. The first version of this arm printed
  // "historical clobber detected" unconditionally while the ref probe had failed —
  // a gate claiming a check it did not run.
  const KNOWN_CLOBBERS = ["f32083b", "851d531"];
  let checked = 0;
  for (const ref of KNOWN_CLOBBERS) {
    if (!repoGit(`git rev-parse --verify --quiet "${ref}^{commit}"`)) continue;
    checked++;
    const real = findAppendOnlyShrink(APPEND_ONLY_FILES, ref, parentsOf(ref), gitShow);
    if (real.length === 0)
      broken.push(`the historical clobber at ${ref} was NOT detected — the gate is decoration`);
  }

  if (broken.length) {
    fail(
      `append-only shrink self-test is BROKEN — the real check below cannot be trusted:\n` +
        `       ${broken.join("; ")}`,
    );
    return;
  }
  info(
    "append-only shrink self-test: planted shrink caught, planted append and unborn parent " +
      (checked > 0
        ? `cleared, ${checked} historical clobber(s) detected`
        : "cleared; historical arm SKIPPED (no known clobber refs in this checkout)"),
  );
}

function checkAppendOnlyShrink() {
  const parents = parentsOf("HEAD");
  if (parents.length < 2) {
    // Name the reason, because the two look identical in a log and only one of them
    // is a passing check. A depth-1 checkout cannot see a merge's parents at all, so
    // "HEAD is not a merge commit" printed against a real merge would be this gate
    // reporting a comparison it never made — the exact failure the self-test above
    // exists to catch. CI's Drift gates job therefore fetches full history.
    const shallow = repoGit("git rev-parse --is-shallow-repository") === "true";
    info(
      shallow
        ? "append-only audit guard: SKIPPED — shallow checkout, the merge's parents are not present to compare"
        : "append-only audit guard: HEAD is not a merge commit — nothing to compare",
    );
    return;
  }
  const head = repoGit("git rev-parse HEAD") ?? "HEAD";
  const bad = findAppendOnlyShrink(APPEND_ONLY_FILES, head, parents, gitShow);
  if (bad.length) fail(bad.join("\n       "));
  else
    info(
      `append-only audit guard: merge ${head.slice(0, 7)} keeps every numbered section present ` +
        `in both parents (${APPEND_ONLY_FILES.join(", ")})`,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK — every socket that SPEAKS to ElevenLabs is behind the commercial-use gate
//
// `egress.ts` enforced `ELEVENLABS_COMMERCIAL_USE` and its own header asserted it
// was "the only code in the repo that opens a socket to ElevenLabs". That claim was
// load-bearing and false: `src/lib/voice/elevenlabs-stream.ts` builds an
// `ElevenLabsClient` directly to speak live call audio, so the licence gate covered
// the demo and the console while the path that reaches a customer was ungated — the
// exact breach the guard exists to prevent, on the highest-stakes path in the
// product. `docker-compose.yml` passing the variable to the workers changes nothing
// about a path that never reads it.
//
// So the rule is measured, not remembered: any file that can make the vendor talk
// must consult the attestation. A verification-only client (`webhooks/elevenlabs`
// constructs one to HMAC-check an inbound payload and never calls out) is not a
// socket, which is why the predicate needs the synthesis call, not the import.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does this file put words into ElevenLabs' mouth?
 *
 * Only the SDK arm is checked here: `tests/unit/elevenlabs-script-egress.test.ts`
 * already ratchets fetch calls written with the vendor host spelled out, and it is
 * that gate's blind spot this one fills — a client built from the package never
 * contains a vendor URL, so a URL regex cannot see it.
 */
function opensVendorSpeechSocket(text) {
  return text.includes("new ElevenLabsClient(") && /\.textToSpeech\b/.test(text);
}

function attestationOffenders(files) {
  return files
    .filter((f) => opensVendorSpeechSocket(f.text) && !f.text.includes("commercialUseAttested"))
    .map((f) => f.path);
}

function checkVendorAttestationSites() {
  const files = walkCodeFiles(join(ROOT, "src"), []).map((p) => ({
    path: p.slice(ROOT.length + 1).replace(/\\/g, "/"),
    text: readFileSync(p, "utf8"),
  }));
  const offenders = attestationOffenders(files);
  if (offenders.length) {
    fail(
      `these files can make ElevenLabs speak but never check ELEVENLABS_COMMERCIAL_USE:` +
        `\n       ${offenders.join("\n       ")}\n` +
        `       ToS §1(c)(i) limits a free account to non-commercial use, and a bank fraud pilot is\n` +
        `       commercial. Refuse before the socket, as src/lib/elevenlabs/egress.ts and\n` +
        `       src/lib/voice/elevenlabs-stream.ts both do.`,
    );
  } else info("every ElevenLabs speech socket consults the commercial-use attestation");
}

/**
 * Self-test: the predicate is fed a planted unattested speech file, an attested one,
 * and a verification-only client that must NOT be flagged. If the planted offender
 * survives, or the legitimate files are flagged, the gate is decoration and says so.
 */
function selfTestAttestationGate() {
  const broken = [];
  const PLANTED = [
    { path: "a/unattested.ts", text: `new ElevenLabsClient({}).textToSpeech.stream("v", {});` },
    {
      path: "b/attested.ts",
      text: `if (!env.commercialUseAttested) throw 1;\nnew ElevenLabsClient({}).textToSpeech.stream();`,
    },
    {
      path: "c/verify-only.ts",
      text: `const c = new ElevenLabsClient({ apiKey: "webhook-verification-only" }); c.webhooks.constructEvent();`,
    },
  ];
  const found = attestationOffenders(PLANTED);
  if (!found.includes("a/unattested.ts"))
    broken.push("planted unattested speech socket was NOT caught");
  if (found.includes("b/attested.ts")) broken.push("attested socket was falsely flagged");
  if (found.includes("c/verify-only.ts"))
    broken.push("verification-only client was falsely flagged");
  if (broken.length) fail(`attestation gate self-test: ${broken.join("; ")}`);
  else
    info(
      "attestation gate self-test: planted unattested socket caught, attested and verify-only files cleared",
    );
}

/**
 * CHECK — the gap register's section numbers are unique and ascending.
 *
 * The register is append-only, and `checkAppendOnlyShrink` proves a merge cannot LOSE a
 * numbered section. It says nothing about a DUPLICATE, and duplicates are not
 * hypothetical: on 2026-10-19 two agent sessions working in one shared tree each wrote a
 * §54 about the same disk incident, minutes apart, and every gate in the repository passed
 * the result. Two sections claiming the same number means a citation like "§54" no longer
 * resolves, which is the only thing the register is for — and the first §54 to arrive is
 * the one a reader finds, while the other reads as a perfectly reasonable section 54.
 *
 * So the invariant is stated where it can fail: one number, one section, in order.
 */
function registerNumberProblems(numbers) {
  const problems = [];
  const seen = new Map();
  numbers.forEach((n, i) => {
    if (seen.has(n))
      problems.push(`§${n} appears twice (at sections ${seen.get(n) + 1} and ${i + 1})`);
    else seen.set(n, i);
    if (i > 0 && n <= numbers[i - 1])
      problems.push(`§${n} follows §${numbers[i - 1]} — not ascending`);
  });
  return [...new Set(problems)];
}

function checkRegisterNumbering() {
  const numbers = read("docs/GAP-REGISTER.md")
    .split("\n")
    .filter((l) => /^### \d+\./.test(l))
    .map((l) => Number(l.match(/^### (\d+)\./)[1]));
  if (numbers.length < 40)
    fail(
      `the gap register exposes ${numbers.length} numbered sections; the parser is broken, ` +
        `not the register. A numbering gate that reads nothing passes by accident.`,
    );
  const problems = registerNumberProblems(numbers);
  if (problems.length)
    fail(
      `docs/GAP-REGISTER.md numbering:\n       ${problems.join("\n       ")}\n` +
        `       renumber the later one and update its cross-references; a citation that ` +
        `matches two sections cites nothing.`,
    );
  else
    info(
      `gap register numbering: ${numbers.length} sections, unique and ascending (1..${numbers.at(-1)})`,
    );
}

/**
 * Self-test: the planted cases that matter. A duplicate must be named, an out-of-order
 * section must be named, a clean sequence must pass, and — the trap in every parser — an
 * EMPTY extraction must not look like a pass.
 */
function selfTestNumberingGate() {
  const broken = [];
  if (!registerNumberProblems([1, 2, 2, 3]).some((p) => p.includes("§2 appears twice")))
    broken.push("planted duplicate was NOT caught");
  if (!registerNumberProblems([1, 3, 2]).some((p) => p.includes("not ascending")))
    broken.push("planted out-of-order section was NOT caught");
  if (registerNumberProblems([1, 2, 3, 54, 55]).length) broken.push("a clean sequence was flagged");
  // 54 then 54 then 55 is the actual shape that reached the tree on 2026-10-19.
  if (!registerNumberProblems([53, 54, 54, 55]).length)
    broken.push("the real duplicate shape passed");
  if (broken.length) fail(`numbering gate self-test: ${broken.join("; ")}`);
  else
    info("numbering gate self-test: planted duplicate and reversal caught, clean sequence cleared");
}

/**
 * CHECK — there is exactly one definition of "clean up this box", and the runner cron is
 * not allowed to be a second one.
 *
 * The 2026-10-19 disk incident produced `scripts/reclaim-ci.sh` by deleting three divergent
 * inline reclaim loops from three workflows. Four days later the box's own cron held a fourth
 * copy, written earlier, and its `docker buildx prune` was the exact command the reclaimer
 * had already been fixed away from: plain `buildx prune` reaches only the ONE builder the
 * endpoint resolves to, so it reported success nightly while builders accumulated 14.6 GB and
 * 2.27 GB of state volumes and the disk slid to 21 GB free. The fix that was already in the
 * repository could not help a schedule that did not read it.
 *
 * So: the cron delegates, and a `docker … prune` inside it is the regression this names.
 */
function reclaimDuplication(text) {
  const owned = [
    "docker buildx prune",
    "docker builder prune",
    "docker volume prune",
    "docker image prune",
    "docker system prune",
  ];
  // Comments are stripped first. This file explains at length why `docker buildx prune` is
  // the wrong command, and a scanner that reads prose as code gets reworded away rather than
  // obeyed — the same way a `// TODO` that trips a lint rule trains its author to write the
  // sentence differently instead of fixing the thing.
  const code = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  return owned.filter((cmd) => code.includes(cmd));
}

function checkSingleReclaimer() {
  const hygiene = read("scripts/runner-hygiene.sh");
  const problems = [];
  if (!hygiene.includes("scripts/reclaim-ci.sh"))
    problems.push(
      "scripts/runner-hygiene.sh does not call scripts/reclaim-ci.sh — the box's nightly " +
        "schedule and CI would then run different definitions of cleanup",
    );
  const dupes = reclaimDuplication(hygiene);
  if (dupes.length)
    problems.push(
      `scripts/runner-hygiene.sh runs its own docker reclaim (${dupes.join(", ")}); ` +
        `those rules belong to scripts/reclaim-ci.sh, which guards them with reference and ` +
        `age checks this file cannot see`,
    );
  if (problems.length) fail(`single reclaimer:\n       ${problems.join("\n       ")}`);
  else
    info(
      "single reclaimer: the runner cron delegates to scripts/reclaim-ci.sh and keeps no docker prune of its own",
    );
}

/**
 * Self-test: a planted private prune must be caught, the delegating form must clear, and a
 * script that calls NOTHING must not pass — the empty read is the failure mode every parser
 * here has been burned by.
 */
function selfTestReclaimGate() {
  const broken = [];
  const planted = "#!/usr/bin/env bash\nfoo\n  docker buildx prune -f\n  docker volume prune -f\n";
  const caught = reclaimDuplication(planted);
  if (!caught.includes("docker buildx prune"))
    broken.push("planted private buildx prune was NOT caught");
  if (!caught.includes("docker volume prune"))
    broken.push("planted private volume prune was NOT caught");
  if (reclaimDuplication('RECLAIMER="$REPO_DIR/scripts/reclaim-ci.sh"\n').length)
    broken.push("the delegating form was falsely flagged");
  if (broken.length) fail(`reclaimer gate self-test: ${broken.join("; ")}`);
  else info("reclaimer gate self-test: planted private prunes caught, delegating form cleared");
}

/**
 * Self-test: the parser must count identities, not lines. Planted one-voice, six-voice,
 * mixed-quoting, gaped and all-empty cases, because the shape that matters — "six slots,
 * six people" — is the one an empty or careless regex reports as clean. Every branch here
 * was checked by mutating the parser, and one of them caught a mutation the first
 * fixture set let through.
 */
function selfTestVoiceIdentityState() {
  const broken = [];
  const ONE = ["EN", "AR", "HI", "UR", "FR", "SW"]
    .map((l) => `ELEVENLABS_VOICE_${l}=abc123`)
    .join("\n");
  if (voiceIdentityState(ONE).distinct !== 1)
    broken.push("one id in six slots was not read as one voice");

  const SIX = [
    "EXAVITQu4vr4xnSDxMaL",
    "JBFqnCBsd6RMkjVDRZzb",
    "Xb7hH8MSUJpSbSDYk0k2",
    "nPczCjzI2devNBz1zQrb",
    "CwhRBWXzGAHq8TQ4Fs17",
    "XrExE9yKIg1WjnnlVkGX",
  ]
    .map((id, i) => `ELEVENLABS_VOICE_${["EN", "AR", "HI", "UR", "FR", "SW"][i]}=${id}`)
    .join("\n");
  const six = voiceIdentityState(SIX);
  if (six.distinct !== 6 || six.missing.length)
    broken.push("six distinct ids were not read as six voices");

  // Same id, half of them quoted — the way a real `.env` is written, where one editor
  // quotes and another does not. Without the strip, `"same_id"` and `same_id` are two
  // distinct voices and the report says one agent is two. This fixture was first
  // written ALL quoted, and stayed green against a mutation that deleted the strip
  // outright: six identically-quoted values are one set either way. A fixture that
  // passes for the wrong reason is not a test, so it now mixes the two forms.
  const MIXED = ["EN", "AR", "HI", "UR", "FR", "SW"]
    .map((l, i) => `ELEVENLABS_VOICE_${l}=${i % 2 ? '"same_id"' : "same_id"}`)
    .join("\n");
  if (voiceIdentityState(MIXED).distinct !== 1)
    broken.push("a quoted value was counted as a different voice");

  const GAPED = ["EN", "AR", "HI", "UR", "SW"].map((l) => `ELEVENLABS_VOICE_${l}=x${l}`).join("\n");
  const g = voiceIdentityState(GAPED);
  if (g.distinct !== 5 || !g.missing.includes("FR"))
    broken.push("a missing slot was neither counted nor named");

  const EMPTY = ["EN", "AR", "HI", "UR", "FR", "SW"]
    .map((l) => `ELEVENLABS_VOICE_${l}=`)
    .join("\n");
  if (voiceIdentityState(EMPTY).missing.length !== 6)
    broken.push("six empty slots were read as six configured voices");

  if (broken.length) fail(`voice identity self-test: ${broken.join("; ")}`);
  else
    info(
      "voice identity self-test: one-voice, six-voice, mixed quoting, gaped and empty-slot shapes all read correctly",
    );
}

/**
 * Pure: read the six `ELEVENLABS_VOICE_<LANG>` slots out of a deployment's .env text
 * and report how many distinct identities they name. Values are taken only from those
 * six keys — the file also holds API keys and tokens, which this never reads or prints.
 */
function voiceIdentityState(envText) {
  const slots = ["EN", "AR", "HI", "UR", "FR", "SW"];
  const values = slots.map((lang) => {
    const m = new RegExp(`^ELEVENLABS_VOICE_${lang}=(.*)$`, "m").exec(envText);
    return m ? m[1].trim().replace(/^"|"$/g, "") : null;
  });
  const missing = slots.filter((_, i) => !values[i]);
  const distinct = new Set(values.filter(Boolean));
  return { missing, distinct: distinct.size, configured: values.length - missing.length };
}

/**
 * CHECK — report which voices the deployment's six slots actually hold.
 *
 * The owner's ruling of 2026-10-20 is six DISTINCT voices, one per delivery language
 * (`docs/GAP-REGISTER.md` §65): a caller should hear a voice that belongs to their
 * language, not an English voice reading Arabic. `deliveryVoice()` reads one
 * `ELEVENLABS_VOICE_<LANG>` id per language, so that ruling is six values, not one
 * repeated six times. `voice:check` proves each language is spoken IN that language
 * and says nothing about which voice carries it; this line exists so the slot state is
 * visible at the moment someone deploys, rather than discovered by a cardholder.
 *
 * It REPORTS and does not fail. A voice change is a brand decision the register
 * records as owner-side; a gate that reds on a decision already made in prose would
 * only teach people to ignore it.
 */
function checkVoiceIdentity() {
  const envPath = join(BOX, ".env");
  if (!existsSync(envPath)) {
    info(`voice identity: no .env at ${BOX}, so the six slots could not be read`);
    return;
  }
  let envText;
  try {
    envText = readFileSync(envPath, "utf8");
  } catch (e) {
    info(`voice identity: .env unreadable (${String(e.message).slice(0, 60)}) — not measured`);
    return;
  }
  const s = voiceIdentityState(envText);
  if (s.missing.length)
    info(
      `voice identity: ${s.configured}/6 slots set, MISSING for ${s.missing.join(",")} — ` +
        `a missing slot is refused at synthesis with "no voice configured", it does not borrow another language's voice`,
    );
  else if (s.distinct === 1)
    info(
      "voice identity: one voice across all six slots — the 2026-10-20 ruling is one distinct " +
        "voice per language (§65), so this is the deviation to explain, not the target",
    );
  else
    info(
      `voice identity: ${s.distinct} distinct voices across the six slots — matches the 2026-10-20 ` +
        `ruling (one per language). \`bun scripts/voice-audition.mjs --list\` names the candidates; ` +
        `choose each slot's voice by listening.`,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
const SUITES = {
  repo: [
    selfTestSymmetryGate,
    checkBuildRollSymmetry,
    checkServiceInventory,
    checkImageIsolation,
    checkSecretsProvenance,
    selfTestAnchorGate,
    checkTlsAnchorInImages,
    checkTestImports,
    checkUnusedDependencies,
    checkMojibake,
    checkEnvDocs,
    selfTestAttestationGate,
    checkVendorAttestationSites,
    selfTestNumberingGate,
    checkRegisterNumbering,
    selfTestReclaimGate,
    checkSingleReclaimer,
    selfTestVoiceIdentityState,
    selfTestAppendOnlyGate,
    checkAppendOnlyShrink,
    selfTestCurrencyGate,
  ],
  box: [checkBoxInventory, checkBoxCurrency, checkBoxImageConformance, checkVoiceIdentity],
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
