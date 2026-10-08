/* eslint-disable @typescript-eslint/no-require-imports -- .cjs config; CommonJS require() is correct here. */
/**
 * Jest harness — component tier.
 *
 * WHY THIS EXISTS ALONGSIDE `bun test`
 * -----------------------------------
 * `bun run test` (scripts/run-tests.mjs) cannot render client React components:
 * Bun's test runner has no DOM, so nothing under `src/views/**` is ever executed
 * by it, and scripts/coverage.mjs scored that whole tier at 0.00% (0 of 8445
 * lines) on a suite that was otherwise passing. Jest + jsdom +
 * @testing-library/react is the tier that can mount them.
 *
 * THE TWO RUNNERS MUST NOT DOUBLE-COUNT
 * ------------------------------------
 * `bun test` globs every `.test.ts` under `tests/`, at any depth. Jest's
 * testMatch below is `<rootDir>/tests-jest/` and the specs are `.test.tsx`, so
 * neither runner can claim a file the other owns — by directory AND by
 * extension.
 *
 * COVERAGE GOES TO THE SAME GATE
 * ------------------------------
 * next/jest's tsconfig `paths` handling means `@/…` resolves without a
 * hand-written moduleNameMapper. `coverageDirectory` is the FIXED path
 * `coverage/jest/`, and scripts/coverage.mjs reads `coverage/jest/lcov.info`
 * from it. `collectCoverageFrom` is deliberately scoped to the e2e tier —
 * `src/views/**` plus the app entry files — which per coverage.mjs's `tierOf()`
 * is exactly the set of paths assigned to `e2e`. Two consequences, both wanted:
 *   · Jest can only ADD coverage to the tier that was empty. It cannot move the
 *     unit or integration numbers in either direction, so this harness cannot
 *     silently weaken the gate it is supposed to feed.
 *   · Files Jest never instruments stay scored by coverage.mjs's own
 *     approximate-lines fallback, so the denominator for untested views does not
 *     change.
 * If you later add Jest specs for `src/lib/**`, widen `collectCoverageFrom` —
 * and re-check the unit tier, because the two runners measure line sets
 * differently and the merged denominator will move.
 */
const nextJest = require("next/jest");

const createJestConfig = nextJest({
  // Load next.config.ts and the .env files the components read at import time.
  dir: "./",
});

/** @type {import('jest').Config} */
const config = {
  displayName: "views",
  testEnvironment: "jsdom",
  /**
   * v8, not babel — and the reason is comparability, not speed. `bun test
   * --coverage` (the other half of scripts/coverage.mjs) is V8 block coverage, so
   * a `DA:` line written by Jest's v8 provider and one written by Bun mean the
   * same thing and merge without a scale mismatch. The babel/istanbul provider
   * counts only statement-bearing lines, which for a JSX-heavy view collapses
   * src/views/Demo.tsx from 1482 lines to 238 — the merged tier denominator
   * would silently shrink by a third and the percentage would stop being
   * comparable to the unit tier.
   *
   * Disclosed bias, because it is real: V8 coverage marks every line inside an
   * executed range as covered, which credits blank lines and closing braces, and
   * a component whose body is one giant JSX tree reaches ~100% lines from a
   * single successful render. Line coverage is a reachability measure and has
   * always been one in this gate; it is not evidence of behaviour. The behaviour
   * is in the assertions, and only `bun run test:jest` runs those.
   */
  coverageProvider: "v8",
  setupFilesAfterEnv: ["<rootDir>/tests-jest/setup.ts"],

  // Directory + extension both differ from the `bun test` glob — see header.
  roots: ["<rootDir>/tests-jest"],
  testMatch: ["<rootDir>/tests-jest/**/*.test.(ts|tsx)"],

  collectCoverage: true,
  coverageDirectory: "<rootDir>/coverage/jest",
  // `lcovonly`, not `lcov`: the plain `lcov` reporter also emits an
  // lcov-report/ tree of vendored JS, and `bun run lint` (eslint .) does not
  // read .gitignore, so that tree would be linted as if it were source.
  coverageReporters: ["lcovonly", "json", "json-summary", "text-summary"],
  collectCoverageFrom: ["src/views/**/*.tsx", "src/app/page.tsx", "src/app/layout.tsx"],

  clearMocks: true,
  testTimeout: 20000,
};

module.exports = createJestConfig(config);
