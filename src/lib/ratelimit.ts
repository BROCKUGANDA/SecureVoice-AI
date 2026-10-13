import "server-only";
import { env, rateLimitPerHour } from "@/lib/config";
import { logWarn } from "@/lib/validation/safe-log";
/**
 * Token-bucket rate limiter with a pluggable store backend.
 *
 * Backend: a Redis store when `REDIS_URL` is set, otherwise an in-process Map.
 * `installRateLimitStoreFromEnv()` picks one at boot (src/instrumentation.ts).
 *
 * WHY `consume` IS ASYNC: the store interface used to be synchronous, which made
 * a shared backend impossible — Redis is async, and keeping a sync signature would
 * mean blocking on it. So the limiter was pinned to per-process memory, and on a
 * multi-instance deployment every instance enforced its own bucket: the effective
 * limit became `capacity x instances` and a restart reset every bucket. A control
 * that reads as enforced but is not worse than one that is honestly absent.
 * Every call site awaits `consume`; TypeScript is what proves they all did.
 *
 * Interface is deliberately Redis-shaped (`consume(scope, id, cost)`) so the
 * atomic check-and-decrement lives in one place.
 *
 * Hardening:
 *  - Caller-supplied IDs (x-caller-id) are length-capped and sanitized so an
 *    attacker cannot mint unbounded unique keys (memory exhaustion).
 *  - The bucket map is capped with max size + periodic eviction of stale
 *    buckets; a scraper cycling IDs cannot grow it forever.
 */

type Bucket = {
  capacity: number;
  refillPerSec: number;
  tokens: number;
  lastRefill: number; // epoch ms
};

export type ConsumeResult =
  | { ok: true; limit: number; remaining: number; resetMs: number }
  | { ok: false; limit: number; retryAfterMs: number; remaining: 0; resetMs: number };

/**
 * Pluggable store interface. `installRateLimitStoreFromEnv()` wires the Redis
 * implementation below when REDIS_URL is present; without it the InMemoryStore
 * stands, which is only equivalent on a single-instance deployment.
 */
export interface RateLimitStore {
  consume(
    scope: string,
    id: string,
    cost: number,
    capacity: number,
    refillPerSec: number,
  ): Promise<ConsumeResult>;
}

/* ── In-memory store (single-instance fallback) ── */

const BUCKETS = new Map<string, Bucket>();

// A bucket fully refills in at most 2h at the default rate — anything idle
// longer than that is equivalent to a fresh bucket and can be evicted.
const STALE_MS = env.rateLimitStaleMs;
const MAX_BUCKETS = 20_000;
const EVICT_SWEEP_EVERY = 512;
let callsSinceSweep = 0;

/** Cap + sanitize an untrusted caller-supplied key component. */
function safeId(id: string): string {
  const cleaned = id.replace(/[^\w.:-]/g, "").slice(0, 64);
  return cleaned || "anon";
}

function sweep(now: number): void {
  for (const [k, b] of BUCKETS) {
    if (now - b.lastRefill > STALE_MS) BUCKETS.delete(k);
  }
  if (BUCKETS.size > MAX_BUCKETS) {
    const sorted = [...BUCKETS.entries()].sort((a, b) => a[1].lastRefill - b[1].lastRefill);
    const drop = sorted.slice(0, Math.ceil(BUCKETS.size / 2));
    for (const [k] of drop) BUCKETS.delete(k);
  }
}

class InMemoryStore implements RateLimitStore {
  async consume(
    scope: string,
    id: string,
    cost: number,
    capacity: number,
    refillPerSec: number,
  ): Promise<ConsumeResult> {
    const key = `${safeId(scope)}:${safeId(id)}`;
    const now = Date.now();
    if (++callsSinceSweep >= EVICT_SWEEP_EVERY) {
      callsSinceSweep = 0;
      sweep(now);
    }
    let b = BUCKETS.get(key);
    if (!b) {
      b = { capacity, refillPerSec, tokens: capacity, lastRefill: now };
      BUCKETS.set(key, b);
    } else {
      const elapsed = (now - b.lastRefill) / 1000;
      b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerSec);
      b.lastRefill = now;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      const resetMs = Math.ceil(((capacity - b.tokens) / refillPerSec) * 1000);
      return { ok: true, limit: b.capacity, remaining: Math.floor(b.tokens), resetMs };
    }
    const deficit = cost - b.tokens;
    const retryAfterMs = Math.ceil((deficit / refillPerSec) * 1000);
    return { ok: false, limit: b.capacity, retryAfterMs, remaining: 0, resetMs: retryAfterMs };
  }
}

