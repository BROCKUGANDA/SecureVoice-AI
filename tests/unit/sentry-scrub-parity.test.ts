/**
 * Sentry's two halves must scrub the same fields.
 *
 * The server config lives in `src/instrumentation.ts` (Next's server
 * instrumentation hook) and the client config in `src/instrumentation-client.ts`
 * (the file `@sentry/nextjs@11` auto-instruments). They cannot share a module:
 * the client file is bundled for the browser and the server file imports
 * `server-only` code. Duplicated is therefore the only option — and duplicated
 * lists drift, which produces a leak with a comment next to it: a field stripped
 * on one side and transmitted on the other.
 *
 * These checks read the source rather than call the SDK because the property
 * being asserted is textual identity between two files, and it fails the moment
 * either list is edited alone.
 *
 *   bun test tests/unit/sentry-scrub-parity.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const SERVER = "src/instrumentation.ts";
const CLIENT = "src/instrumentation-client.ts";

/** The literal pattern bodies, whatever name each file gave them. */
const credentialPattern = (src: string): string | undefined =>
  src.match(/\/(authorization[^/]*)\/[a-z]*/)?.[1];
const customerPattern = (src: string): string | undefined =>
  src.match(/\/(phone[^/]*)\/[a-z]*/)?.[1];

let priorDsn: string | undefined;

beforeAll(() => {
  priorDsn = process.env.SENTRY_DSN;
});
afterAll(() => {
  if (priorDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = priorDsn;
});

describe("scrub parity", () => {
  test("both files exist", () => {
    expect(existsSync(resolve(ROOT, SERVER))).toBe(true);
    expect(existsSync(resolve(ROOT, CLIENT))).toBe(true);
  });

  test("the credential field list is the same on both sides", () => {
    const server = credentialPattern(read(SERVER));
    const client = credentialPattern(read(CLIENT));
    expect(server).toBeDefined();
    expect(client).toBeDefined();
    expect(client).toBe(server);
  });

  test("the customer-data field list is the same on both sides", () => {
    const server = customerPattern(read(SERVER));
    const client = customerPattern(read(CLIENT));
    expect(server).toBeDefined();
    expect(client).toBeDefined();
    expect(client).toBe(server);
  });

  test("neither side transmits a request body", () => {
    for (const file of [SERVER, CLIENT]) {
      expect(read(file), file).toContain("event.request?.data");
    }
  });

  test("the client strips the user identity, not just the extra payload", () => {
    const client = read(CLIENT);
    expect(client).toMatch(/event\.user\?\.email/);
    expect(client).toMatch(/event\.user\?\.id/);
  });
});

describe("the client entry is the one the SDK actually loads", () => {
  // `sentry.client.config.ts` is the v8 filename. The SDK at 11.4.0
  // auto-instruments `instrumentation-client.ts`; nothing loads the old path, so
  // a config sitting there is a file that looks configured and captures nothing.
  test("the superseded sentry.client.config.ts is gone", () => {
    expect(existsSync(resolve(ROOT, "sentry.client.config.ts"))).toBe(false);
    expect(existsSync(resolve(ROOT, "src/sentry.client.config.ts"))).toBe(false);
  });

  test("it initialises only when a browser-readable DSN exists", () => {
    const client = read(CLIENT);
    expect(client).toContain("NEXT_PUBLIC_SENTRY_DSN");
    // Not a bare top-level init: a deployment that has not opted in must not
    // ship a transport that reports to an unconfigured project.
    expect(client).toMatch(/if \(dsn\)/);
  });

  test("router transitions are recorded through the SDK's own entrypoint", () => {
    const client = read(CLIENT);
    expect(client).toContain("onRouterTransitionStart");
    expect(client).toContain("captureRouterTransitionStart");
  });
});

describe("the build wrapper is applied when it can do its job", () => {
  test("withSentryConfig is imported from the subpath that exports it", () => {
    const config = read("next.config.ts");
    expect(config).toContain("@sentry/nextjs/config");
    expect(config).toContain("withSentryConfig");
  });

  test("upload is skipped without credentials rather than failing the build", () => {
    const config = read("next.config.ts");
    expect(config).toMatch(/SENTRY_AUTH_TOKEN/);
    // A build must not phone home to Sentry's CLI telemetry by default.
    expect(config).toMatch(/telemetry:\s*false/);
  });
});
