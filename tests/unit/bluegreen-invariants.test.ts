import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

/**
 * The blue/green + canary machinery has one invariant that everything else
 * depends on, and it is invisible until it is violated:
 *
 *   THE BLUE/GREEN OVERRIDE MUST NOT BECOME A SECOND COMPOSE PROJECT.
 *
 * A compose project owns its named volumes. The blue/green file used to carry
 * its own `name:` AND its own `db` service, so the colour slots would have
 * talked to a SECOND, EMPTY Postgres while production's data sat in the
 * first project's volume. The failure mode is not a crash — it is a colour
 * that starts perfectly happily against an empty database and serves 200s to
 * a canary, which is precisely the state a canary cannot detect.
 *
 * So these assertions are about the COMPOSE FILES, not about the script that
 * drives them: the script is easy to change, and the file is where the second
 * database would come from.
 *
 * The other half of the file is about the AUTOMATIC path. A canary that has
 * to be remembered is a canary that does not run during the incident it was
 * meant to protect against, so the workflow must be triggered by the deploy
 * rather than by a human — and it must be able to do nothing, successfully,
 * on a host that has not adopted blue/green.
 */
/**
 * `merge: true` is REQUIRED, and without it every assertion about the colour
 * slots is vacuous.
 *
 * The two slots are declared with the YAML merge key (`<<: *app-slot`), which
 * is how the override stays a small file instead of two copies of the same
 * forty lines — and Docker Compose honours merge keys natively. The `yaml`
 * package does NOT by default: it keeps `<<` as a literal key, so a slot
 * parses as `{ "<<": {...}, hostname: "app-blue" }` with no `image`, no
 * `expose` and no `ports` on it at all. Every assertion below would then be
 * reading `undefined` and passing for the wrong reason, or failing for a
 * reason that has nothing to do with the compose file.
 *
 * So the parser is told to do what Compose does.
 */
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const bluegreen = YAML.parse(read("docker-compose.bluegreen.yml"), { merge: true });
const base = YAML.parse(read("docker-compose.yml"), { merge: true });
const canary = read(".github/workflows/canary.yml");
const deploy = read(".github/workflows/deploy.yml");
const deployScript = read("scripts/deploy.mjs");

describe("the blue/green override", () => {
  test("does not declare its own project name", () => {
    // With a `name:` of its own it is a SECOND PROJECT: its own network, its
    // own containers, and — because the volumes are project-prefixed — its
    // own empty database.
    expect(bluegreen.name).toBeUndefined();
    expect(base.name).toBeTruthy();
  });

  test("does not redefine the database, the migration job or realtime", () => {
    // A redefined `db` is a redefined VOLUME MOUNT, and therefore a second
    // data directory. A redefined `db-setup` is a second migration runner,
    // which is how two schema versions end up applied to one database.
    for (const service of ["db", "db-setup", "realtime", "redis", "caddy"]) {
      expect(
        bluegreen.services?.[service],
        `${service} must come from docker-compose.yml, not from the override`,
      ).toBeUndefined();
    }
  });

  test("adds exactly the two colour slots", () => {
    expect(Object.keys(bluegreen.services ?? {}).sort()).toEqual(["app-blue", "app-green"]);
  });

  test("the slots take their image from IMAGE with no default", () => {
    // A slot that resolved to the mutable `securevoice-ai-app:local` tag could
    // be serving a build nobody named.
    for (const colour of ["app-blue", "app-green"]) {
      expect(bluegreen.services[colour].image).toContain("IMAGE");
      expect(bluegreen.services[colour].image).toContain(":?");
    }
  });

  test("the slots publish no host port", () => {
    // A published port would be reachable without the edge, and the edge is
    // what marks a request as proxied (src/proxy.ts).
    for (const colour of ["app-blue", "app-green"]) {
      expect(bluegreen.services[colour].ports).toBeUndefined();
      expect(bluegreen.services[colour].expose).toContain("3000");
    }
  });

  test("the traffic pointer lives on the BASE caddy service", () => {
    // `env_file` declared on an override service is dropped by compose's
    // merge, so a pointer declared there never reaches the container and the
    // flip silently does nothing.
    const envFile = base.services?.caddy?.env_file;
    const entries = (Array.isArray(envFile) ? envFile : [envFile]).filter(Boolean);
    expect(entries.length).toBeGreaterThan(0);
    expect(
      entries.some((e: { path?: string }) => (e.path ?? "").includes(".deploy/active.env")),
    ).toBe(true);
  });
});

