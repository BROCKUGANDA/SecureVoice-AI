/* eslint-disable @typescript-eslint/no-require-imports -- a jest CJS environment. */
/**
 * jsdom, plus the fetch primitives jsdom does not implement.
 *
 * WHY THIS EXISTS. `tests-jest/Demo.test.tsx` has not executed since PR #6/#18:
 * importing `src/views/Demo.tsx` reaches `src/lib/auth-client.ts`, whose
 * `createAuthClient()` throws `ReferenceError: Request is not defined` under
 * jest-environment-jsdom. jsdom implements the DOM, not the WHATWG fetch classes,
 * and nothing in the suite can polyfill them from inside the sandbox because the
 * sandbox is exactly where they are missing.
 *
 * WHY NOT A POLYLIB PACKAGE, AND NOT A HAND-WRITTEN `Request`. A fake of the
 * precise surface the auth client is tested against is the failure mode this repo
 * has refused repeatedly: the suite would then prove the shim. This file is loaded
 * by Jest in the Node realm — not the sandbox — so the host's own
 * `fetch`/`Request`/`Response`/`Headers`/`FormData` are simply in scope here. They
 * are the same undici implementations Node exposes to production code, and they are
 * measured present on this machine (`process.features.require_module` true,
 * `typeof Request === "function"`). Nothing is imitated; five globals are moved
 * from the realm that has them to the realm that lacks them.
 *
 * `structuredClone` is assigned too: it is another host facility jsdom omits, and
 * structured-clone failure inside a client plugin shows up as an unrelated error
 * several frames away from the cause.
 */
const JSDOMEnvironment = require("jest-environment-jsdom").default;

const HOST_GLOBALS = ["fetch", "Request", "Response", "Headers", "FormData", "structuredClone"];

module.exports = class JSDOMWithFetchEnvironment extends JSDOMEnvironment {
  async setup() {
    await super.setup();
    const missing = [];
    for (const name of HOST_GLOBALS) {
      if (this.global[name] === undefined) {
        const value = globalThis[name];
        if (value === undefined) {
          missing.push(name);
          continue;
        }
        this.global[name] = value;
      }
    }
    // Fail loudly rather than let a suite run against a half-built environment:
    // an unassigned global here reproduces the exact error this file exists to
    // remove, several frames away from its cause.
    if (missing.length > 0) {
      throw new Error(
        `jest environment: the host Node does not provide ${missing.join(", ")} — ` +
          "these tests need a Node with the Web fetch globals on its realm",
      );
    }
  }
};
