/**
 * UNIT — one CI build per commit, and main still gets the proof production deploys from.
 *
 * `ci.yml` used to fire on BOTH `push` to [dev, staging, main] and `pull_request` into those same
 * branches, while promote.yml opens a PR for every push. So every promotion commit ran the full
 * suite twice on a two-runner box that also serves production. Measured 2026-10-20
 * (docs/GAP-REGISTER.md §59): 30.77 GB of build cache in 66 entries, NONE older than six hours,
 * the six largest near-identical 2.691 GB copies of the same layers; runs 39337233039 (`push`) and
 * 39337237289 (`pull_request`) both executing SHA `c43cd38`. A later push cancelled one of them
 * and Deploy 39346234640 correctly refused the `cancelled` run — a red deploy whose only meaning
 * was the duplication.
 *
 * The dedupe is a trigger restriction, so this is a declarative check of the trigger lists. That
 * is deliberate: the first attempt used a workflow-level `if:` expression, and GitHub rejected the
 * whole document — run 39357023040, `conclusion: failure`, `jobs: []` — so this file also pins the
 * ABSENCE of that key, because it is the shape that broke CI for a commit and would do so again.
 *
 * These assertions read the shipped YAML. They do not reimplement Actions' evaluation engine, and
 * they cannot: `branches` filters are matched by GitHub. `rhysd/actionlint`, run by CI itself, is
 * what proves the document is a valid workflow; what this proves is which events start a build.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

const ROOT = join(import.meta.dir, "..", "..");
const load = (file: string) =>
  YAML.parse(readFileSync(join(ROOT, ".github/workflows", file), "utf8"));

// `on:` is a YAML 1.1 boolean keyword. The `yaml` package parses it under the 1.2 core schema, so
// the key arrives as the string "on"; asserting that here rather than assuming it, because a
// parser that read it as `true` would silently make every assertion below vacuous.
const ci = load("ci.yml");
const triggers = ci.on ?? ci[true as unknown as string];

describe("CI triggers — one build per commit", () => {
  test("`on:` parses as a map, not as a YAML boolean", () => {
    expect(triggers).toBeTypeOf("object");
    expect(triggers.push).toBeDefined();
    expect(triggers.pull_request).toBeDefined();
  });

  test("push starts a build on main only", () => {
    expect(triggers.push.branches).toEqual(["main"]);
    // The pre-fix value, named rather than implied: a push to dev or staging used to build here.
    expect(triggers.push.branches).not.toContain("dev");
    expect(triggers.push.branches).not.toContain("staging");
  });

  test("every rung is still gated, by the pull request that rung opens", () => {
    expect([...triggers.pull_request.branches].sort()).toEqual(["dev", "main", "staging"]);
  });

  test("a workflow-level `if:` stays forbidden", () => {
    // GitHub has no such key on the workflow document. Shipping one does not skip the run — it
    // fails to compile it, and every push to main then has no proving CI run for deploy.yml to
    // trust, which is production silently not deploying.
    expect(ci.if).toBeUndefined();
    for (const key of ["if", "condition"]) expect(Object.hasOwn(ci, key)).toBe(false);
  });

  test("the rungs do lose a trigger, so promote.yml must still be the thing that opens them", () => {
    // This is the dependency the dedupe buys into: dev and staging get their gate because a push
    // there produces a PR. If promote.yml stopped firing on those pushes, the rung would go dark
    // rather than merely un-duplicated.
    const promote = load("promote.yml");
    expect([...promote.on.push.branches].sort()).toEqual(["dev", "staging"]);
  });

  test("main's proof chain survives", () => {
    // deploy.yml and autoversion.yml both key on `workflow_run: CI` for main, and the squash merge
    // onto main emits no pull_request — so main's push trigger is the only proving run there is.
    expect(triggers.push.branches).toContain("main");
    for (const file of ["deploy.yml", "autoversion.yml"]) {
      const wf = load(file);
      expect(wf.on.workflow_run.workflows).toContain("CI");
      expect(wf.on.workflow_run.branches).toContain("main");
    }
  });

  test("cancellation stays narrow, so a required check cannot be cancelled into a red gate", () => {
    // Widening the group to the commit SHA would let a push and a PR race again; the loser reads
    // `cancelled`, which is exactly how the ladder parked before this fix.
    expect(ci.concurrency.group).toBe("ci-${{ github.ref }}");
    expect(ci.concurrency["cancel-in-progress"]).toBe(true);
  });

  test("the job `if:` clauses carry no copy of the dedupe rule", () => {
    // The rule lives in the trigger list. A second copy in five job conditions is the drift
    // pattern §55 documents, and it would also be the only way to reintroduce the race.
    const offenders: string[] = [];
    for (const [id, job] of Object.entries<any>(ci.jobs)) {
      const clause = String(job.if ?? "");
      if (clause.includes("github.ref ==") || clause.includes("'push'")) offenders.push(id);
    }
    expect(offenders).toEqual([]);
  });

  test("a YAML that does not parse fails this file rather than passing it", () => {
    // The empty-clause trap from every parser in this repository: a read that yields nothing must
    // not look like a pass. `on:` absent would make the assertions above compare against undefined.
    expect(() => {
      const missing = { jobs: {} } as any;
      const t = missing.on ?? missing[true as unknown as string];
      if (!t?.push?.branches) throw new Error("the CI trigger list is unreadable");
    }).toThrow(/unreadable/);
    expect(triggers.push.branches.length).toBeGreaterThan(0);
  });
});
