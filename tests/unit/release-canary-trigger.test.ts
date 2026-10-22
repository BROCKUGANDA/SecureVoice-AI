import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

/**
 * A RELEASE must reach the canary.
 *
 * The canary is the half of a blue/green release that moves traffic. Without
 * it the deploy does the safe half — build, migrate, stage the release into
 * the idle colour, prove it healthy — and stops. The new colour is running
 * and healthy and receives 0% of the requests, the old colour keeps serving
 * 100%, and the release is over in every sense except that the published
 * artifact is the one in production.
 *
 * That is not a hypothetical. On 2026-10-22 the v0.2.51 release was
 * published, rolled, staged and proven healthy, and served nothing:
 *
 *     state_image  ghcr.io/brockuganda/securevoice-ai:v0.2.51
 *     active       blue            <- the previous build
 *     staged       green           <- the published image, serving 0%
 *     via caddy    200
 *
 * The release only finished when an operator dispatched the canary by hand.
 *
 * WHY IT HAPPENED
 * ---------------
 * `canary.yml` triggered on `workflow_run` of the Deploy workflow, and GitHub
 * emits no `workflow_run` event for a run that was itself started by
 * `workflow_dispatch`. The BRANCH path reaches the deploy as a `workflow_run`
 * of CI, so it canaried. The RELEASE path reaches the deploy as a
 * `workflow_dispatch` from `release.yml` (because `workflow_run` can name
 * only ONE upstream workflow, and a release is not a CI run), so it did not.
 *
 * Measured, twice:
 *
 *     Deploy #39574133567  workflow_run      completed 09:06:45 -> Canary 09:06:49
 *     Deploy #39575714596  workflow_run      completed 09:19:26 -> Canary 09:19:28
 *     Deploy #39577117053  workflow_dispatch completed 09:28:42 -> (none)
 *     Deploy #39582683719  workflow_run      completed 10:12:45 -> Canary 10:12:47
 *     Deploy #39709642750  workflow_run      completed 02:11:04 -> Canary 02:11:06
 *     Deploy #39710620859  workflow_dispatch completed 02:30:28 -> (none)
 *
 * The v0.2.50 release appeared to work only because an unrelated branch
 * deploy's canary happened to be widening the same colour at the time. That
 * was luck, and the ledger recorded it as a success.
 *
 * THE SHAPE OF THE FIX
 * -------------------
 * The deploy is the one workflow that knows a release is staged, migrated and
 * healthy, so it is the one that hands it to the canary. One dispatcher means
 * one canary per deploy, and the release path is no longer a special case
 * that has to be remembered.
 */
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const deployRaw = read(".github/workflows/deploy.yml");
const canaryRaw = read(".github/workflows/canary.yml");
const releaseRaw = read(".github/workflows/release.yml");

const deploy = YAML.parse(deployRaw);
const canary = YAML.parse(canaryRaw);
const release = YAML.parse(releaseRaw);

describe("the release path reaches the canary", () => {
  test("the deploy hands the staged release to the canary", () => {
    // The handover is a dispatch from the deploy's last step, so both paths
    // — a branch deploy and a release deploy — reach the canary the same way.
    expect(deployRaw).toContain("gh workflow run canary.yml");
  });

  test("the deploy is allowed to dispatch a workflow at all", () => {
    // `gh workflow run` needs `actions: write`. Without it the handover step
    // fails, and a release that is staged and serving nothing is exactly the
    // failure the whole arrangement exists to prevent — so this permission is
    // load-bearing, not hygiene.
    expect(deploy.permissions["actions"]).toBe("write");
  });

  test("the handover happens AFTER the origin is proven healthy", () => {
    // The order is the gate. A canary handed a release before the deploy has
    // proven the origin answers is a canary of something that might not work.
    const healthAt = deployRaw.indexOf("Health check the rolled origin");
    const handoverAt = deployRaw.indexOf("Hand the release to the canary");

    expect(healthAt).toBeGreaterThan(-1);
    expect(handoverAt).toBeGreaterThan(healthAt);
  });

  test("the canary has exactly ONE trigger, and it is a dispatch", () => {
    // ONE trigger, not two. The canary used to be triggered by `workflow_run`
    // on Deploy AND — after the fix — dispatched by Deploy; two dispatchers
    // mean two canaries, and the second would re-widen a release the first
    // had already promoted.
    //
    // `workflow_run` is asserted ABSENT rather than merely unused: a
    // `workflow_run` trigger is what silently excluded the release path, and
    // adding it back would look harmless and would not be.
    expect(Object.keys(canary.on)).toEqual(["workflow_dispatch"]);
    expect(canary.on.workflow_run).toBeUndefined();
  });

  test("the canary reads its ladder from the repository variables", () => {
    // A `workflow_dispatch` input WITH a default is always populated, so
    // `github.event.inputs.startPercent` would be "5" even when the dispatcher
    // passed nothing, and the literal in the workflow file would win over
    // CANARY_START_PERCENT. That is how a deployment's own canary ladder
    // stops being read, silently, the first time the canary is dispatched
    // instead of triggered.
    const inputs = canary.on.workflow_dispatch.inputs;
    for (const key of ["startPercent", "midPercent", "soakSeconds"]) {
      expect(inputs[key].default).toBeUndefined();
    }

    // ...and the variables are still what the step falls back to.
    expect(canaryRaw).toContain("github.event.inputs.startPercent || env.CANARY_START_PERCENT");
    expect(canaryRaw).toContain("github.event.inputs.midPercent || env.CANARY_MID_PERCENT");
    expect(canaryRaw).toContain("github.event.inputs.soakSeconds || env.CANARY_SOAK_SECONDS");
    expect(canary.env.CANARY_START_PERCENT).toContain("vars.CANARY_START_PERCENT");
  });

  test("the canary queues behind the deploy instead of interleaving with it", () => {
    // The canary run is created while the deploy still holds the group, so it
    // waits. A canary that widened while the roll that staged it was still
    // running would be two releases fighting over the traffic pointer — the
    // 2026-10-21 incident.
    expect(canary.concurrency.group).toBe(deploy.concurrency.group);
    expect(canary.concurrency["cancel-in-progress"]).toBe(false);
  });
});

describe("the release path that reaches the deploy still works", () => {
  test("the release dispatches the deploy with the tag it just published", () => {
    // The tag is the input that makes the release path reachable at all: the
    // deploy used to choose its path from a field that only exists on a
    // `workflow_run` event, so every manual dispatch took the branch path and
    // the published image could not be rolled by any means.
    expect(releaseRaw).toContain("gh workflow run deploy.yml");
    expect(releaseRaw).toContain('-f "tag=${GITHUB_REF_NAME}"');
    expect(release.permissions["actions"]).toBe("write");
  });

  test("the deploy accepts that tag", () => {
    expect(deploy.on.workflow_dispatch.inputs.tag).toBeTruthy();
  });
});