describe("the automatic canary", () => {
  test("is triggered by a successful deploy, not by a human", () => {
    expect(canary).toContain("workflow_run");
    expect(canary).toContain('workflows: ["Deploy"]');
    expect(canary).toContain("types: [completed]");
  });

  test("still allows a manual run", () => {
    expect(canary).toContain("workflow_dispatch");
  });

  test("does nothing, successfully, on a host that has not adopted blue/green", () => {
    // A canary workflow that goes red on every deploy of a plain host trains
    // everyone to ignore it — and the one time it would have mattered is the
    // one time it is ignored.
    expect(canary).toContain("deploy.mjs mode");
    expect(canary).toContain("bluegreen");
    expect(canary).toMatch(/run=false/);
  });

  test("the widening runs in ONE command, so the rollback runs with it", () => {
    // A canary whose rollback lives in a workflow step is a rollback that does
    // not run when the runner dies mid-step — and that is the one moment the
    // site is half on the new build.
    expect(canary).toContain("deploy.mjs auto");
    // The command is the one that aborts to a reverted split.
    expect(deployScript).toContain("ROLLING BACK");
    expect(deployScript).toContain("canary({ percent: 0");
  });

  test("gates on BOTH the staged colour and the edge", () => {
    // An edge answering 200 while the canary upstream is broken is exactly
    // the failure a canary exists to catch.
    expect(deployScript).toContain("probeDirect");
    expect(deployScript).toContain("/api/readyz");
    expect(deployScript).toMatch(/soak/);
  });

  test("rolls back when a gate is red", () => {
    expect(canary).toContain("if: failure()");
    expect(canary).toContain("deploy.mjs rollback");
  });
});

describe("the automatic deploy", () => {
  test("branches on the stack mode", () => {
    expect(deploy).toContain("deploy.mjs mode");
    expect(deploy).toContain("bluegreen");
  });

  test("keeps the plain path intact for a host that has not adopted", () => {
    // The proven path stays byte-identical: the blue/green branch is new code
    // that only runs on an adopted box.
    expect(deploy).toContain('docker compose up -d app "${ROLLED[@]}"');
  });

  test("stages the release into the idle colour on an adopted box", () => {
    // STAGE, not a traffic move: the widening belongs to the command that can
    // roll back from inside itself.
    expect(deploy).toContain("deploy.mjs stage --image");
    expect(deploy).not.toContain("deploy.mjs deploy --image");
  });
});

describe("the deploy script", () => {
  test("never addresses a colour container by a bare name", () => {
    // The slots used to declare `container_name: securevoice-app-blue`, so
    // `docker inspect app-blue` looked for a container that does not exist
    // and every health wait and in-container probe reported a container that
    // had never started.
    expect(deployScript).not.toMatch(/"app-\$\{colour\}"/);
    expect(deployScript).toContain("com.docker.compose.service");
  });

  test("reads the stack mode from docker, not from compose", () => {
    // `docker compose ps` cannot parse the merged files without IMAGE, so a
    // mode probe that used it would answer "unknown" on the one host where
    // the operator has not set it.
    expect(deployScript).toContain("com.docker.compose.project");
  });

  test("has an adoption command, and it is a separate one", () => {
    expect(deployScript).toContain('case "adopt"');
    expect(deployScript).toContain('case "mode"');
  });

  test("the adoption starts the first colour on the image that is ALREADY serving", () => {
    // Adopting on a different build would be an unannounced release.
    expect(deployScript).toContain("{{.Config.Image}}");
  });

  test("promote refuses to stop the colour that is serving", () => {
    // A rollback leaves the state recording the SAME colour as both `active`
    // and `previous`. A `promote` that trusted those two fields would stop
    // the serving container — an outage caused by the command that exists to
    // end one.
    expect(deployScript).toContain("state.previous === state.active");
  });

  test("the rollback path refuses a no-op rollback", () => {
    expect(deployScript).toContain("already live on app-");
  });
});
