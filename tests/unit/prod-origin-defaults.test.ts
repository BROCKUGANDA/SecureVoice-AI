/**
 * One production origin, asserted in every place it is written down.
 *
 * `BETTER_AUTH_URL` is the origin Better Auth compares a browser's `Origin`
 * against. The repository states it in five places — the compose services, the
 * Dockerfile build arg, `.env.example`, CI, and the app's own published default —
 * and they were free to disagree. Four of them said `localhost` while the product
 * is served from a public host, which is not a cosmetic drift: with
 * `NODE_ENV=production` the app now refuses to serve on a loopback origin at all,
 * and before it did, every sign-in from the public address came back "Invalid
 * origin" while the same stack worked perfectly on the laptop that configured it.
 *
 * A comment saying "keep these in step" is what was there. This is the thing that
 * fails.
 *
 *   bun test tests/unit/prod-origin-defaults.test.ts
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/;

/** The origin the product publishes, parsed out of the module that publishes it. */
function publishedOrigin(): string {
  const source = read("src/lib/public-config.ts");
  const m = source.match(/NEXT_PUBLIC_API_BASE\s*\?\?\s*"([^"]+)"/);
  expect(m, 'public-config.ts no longer carries a `?? "https://…"` default').toBeDefined();
  return m![1]!;
}

const origin = publishedOrigin();

function isPublicHttps(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${value} is not an origin — expected https://host with no path`);
  }
  expect(url.protocol, `${value} must be https`).toBe("https:");
  expect(url.pathname === "/" || url.pathname === "", `${value} must not carry a path`).toBe(true);
  expect(
    LOOPBACK.test(url.hostname),
    `${value} is loopback and cannot serve a public sign-in`,
  ).toBe(false);
}

test("the published origin is a real public https origin", () => {
  isPublicHttps(origin);
});

test("every compose service defaults BETTER_AUTH_URL to it", () => {
  const compose = read("docker-compose.yml");
  const defaults = [...compose.matchAll(/BETTER_AUTH_URL:\s*\$\{BETTER_AUTH_URL:-([^}]*)\}/g)].map(
    (m) => m[1]!,
  );
  // Non-empty first: a check that vacuously passes because the line was deleted is
  // worse than no check, because it reads as coverage.
  expect(defaults.length).toBeGreaterThan(0);
  for (const value of defaults) {
    expect(value, "a compose service defaults to something else").toBe(origin);
  }
  // And the specific drift that broke the VPS must not come back.
  expect(compose).not.toMatch(
    /BETTER_AUTH_URL:\s*\$\{BETTER_AUTH_URL:-https?:\/\/(localhost|127\.0\.0\.1)/,
  );
});

test("the image build arg defaults to it", () => {
  const dockerfile = read("Dockerfile");
  const m = dockerfile.match(/ARG BETTER_AUTH_URL="([^"]*)"/);
  expect(m, "Dockerfile no longer declares an ARG BETTER_AUTH_URL default").toBeDefined();
  expect(m![1]).toBe(origin);
});

test("the documented operator default is it, with the local override stated", () => {
  const envExample = read(".env.example");
  const m = envExample.match(/^BETTER_AUTH_URL="?([^"\n]*)"?\s*$/m);
  expect(m, ".env.example no longer sets BETTER_AUTH_URL").toBeDefined();
  expect(m![1]).toBe(origin);
  // The operator must be told how to run this locally, because the production
  // default is now the thing that refuses a localhost Origin.
  expect(envExample).toContain("BETTER_AUTH_URL=http://localhost:3000");
});

test("CI runs the suites against the production origin, not a laptop one", () => {
  const ci = read(".github/workflows/ci.yml");
  // The unit/verify job's env block — the one every `bun test` inherits.
  const jobEnv = [...ci.matchAll(/^\s{6}BETTER_AUTH_URL:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
  expect(jobEnv.length, "CI no longer sets BETTER_AUTH_URL at job scope").toBeGreaterThan(0);
  for (const value of jobEnv) expect(value).toBe(origin);
});

test("the five sources cannot drift apart silently", () => {
  // The whole point in one assertion: each file is parsed independently above, and
  // this names the pair that disagreed when a future edit breaks only one of them.
  const compose = read("docker-compose.yml").match(
    /BETTER_AUTH_URL:\s*\$\{BETTER_AUTH_URL:-([^}]*)\}/,
  )![1]!;
  const dockerfile = read("Dockerfile").match(/ARG BETTER_AUTH_URL="([^"]*)"/)![1]!;
  const envExample = read(".env.example").match(/^BETTER_AUTH_URL="?([^"\n]*)"?\s*$/m)![1]!;
  expect({ compose, dockerfile, envExample }).toEqual({
    compose: origin,
    dockerfile: origin,
    envExample: origin,
  });
});
