/**
 * UNIT — the token-bucket rate limiter (src/lib/ratelimit.ts).
 *
 * Properties pinned here, all of which were unenforced:
 *
 *   · The bucket drains, refuses once empty, and refills at the configured rate
 *     back to capacity (never above it).
 *   · `cost` is honoured atomically — a cost larger than the remaining balance
 *     refuses rather than partially consuming.
 *   · An EXPLICIT capacity wins over the RATE_LIMIT_PER_HOUR default, including
 *     when it is 0. The `??` in consume() exists for exactly that; a falsy
 *     fallback would turn "allow nothing" into "allow 60".
 *   · `rateLimitId` prefers the proxy-resolved IP over the spoofable
 *     x-caller-id, and rejects the literal "direct"/"unknown" sentinels the
 *     proxy emits when it could not resolve an address. Every per-caller limit
 *     depends on this ordering.
 *   · Untrusted key components are sanitised, so a caller cannot mint unlimited
 *     buckets by varying punctuation, nor collide two identities into one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _reset, consume, rateLimitId, setRateLimitStore } from "@/lib/ratelimit";

const ENV_KEY = "RATE_LIMIT_PER_HOUR";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  _reset();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  _reset();
});

describe("consume — token bucket", () => {
  test("allows up to capacity then refuses", () => {
    // capacityPerHour 3 ⇒ 3 tokens available before any refill.
    const results = [0, 1, 2, 3].map(() => consume("s", "id", 1, 3));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[0]).toMatchObject({ remaining: 2 });
    expect(results[3]).toMatchObject({ remaining: 0 });
  });

  test("a refusal reports a positive retryAfterMs", () => {
    consume("s", "id", 1, 1);
    const r = consume("s", "id", 1, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryAfterMs).toBeGreaterThan(0);
      // A full bucket (1 token) refills over a full hour.
      expect(r.retryAfterMs).toBeLessThanOrEqual(3_600_000);
    }
  });

  test("scope and id are independent buckets", () => {
    expect(consume("a", "id", 1, 1).ok).toBe(true);
    expect(consume("a", "id", 1, 1).ok).toBe(false);
    expect(consume("b", "id", 1, 1).ok).toBe(true);
    expect(consume("a", "other", 1, 1).ok).toBe(true);
  });

  test("cost > 1 consumes multiple tokens atomically", () => {
    expect(consume("s", "id", 3, 10).ok).toBe(true);
    // 10 - 3 = 7 left
    expect(consume("s", "id", 1, 10)).toMatchObject({ ok: true, remaining: 6 });
  });

  test("a cost exceeding the balance refuses without partial consumption", () => {
    expect(consume("s", "id", 5, 10).ok).toBe(true);
    const r = consume("s", "id", 8, 10);
    expect(r.ok).toBe(false);
    // The refusal must not have eaten the 5 remaining tokens: a 1-cost call
    // still succeeds afterwards.
    expect(consume("s", "id", 1, 10).ok).toBe(true);
  });

  test("a cost of zero is always allowed and drains nothing", () => {
    expect(consume("s", "id", 5, 5).ok).toBe(true);
    const r = consume("s", "id", 0, 5);
    expect(r.ok).toBe(true);
    // The bucket is empty and the zero-cost call must not have refilled it,
    // so a real cost still refuses.
    expect(consume("s", "id", 1, 5).ok).toBe(false);
  });

  // refillPerSec is capacity/3600, so a bucket of capacity N refills N tokens
  // per HOUR. Capacity 1 is one token per hour, not per second.
  test("refills over time at capacity/3600 tokens per second", () => {
    const realNow = Date.now;
    const base = realNow();
    try {
      // capacity 3600 ⇒ 1 token/sec.
      expect(consume("s", "id", 3600, 3600).ok).toBe(true);
      expect(consume("s", "id", 1, 3600).ok).toBe(false);

      Date.now = () => base + 1_000; // exactly one token back
      expect(consume("s", "id", 1, 3600).ok).toBe(true);
      expect(consume("s", "id", 1, 3600).ok).toBe(false);

      // Far in the future the bucket is back to capacity (3600), never more;
      // spending 1 leaves exactly 3599, which is the no-overflow assertion.
      Date.now = () => base + 10 * 3_600_000;
      expect(consume("s", "id", 1, 3600)).toMatchObject({ ok: true, remaining: 3599 });
    } finally {
      Date.now = realNow;
    }
  });

  test("a capacity-1 bucket refills one token per hour", () => {
    const realNow = Date.now;
    const base = realNow();
    try {
      expect(consume("s", "id", 1, 1).ok).toBe(true);
      expect(consume("s", "id", 1, 1).ok).toBe(false);
      // Half an hour is not half a token's worth of time for a 1/hour bucket.
      Date.now = () => base + 1_800_000;
      expect(consume("s", "id", 1, 1).ok).toBe(false);
      Date.now = () => base + 3_600_000;
      expect(consume("s", "id", 1, 1).ok).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  test("remaining never exceeds capacity after a long idle period", () => {
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 24 * 3_600_000;
      consume("s", "id", 1, 5);
      const r = consume("s", "id", 1, 5);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.remaining).toBeLessThanOrEqual(4);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("consume — capacity resolution", () => {
  test("an explicit capacity of 0 is honoured, not replaced by the default", () => {
    process.env.RATE_LIMIT_PER_HOUR = "60";
    // 0 is a legitimate "allow nothing" budget.
    expect(consume("s", "id", 1, 0).ok).toBe(false);
  });

  test("capacity falls back to RATE_LIMIT_PER_HOUR when unspecified", () => {
    process.env.RATE_LIMIT_PER_HOUR = "2";
    expect(consume("s", "id").ok).toBe(true);
    expect(consume("s", "id").ok).toBe(true);
    expect(consume("s", "id").ok).toBe(false);
  });

  test("a non-numeric or zero RATE_LIMIT_PER_HOUR falls back to 60", () => {
    for (const bad of ["not-a-number", "0", ""]) {
      _reset();
      process.env.RATE_LIMIT_PER_HOUR = bad;
      // Default 60/hour ⇒ well under a second of refill, so 61 rapid calls
      // cannot all pass.
      const oks = Array.from({ length: 61 }, () => consume("s", "id").ok);
      expect(oks.filter(Boolean).length).toBeLessThanOrEqual(60);
      expect(oks.filter(Boolean).length).toBeGreaterThan(0);
    }
  });

  test("an explicit capacity overrides the environment", () => {
    process.env.RATE_LIMIT_PER_HOUR = "2";
    expect(consume("s", "id", 1, 5).ok).toBe(true);
    expect(consume("s", "id", 1, 5).ok).toBe(true);
    expect(consume("s", "id", 1, 5).ok).toBe(true);
  });
});

describe("rateLimitId — identity precedence", () => {
  const req = (headers: Record<string, string>) => new Request("https://x/y", { headers });

  test("prefers the proxy-resolved client IP", () => {
    const r = rateLimitId(
      req({ "x-securevoice-client-ip": "203.0.113.9", "x-caller-id": "+971500000" }),
    );
    expect(r).toBe("ip:203.0.113.9");
  });

  test("ignores the spoofable caller-id when an IP is present", () => {
    // This ordering is the whole point: keying on the caller-supplied header
    // made every per-caller limit decorative.
    const r = rateLimitId(
      req({ "x-securevoice-client-ip": "198.51.100.7", "x-caller-id": "+971500000" }),
    );
    expect(r).toBe("ip:198.51.100.7");
  });

  test("falls back to the caller-id only when no usable IP exists", () => {
    expect(rateLimitId(req({ "x-caller-id": "+971500000" }))).toBe("cid:+971500000");
  });

  test("treats the proxy's 'direct' and 'unknown' sentinels as unusable", () => {
    // Both mean the proxy could not resolve an address; honouring them would
    // collapse every unresolvable caller into one shared bucket.
    for (const sentinel of ["direct", "unknown"]) {
      expect(rateLimitId(req({ "x-securevoice-client-ip": sentinel, "x-caller-id": "+971" }))).toBe(
        "cid:+971",
      );
      expect(rateLimitId(req({ "x-securevoice-client-ip": sentinel }))).toBe("anon");
    }
  });

  test("an empty client-IP header does not win over caller-id", () => {
    expect(rateLimitId(req({ "x-securevoice-client-ip": "", "x-caller-id": "+971" }))).toBe(
      "cid:+971",
    );
  });

  test("returns the fallback when neither header is present", () => {
    expect(rateLimitId(req({}))).toBe("anon");
    expect(rateLimitId(req({}), "user-7")).toBe("user-7");
  });

  test("distinct IPs get distinct buckets", () => {
    expect(consume("s", "ip:203.0.113.1", 1, 1).ok).toBe(true);
    expect(consume("s", "ip:203.0.113.1", 1, 1).ok).toBe(false);
    expect(consume("s", "ip:203.0.113.2", 1, 1).ok).toBe(true);
  });
});

describe("key sanitisation", () => {
  // safeId strips everything but [\w.:-] and caps at 64 chars, so an attacker
  // cannot mint unlimited buckets by varying punctuation.
  test("punctuation-only variants collapse to the same bucket", () => {
    expect(consume("s", "abc", 1, 1).ok).toBe(true);
    expect(consume("s", "a!b@c#", 1, 1).ok).toBe(false);
  });

  test("an id that sanitises to empty falls back to 'anon'", () => {
    expect(consume("s", "!!!", 1, 1).ok).toBe(true);
    expect(consume("s", "???", 1, 1).ok).toBe(false);
  });

  test("over-long ids are truncated to the same bucket", () => {
    const long = "a".repeat(200);
    expect(consume("s", long, 1, 1).ok).toBe(true);
    expect(consume("s", `${long}different`, 1, 1).ok).toBe(false);
  });

  test("dot, colon and dash are preserved so structured ids stay distinct", () => {
    expect(consume("s", "user:7", 1, 1).ok).toBe(true);
    expect(consume("s", "user:8", 1, 1).ok).toBe(true);
    expect(consume("s", "a.b-c", 1, 1).ok).toBe(true);
  });
});

describe("setRateLimitStore", () => {
  test("a swapped store is consulted instead of the in-memory buckets", () => {
    const calls: Array<[string, string, number, number, number]> = [];
    setRateLimitStore({
      consume: (scope, id, cost, capacity, refillPerSec) => {
        calls.push([scope, id, cost, capacity, refillPerSec]);
        return { ok: true, remaining: 42, resetMs: 0 };
      },
    });
    try {
      const r = consume("scoped", "who", 2, 100);
      expect(r).toEqual({ ok: true, remaining: 42, resetMs: 0 });
      expect(calls).toHaveLength(1);
      // refillPerSec is derived from the capacity — the store depends on it.
      expect(calls[0]![4]).toBeCloseTo(100 / 3600, 10);
      expect(calls[0]![2]).toBe(2);
    } finally {
      // Restore the default; other suites share this process's module registry.
      setRateLimitStore({
        consume: (scope, id, cost, capacity, refillPerSec) => {
          void scope;
          void id;
          void cost;
          void capacity;
          void refillPerSec;
          return { ok: true, remaining: 0, resetMs: 0 };
        },
      });
    }
  });
});
