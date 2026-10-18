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
 *   A. It is auditable on the rung that enforces it. Squash promotions mean the commit
 *      that measured the floor is not reachable from staging or main, so provenance is
 *      proved from this branch's own blob history: the floor never went down, HEAD holds
 *      the peak, and what is on disk is what is committed.
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
  evaluateFloorHistory,
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

  // ── What a rung can actually prove ──────────────────────────────────────────
  //
  // `at` is provenance for a human, and its FORMAT is all a checkout can verify.
  // dev -> staging and staging -> main are squash promotions, so the commit that
  // measured the number is not an ancestor of staging or main — measured
  // 2026-10-18: `8fef2be` is an ancestor of dev and of nothing else. That is also
  // why the assertion this line replaced was not merely weak but vacuous: under
  // `actions/checkout`'s default `fetch-depth: 1` the only commit a checkout holds
  // is HEAD, so `cat-file` succeeded exactly once — on the run that recorded the
  // floor — and reddened the run after it. A check that can be true on one commit
  // is not a gate; it is a timestamp.
  expect(doc.at).toMatch(/^[0-9a-f]{7,40}$/);

  // The handle that does survive a squash is the Actions run id. Confirming it
  // belongs to the API rather than the working tree; tracked in the gap register.
  expect(Number.isInteger(doc.measured?.runId)).toBe(true);

  // What is on disk must be what is committed, or every assertion below describes a
  // number nobody merged — the floor is a bar, so an uncommitted edit here is the
  // cheapest way to make a red build look green.
  const atHead = execFileSync("git", ["show", `HEAD:${FLOOR_FILE}`], { encoding: "utf8" });
  expect(atHead).toBe(FLOOR_JSON);

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

test("the floor only ever rose, read from this branch's own history of the file", () => {
  // The ratchet restated in a form every rung can check: not "trust the sha I cite"
  // but "walk the blob this branch actually carries and prove it never went down".
  //
  // A shallow checkout cannot answer this, and "cannot answer" must not degrade into
  // a silent pass, so a shallow tree fails with the reason instead of asserting
  // anything. The `verify` job checks out with `fetch-depth: 0` for exactly this.
  const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
    encoding: "utf8",
  }).trim();
  if (shallow === "true")
    throw new Error(
      `${FLOOR_FILE} history needs full depth and this checkout is shallow (CI: actions/checkout with fetch-depth: 0)`,
    );

  const shas = execFileSync("git", ["log", "--format=%H", "--", FLOOR_FILE], { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  expect(shas.length).toBeGreaterThan(0);

  const entries = shas.map((sha) => {
    const raw = spawnSync("git", ["show", `${sha}:${FLOOR_FILE}`], { encoding: "utf8" }).stdout;
    let overall: number | null = null;
    try {
      const v = JSON.parse(raw).overall;
      if (typeof v === "number" && Number.isFinite(v)) overall = v;
    } catch {
      overall = null;
    }
    return { at: sha, overall };
  });

  const verdict = evaluateFloorHistory(entries);
  expect(verdict.error ?? "").toBe("");
  // HEAD holds the highest figure ever recorded on this branch — otherwise the bar
  // in force is not the ratchet, whatever the sequence above looked like.
  expect(verdict.peak).toBe(JSON.parse(FLOOR_JSON).overall);
});

test("B2. the history ratchet is capable of failing", () => {
  // Pure controls. Proving a red against real history would mean committing a fake
  // regression, which is not something to do to a shared branch.
  expect(evaluateFloorHistory([{ at: "aaaaaaa", overall: 65.08 }]).error).toBe(null);
  expect(
    evaluateFloorHistory([
      { at: "bbbbbbb", overall: 66.1 },
      { at: "aaaaaaa", overall: 65.08 },
    ]).error,
  ).toBe(null);
  expect(
    evaluateFloorHistory([
      { at: "bbbbbbb", overall: 65.08 },
      { at: "aaaaaaa", overall: 66.1 },
    ]).error,
  ).toContain("the floor went down");
  // Equal values across commits are rounding, not a dip.
  expect(
    evaluateFloorHistory([
      { at: "bbbbbbb", overall: 65.08 },
      { at: "aaaaaaa", overall: 65.08 },
    ]).error,
  ).toBe(null);
  expect(evaluateFloorHistory([]).error).toContain("no history");
  expect(evaluateFloorHistory([{ at: "aaaaaaa", overall: null }]).error).toContain(
    "no parseable floor",
  );
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
