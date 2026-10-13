/**
 * The load balancer must never be rate-limited by the thing it is probing.
 *
 * Why this suite exists, measured on production 2026-10-13: the app logs carried a
 * continuous stream of
 *   {"level":"warn","msg":"[edge] request rejected","fields":{"status":429,
 *    "error":"rate_limited","method":"GET","path":"/api/readyz"}}
 * for as long as an hour. `/api/readyz` is not user traffic — it is Caddy's active
 * health check (`health_uri /api/readyz`, `health_interval 10s`, once in the `/v1/*`
 * handler and once in the main handler), and Caddy only accepts `health_status 2xx`.
 *
 * Two consequences make that a deployment bug rather than log noise:
 *
 *  1. A 429 is not 2xx, so Caddy is entitled to pull a perfectly healthy origin out
 *     of rotation. An outage that starts because the edge throttled its own probe is
 *     unanswerable from the outside — the app is fine and nothing is being served.
 *  2. ADR-008's graceful drain works by `/api/readyz` answering 503 while in-flight
 *     requests finish. That protocol needs exactly one signal per meaning; if the
 *     probe can also be answered with a throttled 429, "instance leaving rotation"
 *     stops being a trustworthy observation.
 *
 * The arithmetic that made it inevitable: the probes carry no proxy marker, so
 * `clientIp()` keys them all as one caller, and two 10s handlers are 720 requests
 * per hour against a 600/hour page budget. It was never a question of if.
 */
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import proxy, { PROBE_PATHS } from "../../src/proxy.ts";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

/**
 * A TEST-OWNED CLIENT IP.
 *
 * The limiter buckets by (scope, client IP) in a process-global in-memory store, and
 * the suite's files share one process. Burning a budget on a real-looking address
 * would leave the rest of the run testing an exhausted bucket, so every request here
 * uses an address from TEST-NET-3 that nothing else in the tree touches.
 */
const TEST_IP = "203.0.113.96";

function request(pathname: string): NextRequest {
  return new NextRequest(`https://probe.test${pathname}`, {
    headers: { "x-securevoice-proxy": "1", "x-forwarded-for": TEST_IP },
  });
}

async function status(pathname: string): Promise<number> {
  const res = await proxy(request(pathname));
  return res?.status ?? -1;
}

/** The edge page budget, read from the same expression the middleware uses. */
const EDGE_RATE_PER_HOUR = Number(process.env.EDGE_RATE_LIMIT_PER_HOUR) || 600;

describe("infrastructure probes are not throttled by the page budget", () => {
  test("the limiter is live: a caller that exhausts its edge budget gets a 429", async () => {
    // This is the assertion that makes the test below mean something. Without it,
    // "readyz still answers 200" could pass because the limiter is not running at
    // all in this harness — which is precisely how a rate-limit test ends up
    // certifying nothing.
    let last = 200;
    for (let i = 0; i < EDGE_RATE_PER_HOUR + 1; i++) last = await status("/");
    expect(last).toBe(429);
  });

  test("with that same caller's edge budget spent, the probe paths still answer", async () => {
    // /api/health has been exempt all along; /api/readyz was not, and that is the
    // bug. Both are asserted so a future edit that moves one of them back into the
    // page bucket fails here.
    expect(await status("/api/readyz")).toBe(200);
    expect(await status("/api/health")).toBe(200);
  });

  test("probe paths are matched exactly, not by prefix", () => {
    // A prefix match would put /api/readyz/anything, or a future /api/health-report,
    // inside the generous probe budget without anyone deciding that.
    const matches = (p: string) => PROBE_PATHS.some((re) => re.test(p));
    expect(matches("/api/readyz")).toBe(true);
    expect(matches("/api/health")).toBe(true);
    expect(matches("/api/readyz/extra")).toBe(false);
    expect(matches("/api/healthz")).toBe(false);
    expect(matches("/api/status")).toBe(false);
    expect(matches("/")).toBe(false);
  });
});

describe("the Caddyfile cannot point at a path the edge will throttle", () => {
  const caddyfile = readFileSync(
    fileURLToPath(new URL("../../Caddyfile", import.meta.url)),
    "utf8",
  );

  test("every health_uri is a probe path", () => {
    const uris = [...caddyfile.matchAll(/^\s*health_uri\s+(\S+)\s*$/gm)]
      .map((m) => m[1])
      .filter((uri): uri is string => Boolean(uri));
    // Fail loudly if the Caddyfile ever stops declaring health_uri at all: that
    // would silently turn this into a test of an empty list.
    expect(uris.length).toBeGreaterThan(0);
    for (const uri of uris) {
      expect(
        PROBE_PATHS.some((re) => re.test(uri)),
        `Caddy active-checks ${uri}, which the edge page budget will 429 — a 429 is not ` +
          `in Caddy's health_status 2xx, so Caddy would drop a healthy origin`,
      ).toBe(true);
    }
  });
});
