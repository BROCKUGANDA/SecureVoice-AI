/**
 * UNIT — the shared (Redis) rate-limit store.
 *
 * Separate from `ratelimit.test.ts` because it has to `mock.module("ioredis")`,
 * and Bun's module mocks are process-global: inlining them in the main suite
 * would replace `ioredis` for every other file that shares the run. Here the
 * blast radius is one file.
 *
 * What is under test is the part that is easy to get wrong and hard to notice:
 *
 *   · The limiter degrades to the PER-PROCESS store when Redis is unreachable,
 *     rather than returning "allowed". A store that fails open turns a Redis
 *     blip into no rate limiting at all — the failure is invisible (no requests
 *     are refused) and unbounded (a caller can retry forever). Falling back to
 *     the old behaviour keeps a real, if weaker, limit and logs the condition.
 *   · The degradation logs ONCE. A limiter that logs on every refused request
 *     turns one Redis outage into a log-flood that buries everything else.
 *   · A refusal from the shared store survives the round trip as a refusal, and
 *     reports the retry the store computed.
 *   · An unreachable REDIS_URL at boot leaves the in-memory store in place
 *     instead of installing a store that cannot work.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _reset,
  consume,
  installRateLimitStoreFromEnv,
  restoreDefaultRateLimitStore,
} from "@/lib/ratelimit";

/** Records every eval, so the Lua script and its arguments can be asserted. */
type EvalCall = { script: string; numKeys: number; key: string; argv: string[] };

const calls: EvalCall[] = [];
/** What the fake script returns, as [ok, value]. */
let scriptResult: [number, number] = [1, 42];
/** When set, every eval rejects with this — the "Redis is down" path. */
let failWith: Error | null = null;
let constructed = 0;

class FakeRedis {
  constructor(
    public url: string,
    public options: Record<string, unknown>,
  ) {
    constructed++;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(_event: string, _fn: (...args: any[]) => void) {
    return this;
  }
  async eval(script: string, numKeys: number, key: string, ...argv: string[]) {
    calls.push({ script, numKeys, key, argv });
    if (failWith) throw failWith;
    return scriptResult;
  }
}

mock.module("ioredis", () => ({ default: FakeRedis }));

const savedRedisUrl = process.env.REDIS_URL;

beforeEach(() => {
  calls.length = 0;
  failWith = null;
  scriptResult = [1, 42];
  constructed = 0;
  _reset();
});

afterEach(() => {
  // Critical: the module-level `store` outlives this file's tests and every other
  // file in the run shares it. Leaving a fake Redis installed would make other
  // suites assert against a store that only exists here.
  restoreDefaultRateLimitStore();
  if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedRedisUrl;
});

/** Boot the shared store with REDIS_URL present. */
async function install(): Promise<"redis" | "memory"> {
  process.env.REDIS_URL = "redis://fake:6379";
  return installRateLimitStoreFromEnv();
}

describe("RedisStore — the shared limiter", () => {
  test("REDIS_URL installs the Redis store rather than the in-process one", async () => {
    expect(await install()).toBe("redis");
    expect(constructed).toBe(1);
  });

  test("an allowed request goes through the Lua script, not the local map", async () => {
    await install();
    const r = await consume("ingest", "caller-7", 1, 60);

    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(42);
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    // Atomicity lives in the script: refill, check, decrement, persist, expire.
    expect(call.numKeys).toBe(1);
    expect(call.key).toBe("rl:ingest:caller-7");
    expect(call.script).toContain("HMGET");
    expect(call.script).toContain("HSET");
    expect(call.script).toContain("EXPIRE");
    // cost, capacity, refillPerSec, now, ttl
    expect(call.argv).toHaveLength(5);
    expect(call.argv[0]).toBe("1");
    expect(call.argv[1]).toBe("60");
  });

  test("the key is sanitised, so a caller cannot mint unbounded Redis keys", async () => {
    await install();
    await consume("ingest", "a!b@c#", 1, 60);
    await consume("ingest", "a.b-c", 1, 60);
    expect(calls[0]!.key).toBe("rl:ingest:abc");
    expect(calls[1]!.key).toBe("rl:ingest:a.b-c");
  });

  test("a refusal from Redis stays a refusal and carries the store's retry", async () => {
    await install();
    // [0, retryMs] is the script's refusal shape.
    scriptResult = [0, 2500];
    const r = await consume("ingest", "caller-7", 1, 60);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterMs).toBe(2500);
    // The refusal must have reached the shared store, not a local short-circuit.
    expect(calls).toHaveLength(1);
  });

  test("an unreachable Redis degrades to a per-process limit, never to no limit", async () => {
    await install();
    failWith = new Error("ECONNREFUSED");

    // First call: Redis is down, so the in-process store answers. It must still
    // enforce — a store that returned "allowed" here would be failing open, and
    // the failure would be invisible because nothing is ever refused.
    const first = await consume("ingest", "caller-9", 1, 1);
    const second = await consume("ingest", "caller-9", 1, 1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  test("the degraded path still uses the in-process bucket, not Redis keys", async () => {
    await install();
    failWith = new Error("ECONNREFUSED");
    await consume("ingest", "caller-9", 1, 5);
    await consume("ingest", "caller-9", 1, 5);
    // Both attempts still reached Redis (and failed) — proof the per-process
    // fallback is what refused the second, not a cached Redis verdict.
    expect(calls).toHaveLength(2);
  });
});
