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
 * from it. `collectCoverageFrom` includes the e2e views and auth client forms.
 * The auth forms remain in coverage.mjs's unit tier: jsdom is needed to exercise
 * their browser interactions, but the tier and thresholds do not change.
 * Files outside this list retain coverage.mjs's whole-source denominator.
 */
const nextJest = require("next/jest");

const createJestConfig = nextJest({
  // Load next.config.ts and the .env files the components read at import time.
  dir: "./",
});

/** @type {import('jest').Config} */
const config = {
  displayName: "views",
  // jsdom plus the WHATWG fetch globals, so `src/lib/auth-client.ts` can build an
  // auth client inside a test. Plain `jsdom` made every suite that renders the
  // console die at import; see tests-jest/environment-jsdom-fetch.cjs for why this
  // is a realm bridge and not a polyfill.
  testEnvironment: "<rootDir>/tests-jest/environment-jsdom-fetch.cjs",
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
  collectCoverageFrom: [
    "src/views/**/*.tsx",
    "src/app/page.tsx",
    "src/app/layout.tsx",
    "src/app/auth/auth-forms.tsx",
  ],

  clearMocks: true,
  testTimeout: 20000,
};

const built = createJestConfig(config);

/**
 * Replace `transformIgnorePatterns`, which is the only way to get here at all.
 *
 * `better-auth/client/react` is ESM-only (`dist/client/react/index.mjs`, no CJS
 * build and no `exports` entry to point at one), so requiring it under a CommonJS
 * test run dies with `ERR_REQUIRE_ESM` at `src/lib/auth-client.ts:29`. The fix is
 * to let swc compile the vendor module. Appending an allow-pattern is NOT that
 * fix, and this was measured rather than assumed: next/jest puts its own
 * `/node_modules/…` ignore FIRST and the list is a union — a path ignored by any
 * entry is never transformed — and its source says the quiet part out loud:
 * "Custom config can append to transformIgnorePatterns but not modify it"
 * (node_modules/next/dist/build/jest/jest.js:229). So the emitted array is
 * rewritten here, after next/jest has built it.
 *
 * The allowlist is a chain, not a package: `better-auth` pulled in
 * `@better-auth/core`, which pulled in `nanostores`. That is the honest cost of
 * this shape, and it is why the entry is anchored on `node_modules[\\/]` with
 * `[\\/]` and not `/`: jest matches the RESOLVED path, so a forward-slash-only
 * pattern silently never matches on Windows and un-ignores the whole tree, green
 * locally and different in CI.
 */
module.exports = async () => {
  const jestConfig = await built();
  jestConfig.transformIgnorePatterns = [
    String.raw`node_modules[\\/](?!(@?better-auth|nanostores)[\\/])`,
    String.raw`^.+\.module\.(css|sass|scss)$`,
  ];
  return jestConfig;
};
