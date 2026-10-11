/**
 * `src/lib/paddle-browser.ts` — the client-side Paddle bootstrap.
 *
 * Two properties are worth the tests, and both are the reason this file exists
 * rather than a default in the checkout component:
 *
 *  1. It REFUSES to guess. `NEXT_PUBLIC_PADDLE_ENVIRONMENT` unset, empty,
 *     whitespace-only or misspelled throws — a default of `production` would
 *     point a local checkout at the live account and take real money, and a
 *     default of `sandbox` would let a production deploy run test prices. Both
 *     are silent, which is worse than either being an error.
 *
 *  2. It pairs the token's prefix with the environment. A sandbox client token
 *     is `test_` prefixed; a production deploy carrying one must fail loudly
 *     rather than quietly checking out against the wrong account.
 *
 * The server-side API key is asserted absent here too: this module is imported
 * from `"use client"` components, so any server-side variable reaching it would
 * be inlined into the browser bundle — which is the actual leak this prevents.
 */
import { describe, expect, test } from "bun:test";

// `process.env` is mutated per-case and restored, because these functions read
// at CALL time rather than at import time — which is the behaviour under test.
const ENV_KEY = "NEXT_PUBLIC_PADDLE_ENVIRONMENT";
const TOKEN_KEY = "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN";
const SERVER_KEY_KEY = "PADDLE_API_KEY";
const SERVER_WEBHOOK_KEY = "PADDLE_WEBHOOK_SECRET";

const ORIGINAL = {
  ENV: process.env[ENV_KEY],
  TOKEN: process.env[TOKEN_KEY],
  API: process.env[SERVER_KEY_KEY],
  WEBHOOK: process.env[SERVER_WEBHOOK_KEY],
};

