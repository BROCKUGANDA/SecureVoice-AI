/**
 * The coverage ratchet — pure, so the rule that gates the ladder can be tested
 * without running the suite.
 *
 * WHY. The overall bar has been argued about twice in one day. It was lowered to
 * 65 in the first place with a NOTE saying the real figure is 85 (the pilot
 * acceptance threshold from the 2026-10-08 requirement run) and that it should be
 * raised "as views land" — which is a sentence nobody can obey a month later,
 * because nothing recorded where the climb had got to. A one-off number in a
 * workflow file is exactly what drifts: it gets lowered to pass, and never raised
 * back.
 *
 * So the bar is not a constant, it is the highest coverage actually measured and
 * committed. That makes the property enforceable: coverage may go up, and it may
 * not come down. `COVERAGE_TARGET` (85) is carried in the same file as the floor
 * so the destination is printed on every run instead of living in someone's memory.
 *
 * Deliberately NOT the design: CI committing the new floor itself. That needs
 * `contents: write` on a verify job, would push to a branch the same workflow
 * triggers on, and turns a coverage report into a self-sustaining loop of runs.
 * The bump is a one-line edit in the PR that raised coverage, and the gate prints
 * the exact line to change.
 */

export const COVERAGE_TARGET = 85;

/** Where the committed floor lives. `evidence/` is tracked; `coverage/` is not. */
export const FLOOR_FILE = "evidence/coverage-floor.json";

/**
 * Slack above the recorded floor before a bump is demanded. Wall-clock coverage
 * moves by fractions of a point as tests are added or files are renamed; asking
 * for a commit on every 0.01% would make the gate noise.
 */
export const BUMP_STEP = 0.25;

export function pct(hit, total) {
  return total > 0 ? (hit / total) * 100 : 0;
}

/**
 * Parse the floor file. Returns `{ floor }` or `{ error }` — a missing or
 * malformed floor is reported as such rather than treated as "floor is 0", because
 * a ratchet that silently resets to zero is a ratchet that stopped existing.
 */
export function parseFloor(raw) {
  if (raw === null || raw === undefined)
    return { error: `${FLOOR_FILE} is missing — record the measured coverage there` };
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { error: `${FLOOR_FILE} is not valid JSON: ${String(e).slice(0, 120)}` };
  }
  if (typeof doc?.overall !== "number" || !Number.isFinite(doc.overall))
    return { error: `${FLOOR_FILE}.overall must be a finite number` };
  if (typeof doc.at !== "string" || !/^[0-9a-f]{7,40}$/.test(doc.at))
    return {
      error: `${FLOOR_FILE}.at must be the commit the floor was MEASURED at — a floor without a commit is a mood, not a fact`,
    };
  if (doc.overall < 0 || doc.overall > 100)
    return { error: `${FLOOR_FILE}.overall is a percentage` };
  return { floor: { overall: doc.overall, at: doc.at, target: doc.target ?? COVERAGE_TARGET } };
}

/**
 * The one decision the gate makes, as data.
 *
 * `bar` is max(mergeBar, floor): the historical 65 is a floor of its own, and the
 * ratchet can only ever raise it. `failReason` is set only when the measurement is
 * below that bar — never because coverage went up.
 *
 * `blocking` preserves today's gating topology. CI sets the merge bar only on a PR
 * into `main` (`ci.yml:435`); dev and staging runs are report-only. The ratchet
 * bites where a merge is gated and is only *reported* elsewhere, because turning a
 * report-only run into a blocker changes what can stop a promotion, and that is not
 * this file's call. A dip below the floor in a report-only run is a warning that
 * says it will bite at `main`.
 */
export function evaluateCoverage({ measured, hit, total, mergeBar, raw, blocking = true }) {
  const parsed = parseFloor(raw);
  if (parsed.error) {
    return {
      bar: mergeBar,
      floor: null,
      failReason: blocking ? parsed.error : null,
      warnReason: blocking ? null : `${parsed.error} (report-only here)`,
      gapToTarget: 0,
      gapToTargetLines: 0,
      bump: null,
      target: COVERAGE_TARGET,
    };
  }
  const floor = parsed.floor;
  const bar = mergeBar > 0 ? Math.max(mergeBar, floor.overall) : floor.overall;
  // Tolerance for the fact that a floor is stored rounded to two decimals while the
  // measurement is not. Comparing `65.08` against a measured 65.0778 would fail the
  // run that recorded it — a ratchet that turns red on its own commit is a ratchet
  // somebody deletes.
  const below = measured < bar - 0.005;
  const detail =
    `overall ${measured.toFixed(2)}% is below the ${bar.toFixed(2)}% bar ` +
    `(floor ${floor.overall.toFixed(2)}% recorded at ${floor.at}, merge bar ${mergeBar}%)`;

  const gapToTarget = Math.max(0, floor.target - measured);
  const gapToTargetLines = Math.max(0, Math.ceil((floor.target / 100) * total) - hit);

  const bump =
    measured >= floor.overall + BUMP_STEP
      ? `coverage is ${(measured - floor.overall).toFixed(2)}pt above the floor — raise ` +
        `${FLOOR_FILE} in this PR to {"overall": ${measured.toFixed(2)}, "at": "<this commit>", "target": ${floor.target}}`
      : null;

  return {
    bar,
    floor,
    failReason:
      below && blocking
        ? `${detail}. Coverage may rise; to lower the bar deliberately, edit ${FLOOR_FILE} and say why.`
        : null,
    warnReason: below && !blocking ? `${detail} — this will block the merge into main` : null,
    gapToTarget,
    gapToTargetLines,
    bump,
    target: floor.target,
  };
}