let store: RateLimitStore = new InMemoryStore();

/** Swap the store backend. */
export function setRateLimitStore(s: RateLimitStore): void {
  store = s;
}

/**
 * Put the in-process store back.
 *
 * Exists because there is no other way to get it. A test that installs a stub
 * store and restores it with another stub is not restoring anything — the next
 * suite then runs against an always-allow limiter and silently proves nothing.
 * Production has no caller; this is for tests and for a boot path that decides
 * to back out of the shared store.
 */
export function restoreDefaultRateLimitStore(): void {
  store = new InMemoryStore();
}

/**
 * Try to consume `cost` tokens for (scope, id).
 *
 * `capacityPerHour` lets a caller ask for a budget appropriate to its own
 * traffic rather than inheriting RATE_LIMIT_PER_HOUR. That default is sized for
 * expensive metered calls (TTS/ASR/agent turns), so reusing it for a per-request
 * edge check would rate-limit ordinary page navigation on those same numbers —
 * a demo visitor would be locked out after a handful of requests. Omit it and the
 * historical behaviour is unchanged.
 */
export async function consume(
  scope: string,
  id: string,
  cost = 1,
  capacityPerHour?: number,
): Promise<ConsumeResult> {
  // An explicit capacity wins even when it is 0 — 0 is a legitimate "allow
  // nothing" budget, which a falsy fallback would silently turn into the default.
  const capacity = capacityPerHour ?? rateLimitPerHour();
  const refillPerSec = capacity / 3600;
  return store.consume(scope, id, cost, capacity, refillPerSec);
}

/**
 * The standard rate-limit headers for a limiter decision.
 *
 * A bank's client does not read the body to decide when to come back — it reads
 * the headers, because that is what a generic HTTP client, a gateway, or a
 * retrying SDK can act on without knowing this API's error vocabulary. Emitting
 * only `Retry-After` (which this codebase did, on nine separate sites, each with
 * its own copy of the millisecond-to-second rounding) answers "how long" but not
 * "how much room do I have left", which is the number a batch integration needs
 * before it sends the next thousand signals.
 *
 * `X-RateLimit-Reset` is a wall-clock second, per the convention clients
 * already implement, so it is derived from `now` rather than from a duration.
 * `Retry-After` appears only on a refusal: on an allowed request there is
 * nothing to wait for, and a header that means "you may proceed" is a header
 * that will be misread.
 */
export function rateLimitHeaders(
  r: ConsumeResult,
  now: number = Date.now(),
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(Math.max(0, Math.floor(r.limit))),
    "X-RateLimit-Remaining": String(Math.max(0, Math.floor(r.remaining))),
    "X-RateLimit-Reset": String(Math.ceil((now + Math.max(0, r.resetMs)) / 1000)),
  };
  if (!r.ok) headers["Retry-After"] = String(Math.max(1, Math.ceil(r.retryAfterMs / 1000)));
  return headers;
}

/** Test helper. Not for production use. */

export function _reset(): void {
  BUCKETS.clear();
}

/**
 * Resolve the identity a rate limit should be keyed on for this request.
 *
 * Order of trust:
 *   1. x-securevoice-client-ip — set by src/proxy.ts AFTER deciding whether
 *      the X-Forwarded-For chain is believable (only when Caddy identified
 *      itself). An attacker cannot influence its value through the proxy.
 *   2. x-caller-id — caller-supplied, spoofable; last resort only (a caller
 *      rotating it mints a fresh bucket per request, so never prefer it).
 *
 * Keying metered endpoints on the spoofable header made every per-caller
 * limit decorative; keying on the proxy-resolved IP is what makes the limit
 * real. Per-user limits on authenticated routes should still pass the
 * authenticated user id directly to consume() instead of this helper.
 */
export function rateLimitId(req: Request, fallback = "anon"): string {
  const ip = req.headers.get("x-securevoice-client-ip");
  if (ip && ip !== "direct" && ip !== "unknown") return `ip:${ip}`;
  const caller = req.headers.get("x-caller-id");
  if (caller) return `cid:${caller}`;
  return fallback;
}

/* ── Redis store (installed when REDIS_URL is set) ── */

