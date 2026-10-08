/**
 * Ambient globals for the Jest specs under tests-jest/.
 *
 * Why this file exists: `@types/jest` is not a dependency of this project and
 * this task does not add dependencies. The root tsconfig excludes `tests/` but
 * NOT `tests-jest/`, so `bunx tsc --noEmit -p tsconfig.json` type-checks these
 * specs — and they need `describe`/`it`/`expect` to exist in the type system.
 *
 * `bun-types` (already a devDependency) ships a complete, Jest-compatible test
 * API surface as the ambient module `bun:test`, but deliberately keeps the
 * *globals* in a separate `test-globals.d.ts` that its index does not pull in.
 * So the matcher types are reused from there rather than hand-rolled, and only
 * the global bindings and the `jest` object — whose module-mocking helpers
 * `bun:test` does not model — are declared here.
 *
 * Types come from bun-types; the RUNTIME is Jest. The matcher subset the specs
 * use (toBe/toEqual/toContain/toHaveLength/toThrow/not.*) is identical in both,
 * which is what makes this safe. Do not reach for `@testing-library/jest-dom`
 * matchers from these specs: they are not in the matcher type and a typo would
 * be caught by neither tsc nor Jest.
 */

declare var describe: typeof import("bun:test").describe;
declare var it: typeof import("bun:test").it;
declare var test: typeof import("bun:test").test;
declare var expect: typeof import("bun:test").expect;
declare var beforeAll: typeof import("bun:test").beforeAll;
declare var beforeEach: typeof import("bun:test").beforeEach;
declare var afterAll: typeof import("bun:test").afterAll;
declare var afterEach: typeof import("bun:test").afterEach;

type JestMockFn<T extends (...args: never[]) => unknown> = T & {
  mock: { calls: Parameters<T>[] };
  mockClear(): void;
  mockReset(): void;
};

declare var jest: {
  /** Hoisted above the imports by the transform's jest-hoisting pass. This is
   *  how the view specs keep network, TTS and session code out of jsdom. */
  mock(moduleName: string, factory?: () => unknown, options?: { virtual?: boolean }): void;
  requireActual<T = unknown>(moduleName: string): T;
  resetModules(): void;
  fn<T extends (...args: never[]) => unknown>(impl?: T): JestMockFn<T>;
  spyOn<T extends object, K extends keyof T>(obj: T, key: K): void;
  useFakeTimers(): void;
  useRealTimers(): void;
  advanceTimersByTime(ms: number): void;
  clearAllMocks(): void;
  restoreAllMocks(): void;
};
