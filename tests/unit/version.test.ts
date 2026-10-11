/**
 * Unit tests for the version module.
 *
 * ## Why this file exists
 *
 * `versionLabel()` exists because of a real defect: the UI read
 * `process.env.npm_package_version`, which is NPM-only. Under bun — the runtime
 * this project actually runs — it was ALWAYS undefined, so every page that
 * rendered a version showed a hardcoded literal that never changed. The footer
 * claimed a version that was not the version.
 *
 * These specs pin the contract that makes that impossible to reintroduce: the
 * number comes from the BUILD, every surface renders it the same way, and the
 * placeholder is loud rather than silent.
 *
 * `versionLabel` takes the version as an argument precisely so these tests do
 * not depend on what the current build happened to inject — the house pattern
 * in this repo is dependency injection, not mutating `process.env` between
 * imports (see tests/unit/llm-provider-precedence.test.ts for the same rule).
 *
 *   bun test tests/unit/version.test.ts
 */
import { test, expect, describe } from "bun:test";
import {
  versionLabel,
  deployedVersion,
  APP_VERSION,
  APP_VERSION_IS_PLACEHOLDER,
} from "@/lib/version";

describe("versionLabel", () => {
  test("renders a bare version with a leading v", () => {
    expect(versionLabel("0.2.1")).toBe("v0.2.1");
  });

  test("does not double the v when the value already carries one", () => {
    expect(versionLabel("v0.2.1")).toBe("v0.2.1");
  });

  test("renders a four-part version without mangling it", () => {
    expect(versionLabel("1.2.3.4")).toBe("v1.2.3.4");
  });

  test("the placeholder is loud rather than an empty string", () => {
    // An obviously-fake number beats a plausible wrong one: a missing cosmetic
    // string must not fail a build, but a WRONG version is worse.
    expect(versionLabel("0.0.0-dev")).toBe("v0.0.0-dev");
  });
});

describe("the module's own constants", () => {
  test("APP_VERSION is a non-empty string, never undefined", () => {
    // The bug this guards: under bun the old source read npm_package_version,
    // which is always undefined, so this was the literal string "undefined".
    expect(typeof APP_VERSION).toBe("string");
    expect(APP_VERSION.length).toBeGreaterThan(0);
    expect(APP_VERSION).not.toBe("undefined");
  });

  test("APP_VERSION_IS_PLACEHOLDER agrees with the value", () => {
    expect(APP_VERSION_IS_PLACEHOLDER).toBe(APP_VERSION === "0.0.0-dev");
  });
});

describe("deployedVersion", () => {
  test("is a non-empty string that is never the literal 'undefined'", () => {
    const v = deployedVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
    expect(v).not.toBe("undefined");
  });
});
