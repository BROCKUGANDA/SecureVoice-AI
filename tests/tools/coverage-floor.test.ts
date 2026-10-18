/**
 * The coverage ratchet must be able to fail, and must not be able to lie.
 *
 * WHY. The merge bar for `main` was a single number in `ci.yml`, and it had already
 * been lowered once with a comment promising to raise it back toward 85 — a promise
 * nothing enforced, which is how a gate ends up at whatever value last let a build
 * pass. The floor in `evidence/coverage-floor.json` replaces that with the highest
 * coverage actually measured and committed.
 *
 * Three properties, none of which the old shape had:
 *   A. It is a property of a commit. `at` must be a real sha, and the recorded
 *      number must be ≤ what a run measured. A floor copied from an editor is the
 *      failure this repo has already documented once this week.
 *   B. A missing or malformed floor FAILS in a blocking context. The obvious wrong
 *      answer is to treat "no floor" as "floor is 0", which reads as a pass and
 *      silently deletes the ratchet — the same shape as a scan that matches nothing.
 *   C. Coverage rising never fails. A gate that goes red when the number improves
 *      is turned off within a sprint.
 *
 * `evaluateCoverage` is pure, so every case here is a call, not a fixture copied
 * from the implementation: the numbers are the ones CI reported for `8fef2be`, and
 * the gap arithmetic is checked against long division rather than against the code.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  BUMP_STEP,
  COVERAGE_TARGET,
  FLOOR_FILE,
  evaluateCoverage,
  parseFloor,
} from "../../scripts/coverage-floor.mjs";

const read = (p: string) => readFileSync(resolve(p), "utf8");

// The real measurement this floor was written from: 49,845 of 76,591 lines.
const MEASURED = { measured: 65.0779, hit: 49845, total: 76591 };
const FLOOR_JSON = read(FLOOR_FILE);

test("the committed floor is a fact about a commit, not a number in a file", () => {
  expect(existsSync(resolve(FLOOR_FILE))).toBe(true);
  const parsed = parseFloor(FLOOR_JSON);
  expect(parsed.error ?? "").toBe("");
  const doc = JSON.parse(FLOOR_JSON);

  // `at` must name a commit that is an ANCESTOR of the tree running this test.
  //
  // Existence was the original, weaker check — and it was not merely weak, it was
  // self-validating. Under `actions/checkout`'s default `fetch-depth: 1` a working
  // tree holds exactly one commit, HEAD, so the object resolved on precisely the one
  // run whose HEAD *was* the recorded sha, and went red on the run after it. CI now
  // fetches full history for this job (see `fetch-depth: 0` in ci.yml). Reachability
  // is the claim the floor genuinely makes: this number came from a run inside the
  // history being merged, not from a name typed into a file.
  expect(doc.at).toMatch(/^[0-9a-f]{7,40}$/);

  const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
    encoding: "utf8",
  }).trim();
  if (shallow === "true") {
    // Fails rather than skipping: a floor nobody can trace back to a measurement is
    // the exact thing this file exists to refuse.
    throw new Error(
      "checkout is shallow, so the floor's commit cannot be resolved. Run this suite " +
        "from a full clone (CI uses actions/checkout with fetch-depth: 0).",
    );
  }

  const type = execFileSync("git", ["cat-file", "-t", doc.at], { encoding: "utf8" }).trim();
  expect(type).toBe("commit");
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", doc.at, "HEAD"], {
    encoding: "utf8",
  });
  expect(ancestor.status).toBe(0);

  expect(typeof doc.overall).toBe("number");
  expect(doc.overall).toBeGreaterThan(0);
  expect(doc.overall).toBeLessThanOrEqual(100);
  // The recorded measurement must reproduce the recorded percentage, so a hand-edited
  // `overall` that disagrees with its own hit/total is caught here rather than in CI.
  if (doc.measured) {
    const recomputed = (doc.measured.hit / doc.measured.total) * 100;
    expect(Math.abs(recomputed - doc.overall)).toBeLessThan(0.01);
  }
});

test("A. the target is the 85 the requirement set, and the gap is stated in lines", () => {
  const doc = JSON.parse(FLOOR_JSON);
  expect(doc.target).toBe(COVERAGE_TARGET);

  const v = evaluateCoverage({ ...MEASURED, mergeBar: 65, raw: FLOOR_JSON, blocking: true });
  expect(v.target).toBe(85);
  // 85% of 76,591 is 65,102.35 -> 65,103 covered lines; 65,103 - 49,845 = 15,258.
  // Asserted against arithmetic, not against whatever the code returns.
  expect(Math.ceil((85 / 100) * MEASURED.total) - MEASURED.hit).toBe(15258);
  expect(v.gapToTargetLines).toBe(15258);
  expect(v.gapToTarget).toBeGreaterThan(19);
});

test("B. a missing or malformed floor fails loudly, never as zero", () => {
  const missing = evaluateCoverage({ ...MEASURED, mergeBar: 65, raw: null, blocking: true });
  expect(missing.failReason).toContain("missing");
  // The specific wrong shortcut: no floor reading as `need 0%`.
  expect(missing.bar).toBe(65);
  expect(missing.floor).toBe(null);

  const garbage = evaluateCoverage({ ...MEASURED, mergeBar: 65, raw: "{not json", blocking: true });
  expect(garbage.failReason).toContain("not valid JSON");

  const noCommit = evaluateCoverage({
    ...MEASURED,
    mergeBar: 65,
    raw: JSON.stringify({ overall: 65.08, at: "my laptop" }),
    blocking: true,
  });
  expect(noCommit.failReason).toMatch(/measured/i);

  const negative = parseFloor(JSON.stringify({ overall: -3, at: "abcdef1" }));
  expect(negative.error).toContain("percentage");
});

test("the bar is max(merge bar, floor): the ratchet can raise it and nothing can quietly lower it", () => {
  const atFloor = evaluateCoverage({ ...MEASURED, mergeBar: 65, raw: FLOOR_JSON, blocking: true });
  expect(atFloor.bar).toBe(65.08);
  expect(atFloor.failReason).toBeNull();

  // A merge bar above the floor still governs; the floor only ever adds a minimum.
  const high = evaluateCoverage({ ...MEASURED, mergeBar: 70, raw: FLOOR_JSON, blocking: true });
  expect(high.bar).toBe(70);
  expect(high.failReason).toContain("below the 70.00% bar");

  // And a floor above a *lowered* merge bar keeps the old high-water mark: this is
  // the case the constant in ci.yml could not express.
  const lowered = evaluateCoverage({
    ...MEASURED,
    mergeBar: 60,
    raw: JSON.stringify({ overall: 65.08, at: "abcdef1", target: 85 }),
    blocking: true,
  });
  expect(lowered.bar).toBe(65.08);
  expect(lowered.failReason).toBeNull();
});

test("C. regression fails and improvement never does", () => {
  const regression = evaluateCoverage({
    measured: 64.0,
    hit: 49000,
    total: 76591,
    mergeBar: 65,
    raw: FLOOR_JSON,
    blocking: true,
  });
  expect(regression.failReason).toContain("below the 65.08% bar");
  expect(regression.failReason).toContain("8fef2be");

  const improvement = evaluateCoverage({
    measured: 71.5,
    hit: 54762,
    total: 76591,
    mergeBar: 65,
    raw: FLOOR_JSON,
    blocking: true,
  });
  expect(improvement.failReason).toBeNull();
  expect(improvement.bump).toContain("raise");
  expect(improvement.bump).toContain("71.50");

  // Two decimals of tolerance: a floor stored as 65.08 must not fail a run that
  // measured 65.0779, or the ratchet turns red on the commit that recorded it.
  expect(
    evaluateCoverage({ ...MEASURED, mergeBar: 65, raw: FLOOR_JSON, blocking: true }).failReason,
  ).toBeNull();
  expect(
    evaluateCoverage({
      measured: 65.07,
      hit: 49844,
      total: 76591,
      mergeBar: 65,
      raw: FLOOR_JSON,
      blocking: true,
    }).failReason,
  ).toContain("below");
});

test("a report-only run warns and does not block", () => {
  // The ratchet bites where a merge is gated. Dev and staging keep today's
  // topology; they just learn what will happen at main.
  const belowOnDev = evaluateCoverage({
    measured: 60,
    hit: 45954,
    total: 76591,
    mergeBar: 0,
    raw: FLOOR_JSON,
    blocking: false,
  });
  expect(belowOnDev.failReason).toBeNull();
  expect(belowOnDev.warnReason).toContain("will block the merge into main");

  const missingOnDev = evaluateCoverage({
    measured: 60,
    hit: 45954,
    total: 76591,
    mergeBar: 0,
    raw: null,
    blocking: false,
  });
  expect(missingOnDev.failReason).toBeNull();
  expect(missingOnDev.warnReason).toContain("missing");
});

test("the bump is demanded only above a real step, so the floor does not churn", () => {
  const tiny = evaluateCoverage({
    measured: 65.08 + BUMP_STEP / 2,
    hit: 49846,
    total: 76591,
    mergeBar: 65,
    raw: FLOOR_JSON,
    blocking: true,
  });
  expect(tiny.bump).toBeNull();

  const real = evaluateCoverage({
    measured: 65.08 + BUMP_STEP,
    hit: 49900,
    total: 76591,
    mergeBar: 65,
    raw: FLOOR_JSON,
    blocking: true,
  });
  expect(real.bump).not.toBeNull();
});

test("coverage.mjs consumes the verdict instead of its own copy of the rule", () => {
  // The rule and the caller must not be two implementations of one decision. If
  // coverage.mjs starts comparing against THRESHOLDS.overall for the overall tier
  // again, the floor stops existing while still looking configured.
  const src = read("scripts/coverage.mjs");
  expect(src).toContain('from "./coverage-floor.mjs"');
  expect(src).toContain("evaluateCoverage(");
  expect(src).toContain("verdict.failReason");
  expect(src).toContain("overallBar");
  expect(src).not.toMatch(/const need = THRESHOLDS\[name\]/);
});
