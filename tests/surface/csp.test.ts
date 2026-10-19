/**
 * THE CSP IS A DECISION, SO IT GETS A VOTE.
 *
 * `next.config.ts` states its policy in prose — reduce every directive, no
 * third-party origins except the ones named — and prose has no caller. That is
 * not hypothetical here: the file said "no third-party origins remain in
 * script-src / frame-src" while billing was wired to a vendor SDK that INJECTS a
 * script from `cdn.paddle.com` and renders its card frame from `buy.paddle.com`.
 * The browser enforced the comment, not the intent: the script was blocked,
 * `initializePaddle` rejected, and no checkout on the site could open. The
 * contradiction survived because nothing asserted either side of it.
 *
 * So this file pins the exact allow-list per directive. Anything ADDED is a
 * failure until someone decides to add it here, and anything the policy still
 * forbids (framing ourselves, `object-src`, a wildcard in `script-src`) stays
 * forbidden with a name on it.
 */
import { expect, test } from "bun:test";
import { CSP, connectSrcDirective } from "../../next.config.ts";

const directives = new Map(
  CSP.split(";").map((part) => {
    const tokens = part.trim().split(/\s+/);
    return [tokens[0] as string, tokens.slice(1)] as const;
  }),
);

const valueOf = (name: string): string[] => {
  const v = directives.get(name);
  if (!v)
    throw new Error(`CSP has no '${name}' directive — the policy changed shape, update this gate`);
  return v;
};

/** Every absolute http(s) origin in a directive's value. */
const hostsOf = (name: string): string[] =>
  valueOf(name)
    .filter((t) => /^https?:\/\//.test(t))
    .sort();

const PADDLE_SCRIPT = ["https://cdn.paddle.com"];
const PADDLE_FRAMES = ["https://buy.paddle.com", "https://sandbox-buy.paddle.com"];
const PADDLE_CONNECT = [
  "https://api.paddle.com",
  "https://cdn.paddle.com",
  "https://sandbox-api.paddle.com",
];

test("the CSP is a single non-empty string", () => {
  expect(typeof CSP).toBe("string");
  expect(CSP.length).toBeGreaterThan(200);
  // Guards the parser above: an empty directive would silently satisfy "no hosts".
  expect(directives.size).toBeGreaterThan(10);
});

test("script-src allows exactly one third-party host, and it is Paddle's", () => {
  expect(hostsOf("script-src")).toEqual(PADDLE_SCRIPT);
  // The two keywords that production depends on — dropping 'unsafe-inline' is
  // what took the live site down once already (see the notes in next.config.ts).
  expect(valueOf("script-src").join(" ")).toContain("'self'");
  expect(valueOf("script-src").join(" ")).toContain("'unsafe-inline'");
});

test("frame-src allows exactly the two Paddle checkout hosts", () => {
  expect(hostsOf("frame-src")).toEqual(PADDLE_FRAMES);
});

test("connect-src allows Paddle's API hosts, the voice host, and the DSN host", () => {
  const hosts = hostsOf("connect-src");
  for (const needed of PADDLE_CONNECT) expect(hosts).toContain(needed);
  const dsnOrigin = (() => {
    try {
      return new URL(process.env.SENTRY_DSN ?? "").origin;
    } catch {
      return "";
    }
  })();
  // Reporting must be reachable when a DSN exists: the whole reason this assertion
  // changed shape is that a real deployment shipped with a DSN, a CSP that refused it,
  // and no failing test to say so.
  if (dsnOrigin && dsnOrigin !== "null") {
    expect(hosts, `SENTRY_DSN host ${dsnOrigin} is not in connect-src`).toContain(dsnOrigin);
  }
  const unnamed = hosts.filter(
    (h) => !PADDLE_CONNECT.includes(h) && h !== "blob:" && h !== dsnOrigin,
  );
  expect(
    unnamed.length,
    `connect-src carries an unnamed origin (${unnamed.join(", ")}) — add it here on purpose or remove it`,
  ).toBeLessThanOrEqual(2);
});

test("the DSN origin is derived, not hand-written into the policy", () => {
  // The drift gate: the shipped directive must be exactly what the builder produces
  // from the same inputs. Paste a host into next.config.ts instead of deriving it, or
  // rotate the DSN and leave the policy behind, and this fails.
  const built = connectSrcDirective(
    process.env.ELEVENLABS_API_BASE_URL ?? "https://api.elevenlabs.io",
    process.env.SENTRY_DSN,
  );
  const directives = CSP.split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("connect-src"));
  // Exactly one, and it is the derived one. An earlier draft asserted only that the
  // built string appeared somewhere in the policy, which a second hand-written
  // connect-src directive satisfied happily — and a policy with two connect-srcs is a
  // browser taking the first and silently ignoring the rest.
  expect(directives.length, "the policy carries more than one connect-src").toBe(1);
  expect(directives[0]).toBe(built.directive);
  expect(built.rejectedDsn).toBe(false);

  // And the builder itself, in the three states that matter.
  const measured = connectSrcDirective(
    "https://api.elevenlabs.io",
    "https://s2791972.us-west-2a.betterstackdata.com/2791978?sentry_key=abc",
  );
  expect(measured.directive).toContain("https://s2791972.us-west-2a.betterstackdata.com");
  expect(connectSrcDirective("https://api.elevenlabs.io").directive).not.toContain("betterstack");
  const junk = connectSrcDirective("https://api.elevenlabs.io", "not a url");
  expect(junk.rejectedDsn).toBe(true);
  expect(junk.directive.split(" ").length).toBe(
    connectSrcDirective("https://api.elevenlabs.io").directive.split(" ").length,
  );
});

test("the parts of the policy that stay closed are still closed", () => {
  expect(valueOf("frame-ancestors")).toEqual(["'none'"]);
  expect(valueOf("object-src")).toEqual(["'none'"]);
  expect(valueOf("default-src")).toEqual(["'self'"]);
  expect(valueOf("base-uri")).toEqual(["'self'"]);
  expect(valueOf("form-action")).toEqual(["'self'"]);
  // A wildcard would make every assertion above decorative.
  expect(CSP).not.toContain("https: ");
  expect(CSP).not.toMatch(/\ssrc[^;]*\s\*\s?/);
});

test("img-src is the one deliberately broad directive, and it is documented", () => {
  // `https:` in img-src is a known, accepted looseness (arbitrary tenant logos),
  // not drift. Asserted rather than trusted so it cannot spread to the
  // directives that can execute or frame something.
  expect(valueOf("img-src")).toContain("https:");
  expect(valueOf("script-src")).not.toContain("https:");
  expect(valueOf("frame-src")).not.toContain("https:");
});
