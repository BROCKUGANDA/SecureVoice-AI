/**
 * Rate-limit headers on the 429 path.
 *
 * A bank's client decides when to retry from headers, not from a body it has to
 * parse: that is the only way a generic HTTP library, an API gateway, or a batch
 * SDK behaves correctly without knowing this API's error vocabulary. These
 * responses used to carry `Retry-After` alone, computed by a copy of the same
 * millisecond-to-second rounding on eight routes — enough to say "wait", not "how
 * much room is left", which is the number an integration sending a thousand
 * signals needs before it sends the next thousand.
 *
 * The static checks at the bottom keep it true: a helper nobody calls is a file.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { consume, rateLimitHeaders, _reset } from "@/lib/ratelimit";
import { tooManyRequests } from "@/lib/api-errors";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** Every route file under src/app/api. */
function routeSources(): string[] {
  const root = `${REPO}src/app/api`;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && statSync(full).isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

const rel = (file: string) => file.replace(REPO, "").replace(/\\/g, "/");

describe("rateLimitHeaders", () => {
  test("an allowed request reports the budget, not a wait", () => {
    _reset();
    const rl = consume("unit-headers", "caller-a", 1, 100);
    expect(rl.ok).toBe(true);
    const h = rateLimitHeaders(rl, 1_700_000_000_000);
    expect(h["X-RateLimit-Limit"]).toBe("100");
    expect(Number(h["X-RateLimit-Remaining"])).toBe(99);
    expect(Number(h["X-RateLimit-Reset"])).toBeGreaterThanOrEqual(1_700_000_000);
    // No Retry-After when there is nothing to wait for: a header meaning "you may
    // proceed" is a header that gets misread as a refusal.
    expect(h["Retry-After"]).toBeUndefined();
  });

  test("a refused request carries all four", () => {
    _reset();
    expect(consume("unit-headers-denied", "caller-b", 1, 1).ok).toBe(true);
    const second = consume("unit-headers-denied", "caller-b", 1, 1);
    expect(second.ok).toBe(false);
    const h = rateLimitHeaders(second, 1_700_000_000_000);
    expect(h["X-RateLimit-Limit"]).toBe("1");
    expect(h["X-RateLimit-Remaining"]).toBe("0");
    expect(Number(h["X-RateLimit-Reset"])).toBeGreaterThan(1_700_000_000);
    expect(Number(h["Retry-After"])).toBeGreaterThanOrEqual(1);
  });

  test("a sub-second deficit still says one second, never zero", () => {
    // `Retry-After: 0` means "retry instantly", which turns a rate limit into a
    // retry storm on the one client least able to absorb it.
    const h = rateLimitHeaders(
      { ok: false, limit: 10, remaining: 0, retryAfterMs: 1, resetMs: 1 },
      1_700_000_000_000,
    );
    expect(h["Retry-After"]).toBe("1");
    expect(h["X-RateLimit-Reset"]).toBe("1700000001");
  });

  test("a negative duration cannot produce a negative header", () => {
    const h = rateLimitHeaders(
      { ok: true, limit: 5, remaining: -3, resetMs: -99_999 },
      1_700_000_000_000,
    );
    expect(h["X-RateLimit-Remaining"]).toBe("0");
    expect(Number(h["X-RateLimit-Reset"])).toBeGreaterThanOrEqual(1_700_000_000);
  });

  test("the limit survives the store boundary", () => {
    // `limit` is produced by the store, not the caller, so a backend that forgets
    // it would surface as `undefined` inside a header a client parses.
    _reset();
    for (const capacity of [1, 37, 5000]) {
      const rl = consume(`unit-headers-limit-${capacity}`, "caller-c", 1, capacity);
      expect(rl.limit, String(capacity)).toBe(capacity);
      expect(rateLimitHeaders(rl)["X-RateLimit-Limit"]).toBe(String(capacity));
    }
  });
});

describe("the routes", () => {
  /**
   * Every route that refuses on a token-bucket decision must emit the trio.
   *
   * The rule is "uses the limiter ⇒ uses the helper", not "never divides by
   * 1000": the failure envelope takes a `retryAfterSec` number and owns the
   * canonical `Retry-After`, so a caller passing both is correct, and a rule
   * forbidding the arithmetic would be fighting the envelope.
   */
  test("a route answering 429 from a limiter result emits the trio", () => {
    // The one deliberate exception: the credential lockout is the bad-actor
    // ladder, not a windowed bucket, and publishing how many attempts remain
    // before an IP is blocked is a gift to the traffic it exists to stop. It says
    // when to come back and nothing more.
    const EXEMPT = ["src/app/api/auth/[...all]/route.ts"];
    const offenders: string[] = [];
    for (const file of routeSources()) {
      const r = rel(file);
      if (EXEMPT.includes(r)) continue;
      const text = readFileSync(file, "utf8");
      const refusesOnBucket =
        text.includes("status: 429") && text.includes("retryAfterMs") && /consume\w*\(/.test(text);
      if (refusesOnBucket && !text.includes("rateLimitHeaders(")) offenders.push(r);
    }
    expect(offenders, `${offenders.join(", ")} answer 429 without the trio`).toEqual([]);
  });

  test("the exemption is still the credential lockout, for the stated reason", () => {
    const text = readFileSync(`${REPO}src/app/api/auth/[...all]/route.ts`, "utf8");
    // If that route ever moves to the token bucket, the exemption above is wrong
    // and this fails so someone notices.
    expect(text.includes("checkBadActor")).toBe(true);
    expect(text.includes("rateLimitHeaders(")).toBe(false);
  });

  test("the routes that hand-rolled Retry-After now use the helper", () => {
    const expected = [
      "src/app/api/asr/route.ts",
      "src/app/api/billing/checkout/route.ts",
      "src/app/api/billing/invoice/route.ts",
      "src/app/api/console/documents/route.ts",
      "src/app/api/console/documents/test/route.ts",
      "src/app/api/enroll/route.ts",
      "src/app/api/interventions/route.ts",
      "src/app/api/tts/stream/route.ts",
      "src/app/api/agent/route.ts",
      "src/app/api/tts/route.ts",
      "src/app/api/v1/interventions/route.ts",
      "src/app/api/v1/interventions/[id]/route.ts",
    ];
    for (const r of expected) {
      const text = readFileSync(`${REPO}${r}`, "utf8");
      // Either form is correct: a route may build the headers itself, or hand the
      // limiter result to `tooManyRequests`, which builds them once for everyone.
      const wired = text.includes("rateLimitHeaders(") || text.includes("tooManyRequests(");
      expect(wired, `${r} lost its limiter headers`).toBe(true);
    }
  });

  test("a budget refusal says what it knows and nothing more", () => {
    // The monthly upstream spend breaker is not a windowed bucket: there is no
    // capacity to advertise, and an invented `X-RateLimit-Limit` would be a
    // number a client parses that means nothing.
    const budget = tooManyRequests("upstream budget exhausted", 3600);
    expect(budget.status).toBe(429);
    expect(budget.headers.get("Retry-After")).toBe("3600");
    expect(budget.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(budget.headers.get("X-RateLimit-Limit")).toBeNull();

    _reset();
    // Drain the bucket so the result under test is genuinely a refusal.
    let rl = consume("unit-headers-route", "caller-d", 1, 5);
    for (let i = 0; i < 8 && rl.ok; i += 1) rl = consume("unit-headers-route", "caller-d", 1, 5);
    expect(rl.ok).toBe(false);
    const bucket = tooManyRequests("slow down", rl);
    expect(bucket.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(Number(bucket.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(0);
  });
});
