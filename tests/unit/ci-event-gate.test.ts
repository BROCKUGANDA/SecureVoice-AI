/**
 * UNIT — the CI event gate: one build per commit, and main still gets its proof.
 *
 * Why this file exists. `ci.yml` triggers on BOTH `push` to [dev, staging, main] and
 * `pull_request` into those branches, and promote.yml opens a PR for every push — so every
 * promotion commit ran the whole suite twice on a two-runner box that also serves production.
 * Measured 2026-10-20 (docs/GAP-REGISTER.md §59): 30.77 GB of build cache in 66 entries, NONE
 * older than six hours, the six largest being near-identical 2.691 GB copies of the same
 * layers; runs 39337233039 (`push`) and 39337237289 (`pull_request`) on the same SHA
 * `c43cd38`. A later push then cancelled one of them, and Deploy 39346234640 correctly refused
 * to ship the `cancelled` run — a red deploy that meant nothing was wrong except duplication.
 *
 * The gate is stated once, at the workflow level, rather than repeated in five job `if:`
 * clauses. So this test reads the SHIPPED expression out of the YAML and evaluates it instead
 * of restating the rule: a test that hardcodes what it is checking keeps passing after someone
 * deletes it from the workflow.
 *
 * The evaluator handles exactly the shape a GitHub `if:` clause is allowed to have here — a
 * disjunction of equality terms over context keys and quoted literals — and THROWS on anything
 * else. That is deliberate and is what makes this test honest: if the clause grows a function
 * call, a `&&`, or a `startsWith(...)`, the test fails loudly rather than quietly evaluating a
 * different rule than the one shipping. It is not a reimplementation of Actions' expression
 * engine; `rhysd/actionlint`, run by CI itself, is what proves the file is a valid workflow.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

const ROOT = join(import.meta.dir, "..", "..");
const load = (file: string) =>
  YAML.parse(readFileSync(join(ROOT, ".github/workflows", file), "utf8"));

const ci = load("ci.yml");

/** The workflow-level `if:` as shipped, folded to one line by the YAML parser. */
const gate: string = String(ci.if);

type Context = Record<string, string>;

function operand(token: string, ctx: Context): string {
  const t = token.trim();
  const quoted = /^'([^']*)'$/.exec(t)?.[1];
  if (quoted !== undefined) return quoted;
  const fromContext = ctx[t];
  if (fromContext !== undefined) return fromContext;
  throw new Error(`unsupported operand in the shipped CI expression: ${t}`);
}

function term(text: string, ctx: Context): boolean {
  const parts = /^\s*(.+?)\s*(!=|==)\s*(.+?)\s*$/.exec(text);
  const lhsText = parts?.[1];
  const operator = parts?.[2];
  const rhsText = parts?.[3];
  if (!lhsText || !operator || !rhsText) {
    throw new Error(`unsupported term in the shipped CI expression: ${text}`);
  }
  const lhs = operand(lhsText, ctx);
  const rhs = operand(rhsText, ctx);
  return operator === "==" ? lhs === rhs : lhs !== rhs;
}

/**
 * Evaluate a disjunction of comparison terms. No code generation: the shipped text selects
 * values, it never becomes a program.
 */
function gateAllows(event: string, ref: string, expr: string = gate): boolean {
  const ctx: Context = { "github.event_name": event, "github.ref": ref };
  const terms = expr
    .split("||")
    .map((s) => s.trim())
    .filter(Boolean);
  if (terms.length === 0) throw new Error("the CI expression reads as nothing — refusing to pass");
  return terms.some((t) => term(t, ctx));
}

const push = (branch: string) => ["push", `refs/heads/${branch}`] as const;