/**
 * Atomic refill + check-and-decrement, in Lua.
 *
 * Doing this in the client would be a race: two app instances reading the same
 * bucket and both writing back would both grant the request, so the shared limit
 * would be the sum of the per-instance limits — the exact bug the shared store
 * exists to remove. Redis runs this as one unit, so the read-modify-write cannot
 * interleave.
 *
 * `now` is passed in rather than read with TIME inside the script: the caller and
 * the server can disagree, and a bucket whose clock is the caller's is refillable
 * by a client with a skewed one.
 */
const CONSUME_LUA = `
local key = KEYS[1]
local cost = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillPerSec = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local data = redis.call("HMGET", key, "tokens", "last")
local tokens = tonumber(data[1]) or capacity
local last = tonumber(data[2]) or now
local elapsed = (now - last) / 1000
tokens = math.min(capacity, tokens + elapsed * refillPerSec)
if tokens >= cost then
  tokens = tokens - cost
end
redis.call("HSET", key, "tokens", tokens, "last", now)
redis.call("EXPIRE", key, ttl)
if tokens >= cost then
  return {1, math.floor(tokens - cost)}
end
local deficit = cost - tokens
local retry = math.ceil(deficit / refillPerSec * 1000)
return {0, retry}
`;

/**
 * Bucket TTL. Comfortably longer than the longest full refill, so a live bucket
 * never expires and hands its holder a fresh capacity.
 */
const BUCKET_TTL_SEC = 7200;

/**
 * A shared, cross-instance limiter.
 *
 * Degradation is deliberate and is NOT fail-open-to-nothing: if Redis is
 * unreachable, `consume` falls back to the in-process store rather than
 * returning "allowed". That yields the pre-existing per-instance behaviour — a
 * real but weaker limit — instead of an unlimited one, and it logs, so the
 * condition is visible rather than silent. Returning "allowed" on error would
 * turn a Redis blip into no rate limiting at all.
 */
class RedisStore implements RateLimitStore {
  private redis: import("ioredis").Redis;
  private fallback = new InMemoryStore();
  private degradedLogged = false;

  constructor(redis: import("ioredis").Redis) {
    this.redis = redis;
  }

  async consume(
    scope: string,
    id: string,
    cost: number,
    capacity: number,
    refillPerSec: number,
  ): Promise<ConsumeResult> {
    const key = `rl:${safeId(scope)}:${safeId(id)}`;
    try {
      const raw = (await this.redis.eval(
        CONSUME_LUA,
        1,
        key,
        String(cost),
        String(capacity),
        String(refillPerSec),
        String(Date.now()),
        String(BUCKET_TTL_SEC),
      )) as [number, number];
      const [ok, val] = raw;
      return ok === 1
        ? { ok: true, limit: capacity, remaining: val, resetMs: 0 }
        : { ok: false, limit: capacity, retryAfterMs: val, remaining: 0, resetMs: val };
    } catch (err) {
      if (!this.degradedLogged) {
        this.degradedLogged = true;
        logWarn("[ratelimit] redis unreachable — falling back to per-process buckets", {
          error: err instanceof Error ? err.message : String(err),
          detail:
            "limits are still enforced, but per-instance rather than cluster-wide. Restore Redis to restore the shared limit.",
        });
      }
      return this.fallback.consume(scope, id, cost, capacity, refillPerSec);
    }
  }
}

/**
 * Install the shared limiter if `REDIS_URL` names a reachable Redis.
 *
 * Called once from `register()` in src/instrumentation.ts. A deployment with no
 * REDIS_URL keeps the in-process store — correct for a single instance, and the
 * reason the async signature does not make the zero-config path heavier: ioredis
 * is imported dynamically and only when a URL is actually present.
 *
 * Returns which store is in force so the caller can log it.
 */
export async function installRateLimitStoreFromEnv(): Promise<"redis" | "memory"> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return "memory";
  try {
    const { default: Redis } = await import("ioredis");
    const redis = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
    });
    // Attach the error handler immediately: an ioredis client with no listener
    // emits an unhandled 'error' event, which takes the process down.
    redis.on("error", () => {
      /* surfaced per-request by RedisStore.consume's own log */
    });
    setRateLimitStore(new RedisStore(redis));
    return "redis";
  } catch (err) {
    logWarn("[ratelimit] REDIS_URL set but the client could not be created — using memory", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "memory";
  }
}