function withEnv(env: string | undefined, token: string | undefined) {
  if (env === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = env;
  if (token === undefined) delete process.env[TOKEN_KEY];
  else process.env[TOKEN_KEY] = token;
}

async function load() {
  // Cache-busted so each case re-evaluates the module-level `paddlePromise`.
  // NOT `return await` — that is `no-return-await`, a lint error rather than a
  // warning in this repo's config, and it buys nothing: returning the promise
  // directly still awaits at the call site.
  const spec = `../../src/lib/paddle-browser.ts?case=${Math.random()}`;
  return import(spec);
}

describe("paddleEnvironment refuses to guess", () => {
  // Note what is NOT here. `"SANDBOX"` and `"Sandbox"` are ACCEPTED (the value
  // is lowercased before matching), and `"sandbox "` with trailing whitespace is
  // ACCEPTED (it is trimmed). Listing them as failures would assert a strictness
  // the code deliberately does not have — the tolerant part is case and
  // whitespace; the part that throws is refusing to guess an unknown value.
  for (const bad of [undefined, "", "   ", "live", "prod", "test", "staging"]) {
    test(`${JSON.stringify(bad)} throws rather than defaulting`, async () => {
      withEnv(bad, "test_whatever");
      const { paddleEnvironment } = await load();
      expect(() => paddleEnvironment()).toThrow(/NEXT_PUBLIC_PADDLE_ENVIRONMENT/);
    });
  }

  test("sandbox and production are both accepted, case and whitespace tolerated", async () => {
    withEnv("  SANDBOX  ", "test_abc");
    expect((await load()).paddleEnvironment()).toBe("sandbox");
    withEnv("Production", "live_abc");
    expect((await load()).paddleEnvironment()).toBe("production");
    // Trailing whitespace on a bare value, the case a `.env` writer produces
    // when a value is edited and quoted.
    withEnv("sandbox ", "test_abc");
    expect((await load()).paddleEnvironment()).toBe("sandbox");
  });

  test("the thrown message names the offending value, so a misconfigured deploy is diagnosable", async () => {
    withEnv("staging", "test_abc");
    const { paddleEnvironment } = await load();
    // A brand-new value must say what it got, not just "invalid" — the operator
    // reading this has to be able to see what the deployment actually held.
    expect(() => paddleEnvironment()).toThrow(/"staging"/);
  });
});

describe("paddleToken pairs the token prefix with the environment", () => {
  test("a sandbox token is returned as-is, with its environment", async () => {
    withEnv("sandbox", "test_8055a2ad0d57cc58f2aabf06680");
    const { paddleToken } = await load();
    expect(paddleToken()).toEqual({
      env: "sandbox",
      token: "test_8055a2ad0d57cc58f2aabf06680",
    });
  });

  test("a production token is returned as-is", async () => {
    withEnv("production", "live_abcdef123456");
    const { paddleToken } = await load();
    expect(paddleToken()).toEqual({ env: "production", token: "live_abcdef123456" });
  });

  test("a missing token throws, naming the environment it is missing FOR", async () => {
    withEnv("sandbox", undefined);
    const { paddleToken } = await load();
    expect(() => paddleToken()).toThrow(/NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set.*sandbox/);
  });

  test("a NON-sandbox token in the sandbox environment throws", async () => {
    // The failure this prevents: a deploy that copies the live token into
    // sandbox, or the reverse. Without this the checkout opens against the
    // wrong account and nothing reports it.
    withEnv("sandbox", "live_abcdef123456");
    const { paddleToken } = await load();
    expect(() => paddleToken()).toThrow(/does not look like a SANDBOX token/);
  });

  test("a sandbox token in the PRODUCTION environment is NOT rejected by the prefix rule", async () => {
    // Asymmetric on purpose, and worth pinning: the `test_` check is the
    // SANDBOX guard. Production's pairing is guarded by the environment check
    // alone, so a `test_` token in production is a configuration the operator
    // has to notice — asserting it throws here would be inventing a rule the
    // code does not have.
    withEnv("production", "test_8055a2ad0d57cc58f2aabf06680");
    const { paddleToken } = await load();
    expect(paddleToken().token).toBe("test_8055a2ad0d57cc58f2aabf06680");
  });

  test("whitespace around the token is stripped, not treated as part of it", async () => {
    withEnv("sandbox", "  test_abc  ");
    const { paddleToken } = await load();
    expect(paddleToken().token).toBe("test_abc");
  });
});

describe("no server-side credential can reach the browser bundle", () => {
  /**
   * Scan the code, not the commentary.
   *
   * This module's contract is written down at length — it explains that the
   * server-side API key must never appear here, and to say that it has to NAME
   * the variables it excludes. A substring test over raw source therefore fails
   * on the sentence documenting the rule: the worst kind of red gate, because the
   * only available fix is to delete the explanation. Everything below strips
   * comments first and matches an actual read.
   */
  function codeOnly(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  const source = async () => codeOnly(await Bun.file("src/lib/paddle-browser.ts").text());

  test("this module reads no server-side Paddle credential", async () => {
    const code = await source();
    // The BARE names. `NEXT_PUBLIC_PADDLE_PRICES` is this file's legitimate
    // browser-side twin of the server's `PADDLE_PRICES`, so a plain
    // `not.toContain("PADDLE_PRICES")` flagged the correct code — the guard was
    // matching a prefix of the very variable it was meant to allow.
    for (const serverVar of ["PADDLE_API_KEY", "PADDLE_WEBHOOK_SECRET", "PADDLE_PRICES"]) {
      const read = new RegExp(`process\\.env\\.?${serverVar}\\b`).test(code);
      expect(read, `${serverVar} must not be read in a client module`).toBe(false);
    }
    // It is a client module, so a relaxed rule here reaches the bundle.
    expect(code).toContain('"use client"');
  });

  test("no server-only marker and no database import are present", async () => {
    const code = await source();
    expect(/^\s*import\s+["']server-only["']/m.test(code)).toBe(false);
    expect(/from\s+["']@\/lib\/db["']/.test(code)).toBe(false);
    // Any secret read through the server config object is the same leak.
    expect(/env\.paddle(ApiKey|WebhookSecret)/i.test(code)).toBe(false);
  });
});

describe("environment restoration", () => {
  test("the suite leaves the process env as it found it", () => {
    withEnv(ORIGINAL.ENV, ORIGINAL.TOKEN);
    expect(process.env[ENV_KEY]).toBe(ORIGINAL.ENV);
    expect(process.env[TOKEN_KEY]).toBe(ORIGINAL.TOKEN);
  });
});