describe("CI event gate", () => {
  test("the gate is stated once, at the workflow level", () => {
    expect(gate.length).toBeGreaterThan(0);
    // No job may carry its own copy of the dedupe clause — five copies of one rule is the drift
    // pattern §55 was written about. Names are collected so a failure says WHICH job diverged.
    const offenders: string[] = [];
    for (const [id, job] of Object.entries<any>(ci.jobs)) {
      const clause = String(job.if ?? "");
      if (clause.includes("github.ref ==") || clause.includes("'push'")) offenders.push(id);
    }
    expect(offenders).toEqual([]);
  });

  test("a push to dev or staging does not build — the PR run is the gate", () => {
    expect(gateAllows(...push("dev"))).toBe(false);
    expect(gateAllows(...push("staging"))).toBe(false);
  });

  test("every other path still builds", () => {
    expect(gateAllows(...push("main"))).toBe(true);
    expect(gateAllows("pull_request", "refs/pull/161/merge")).toBe(true);
    expect(gateAllows("pull_request", "refs/pull/164/merge")).toBe(true);
    expect(gateAllows("workflow_dispatch", "refs/heads/dev")).toBe(true);
  });

  test("main keeps its push trigger, because a squash merge emits no pull_request", () => {
    // deploy.yml and autoversion.yml key on `workflow_run: CI` for main. Suppressing main's
    // push too would leave the commit that only ever exists on main with no proving run, and
    // production would silently stop deploying — the failure looking like CI idleness.
    expect(ci.on.push.branches).toContain("main");
    expect(gateAllows(...push("main"))).toBe(true);
    const deploy = load("deploy.yml");
    expect(deploy.on.workflow_run.workflows).toContain("CI");
    expect(deploy.on.workflow_run.branches).toContain("main");
  });

  test("both triggers remain declared, because the fix is the gate and not a deleted edge", () => {
    // Removing `pull_request` from ci.yml would make the ladder single-build AND ungated.
    expect(ci.on.push.branches).toEqual(["dev", "staging", "main"]);
    expect(ci.on.pull_request.branches.sort()).toEqual(["dev", "main", "staging"]);
  });

  test("cancellation stays narrow, so no required check can be cancelled into a red gate", () => {
    // Widening the group to the commit SHA would race a push run against a PR run again, and
    // the loser would read `cancelled` — which is how the ladder parked before this fix.
    expect(ci.concurrency.group).toBe("ci-${{ github.ref }}");
    expect(ci.concurrency["cancel-in-progress"]).toBe(true);
  });

  test("the evaluator refuses to silently mis-read a changed clause", () => {
    // The three shapes below are what a future edit would have to introduce to break this test
    // by accident rather than on purpose, and each must throw instead of returning a verdict.
    expect(() =>
      gateAllows("push", "refs/heads/x", "startsWith(github.ref, 'refs/heads/')"),
    ).toThrow(/unsupported term/);
    // `&&` survives the `||` split as one term whose right-hand side is not a single operand,
    // so it is caught as an unreadable operand rather than an unreadable term. Either way it
    // throws: what must never happen is a verdict from a clause this file cannot parse.
    expect(() =>
      gateAllows("push", "refs/heads/x", "github.event_name != 'push' && github.ref"),
    ).toThrow(/unsupported operand/);
    expect(() => gateAllows("push", "refs/heads/x", "github.event_name != inputs.branch")).toThrow(
      /unsupported operand/,
    );
    expect(() => gateAllows("push", "refs/heads/x", "   ")).toThrow(/reads as nothing/);
  });

  test("the gate is capable of failing, in both directions", () => {
    const dropBranchQualification = "github.event_name != 'pull_request'";
    // The naive form runs CI on every push — i.e. it reinstates the duplicate build — so it
    // must DISAGREE with the shipped clause on a push to dev, not merely differ in text.
    expect(gateAllows("push", "refs/heads/dev", dropBranchQualification)).toBe(true);
    expect(gateAllows(...push("dev"))).toBe(false);

    const suppressMainToo = "github.event_name != 'push'";
    // And the over-correction that would stop production deploying must disagree on main.
    expect(gateAllows("push", "refs/heads/main", suppressMainToo)).toBe(false);
    expect(gateAllows(...push("main"))).toBe(true);
  });
});
