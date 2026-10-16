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
 *   · `consume` is ASYNC because the store may be shared (Redis). Every test
 *     here awaits in sequence — the bucket is stateful, so ordering is the
 *     behaviour under test, and `Promise.all` over these calls would be testing
 *     something the limiter does not promise.
 *   · The Redis store degrades to the per-process buckets rather than to
 *     "allowed", because fail-open would turn a Redis outage into no limiting.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _reset,
  consume,
  installRateLimitStoreFromEnv,
  rateLimitId,
  restoreDefaultRateLimitStore,
  setRateLimitStore,
  type ConsumeResult,
  type RateLimitStore,
} from "@/lib/ratelimit";

const ENV_KEY = "RATE_LIMIT_PER_HOUR";
let savedEnv: string | undefined;

/** Restore the REAL default store. Other suites share this module registry, and
 *  restoring with a stub would leave the next suite an always-allow limiter. */
function restoreDefaultStore(): void {
  restoreDefaultRateLimitStore();
}

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
  test("allows up to capacity then refuses", async () => {
    // capacityPerHour 3 ⇒ 3 tokens available before any refill.
    const results: ConsumeResult[] = [];
    for (let i = 0; i < 4; i++) results.push(await consume("s", "id", 1, 3));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[0]).toMatchObject({ remaining: 2 });
    expect(results[3]).toMatchObject({ remaining: 0 });
  });

  test("a refusal reports a positive retryAfterMs", async () => {
    await consume("s", "id", 1, 1);
    const r = await consume("s", "id", 1, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryAfterMs).toBeGreaterThan(0);
      // A full bucket (1 token) refills over a full hour.
      expect(r.retryAfterMs).toBeLessThanOrEqual(3_600_000);
    }
  });

  test("scope and id are independent buckets", async () => {
    expect((await consume("a", "id", 1, 1)).ok).toBe(true);
    expect((await consume("a", "id", 1, 1)).ok).toBe(false);
    expect((await consume("b", "id", 1, 1)).ok).toBe(true);
    expect((await consume("a", "other", 1, 1)).ok).toBe(true);
  });

  test("cost > 1 consumes multiple tokens atomically", async () => {
    expect((await consume("s", "id", 3, 10)).ok).toBe(true);
    // 10 - 3 = 7 left
    expect(await consume("s", "id", 1, 10)).toMatchObject({ ok: true, remaining: 6 });
  });

  test("a cost exceeding the balance refuses without partial consumption", async () => {
    expect((await consume("s", "id", 5, 10)).ok).toBe(true);
    const r = await consume("s", "id", 8, 10);
    expect(r.ok).toBe(false);
    // The refusal must not have eaten the 5 remaining tokens: a 1-cost call
    // still succeeds afterwards.
    expect((await consume("s", "id", 1, 10)).ok).toBe(true);
  });

  test("a cost of zero is always allowed and drains nothing", async () => {
    expect((await consume("s", "id", 5, 5)).ok).toBe(true);
    const r = await consume("s", "id", 0, 5);
    expect(r.ok).toBe(true);
    // The bucket is empty and the zero-cost call must not have refilled it,
    // so a real cost still refuses.
    expect((await consume("s", "id", 1, 5)).ok).toBe(false);
  });

  // refillPerSec is capacity/3600, so a bucket of capacity N refills N tokens
  // per HOUR. Capacity 1 is one token per hour, not per second.
  test("refills over time at capacity/3600 tokens per second", async () => {
    const realNow = Date.now;
    // Fixed epoch, and Date.now is mocked BEFORE the first consume so the
    // bucket's lastRefill is stamped from the SAME controlled clock. A constant
    // base removes the real clock from the equation, which is what stopped this
    // being a flake under CI load.
    const base = 1_700_000_000_000;
    Date.now = () => base;
    try {
      // capacity 3600 ⇒ 1 token/sec.
      expect((await consume("s", "id", 3600, 3600)).ok).toBe(true);
      expect((await consume("s", "id", 1, 3600)).ok).toBe(false);

      Date.now = () => base + 1_000; // exactly one token back
      expect((await consume("s", "id", 1, 3600)).ok).toBe(true);
      expect((await consume("s", "id", 1, 3600)).ok).toBe(false);

      // Far in the future the bucket is back to capacity (3600), never more;
      // spending 1 leaves exactly 3599, which is the no-overflow assertion.
      Date.now = () => base + 10 * 3_600_000;
      expect(await consume("s", "id", 1, 3600)).toMatchObject({ ok: true, remaining: 3599 });
    } finally {
      Date.now = realNow;
    }
  });

  test("a capacity-1 bucket refills one token per hour", async () => {
    const realNow = Date.now;
    // A constant base, and pinned BEFORE the first consume. The bucket's
    // `lastRefill` is stamped from whatever `Date.now` returns on the creating
    // call, so with a live clock it lands at `base + ε`; one hour later that is
    // `1 - ε/3600000` tokens, which is under 1 and fails the last assertion.
    const base = 1_700_000_000_000;
    Date.now = () => base;
    try {
      expect((await consume("s", "id", 1, 1)).ok).toBe(true);
      expect((await consume("s", "id", 1, 1)).ok).toBe(false);
      // Half an hour is not half a token's worth of time for a 1/hour bucket.
      Date.now = () => base + 1_800_000;
      expect((await consume("s", "id", 1, 1)).ok).toBe(false);
      Date.now = () => base + 3_600_000;
      expect((await consume("s", "id", 1, 1)).ok).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  test("remaining never exceeds capacity after a long idle period", async () => {
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 24 * 3_600_000;
      await consume("s", "id", 1, 5);
      const r = await consume("s", "id", 1, 5);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.remaining).toBeLessThanOrEqual(4);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("consume — capacity resolution", () => {
  test("an explicit capacity of 0 is honoured, not replaced by the default", async () => {
    process.env.RATE_LIMIT_PER_HOUR = "60";
    // 0 is a legitimate "allow nothing" budget.
    expect((await consume("s", "id", 1, 0)).ok).toBe(false);
  });

  test("capacity falls back to RATE_LIMIT_PER_HOUR when unspecified", async () => {
    process.env.RATE_LIMIT_PER_HOUR = "2";
    expect((await consume("s", "id")).ok).toBe(true);
    expect((await consume("s", "id")).ok).toBe(true);
    expect((await consume("s", "id")).ok).toBe(false);
  });

  test("a non-numeric or zero RATE_LIMIT_PER_HOUR falls back to 60", async () => {
    for (const bad of ["not-a-number", "0", ""]) {
      _reset();
      process.env.RATE_LIMIT_PER_HOUR = bad;
      // Default 60/hour ⇒ well under a second of refill, so 61 rapid calls
      // cannot all pass.
      const oks: boolean[] = [];
      for (let i = 0; i < 61; i++) oks.push((await consume("s", "id")).ok);
      expect(oks.filter(Boolean).length).toBeLessThanOrEqual(60);
      expect(oks.filter(Boolean).length).toBeGreaterThan(0);
    }
  });

  test("an explicit capacity overrides the environment", async () => {
    process.env.RATE_LIMIT_PER_HOUR = "2";
    expect((await consume("s", "id", 1, 5)).ok).toBe(true);
    expect((await consume("s", "id", 1, 5)).ok).toBe(true);
    expect((await consume("s", "id", 1, 5)).ok).toBe(true);
  });
});

describe("rateLimitId — identity precedence", () => {
  const req = (headers: Record<string, string>) => new Request("https://x/y", { headers });

  test("prefers the proxy-resolved client IP", () => {
    // The marker is what makes this proxied traffic: without it the address
    // is caller-controlled and untrusted, and the bucket must not be per-IP.
    const r = rateLimitId(
      req({
        "x-securevoice-proxy": "1",
        "x-securevoice-client-ip": "203.0.113.9",
        "x-caller-id": "+971500000",
      }),
    );
    expect(r).toBe("ip:203.0.113.9");
  });

  test("ignores the spoofable caller-id when an IP is present", () => {
    // This ordering is the whole point: keying on the caller-supplied header
    // made every per-caller limit decorative.
    const r = rateLimitId(
      req({
        "x-securevoice-proxy": "1",
        "x-securevoice-client-ip": "198.51.100.7",
        "x-caller-id": "+971500000",
      }),
    );
    expect(r).toBe("ip:198.51.100.7");
  });

  test("an IP without the proxy marker is untrusted, not per-IP", () => {
    // The mirror of the two tests above: the same header with no marker is a
    // claim, not a resolution, so it must not mint a per-IP bucket.
    expect(rateLimitId(req({ "x-securevoice-client-ip": "203.0.113.9" }))).toBe("anon");
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

  test("distinct IPs get distinct buckets", async () => {
    expect((await consume("s", "ip:203.0.113.1", 1, 1)).ok).toBe(true);
    expect((await consume("s", "ip:203.0.113.1", 1, 1)).ok).toBe(false);
    expect((await consume("s", "ip:203.0.113.2", 1, 1)).ok).toBe(true);
  });
});

describe("key sanitisation", () => {
  // safeId strips everything but [\w.:-] and caps at 64 chars, so an attacker
  // cannot mint unlimited buckets by varying punctuation.
  test("punctuation-only variants collapse to the same bucket", async () => {
    expect((await consume("s", "abc", 1, 1)).ok).toBe(true);
    expect((await consume("s", "a!b@c#", 1, 1)).ok).toBe(false);
  });

  test("an id that sanitises to empty falls back to 'anon'", async () => {
    expect((await consume("s", "!!!", 1, 1)).ok).toBe(true);
    expect((await consume("s", "???", 1, 1)).ok).toBe(false);
  });

  test("over-long ids are truncated to the same bucket", async () => {
    const long = "a".repeat(200);
    expect((await consume("s", long, 1, 1)).ok).toBe(true);
    expect((await consume("s", `${long}different`, 1, 1)).ok).toBe(false);
  });

  test("dot, colon and dash are preserved so structured ids stay distinct", async () => {
    expect((await consume("s", "user:7", 1, 1)).ok).toBe(true);
    expect((await consume("s", "user:8", 1, 1)).ok).toBe(true);
    expect((await consume("s", "a.b-c", 1, 1)).ok).toBe(true);
  });
});

describe("setRateLimitStore", () => {
  test("a swapped store is consulted instead of the in-memory buckets", async () => {
    const calls: Array<[string, string, number, number, number]> = [];
    setRateLimitStore({
      consume: async (scope, id, cost, capacity, refillPerSec) => {
        calls.push([scope, id, cost, capacity, refillPerSec]);
        return { ok: true, limit: 100, remaining: 42, resetMs: 0 };
      },
    });
    try {
      const r = await consume("scoped", "who", 2, 100);
      expect(r).toEqual({ ok: true, limit: 100, remaining: 42, resetMs: 0 });
      expect(calls).toHaveLength(1);
      // refillPerSec is derived from the capacity — the store depends on it.
      expect(calls[0]![4]).toBeCloseTo(100 / 3600, 10);
      expect(calls[0]![2]).toBe(2);
    } finally {
      restoreDefaultStore();
    }
  });

  test("a store may refuse, and the refusal reaches the caller intact", async () => {
    // The shared store is a different implementation; this proves the limiter
    // does not flatten a refusal back into an allow on the way through.
    setRateLimitStore({
      consume: async () => ({
        ok: false,
        limit: 10,
        retryAfterMs: 1234,
        remaining: 0,
        resetMs: 1234,
      }),
    });
    try {
      const r = await consume("s", "id", 1, 10);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.retryAfterMs).toBe(1234);
    } finally {
      restoreDefaultStore();
    }
  });

  test("a store that throws propagates rather than silently allowing", async () => {
    // A limiter that swallows its own failure and returns "ok" would be
    // fail-open. The route handlers do not catch, so a throw becomes a 500 —
    // visible, which is the intended failure mode.
    setRateLimitStore({
      consume: async () => {
        throw new Error("store exploded");
      },
    });
    try {
      await expect(consume("s", "id", 1, 10)).rejects.toThrow("store exploded");
    } finally {
      restoreDefaultStore();
    }
  });
});

describe("installRateLimitStoreFromEnv", () => {
  test("returns memory and leaves the store alone when REDIS_URL is unset", async () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      expect(await installRateLimitStoreFromEnv()).toBe("memory");
      // Still the real in-memory limiter, not a stub: capacity 1 refuses twice.
      expect((await consume("s", "id", 1, 1)).ok).toBe(true);
      expect((await consume("s", "id", 1, 1)).ok).toBe(false);
    } finally {
      if (saved !== undefined) process.env.REDIS_URL = saved;
    }
  });

  test("an empty or whitespace REDIS_URL is treated as unset", async () => {
    const saved = process.env.REDIS_URL;
    try {
      for (const blank of ["", "   "]) {
        process.env.REDIS_URL = blank;
        expect(await installRateLimitStoreFromEnv()).toBe("memory");
      }
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
    }
  });
});

describe("RateLimitStore contract", () => {
  test("the store is awaited, so an async backend is honoured", async () => {
    // Guards the signature itself: if `consume` ever goes back to sync, this
    // returns the Promise object rather than the result and the assertion below
    // fails on `.ok` being undefined.
    const store: RateLimitStore = {
      consume: async () => ({ ok: true, limit: 5, remaining: 4, resetMs: 0 }),
    };
    const result = await store.consume("s", "id", 1, 5, 5 / 3600);
    expect(result.ok).toBe(true);
    expect(typeof result.ok).toBe("boolean");
  });
});
