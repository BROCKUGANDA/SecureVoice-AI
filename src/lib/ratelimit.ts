import "server-only";
/**
 * Token-bucket rate limiter with a pluggable store backend.
 *
 * Default: in-process Map (single-instance deployments).
 * Swap for Redis: implement the RateLimitStore interface and call
 * `setRateLimitStore()` at boot — no call-site changes needed.
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
  | { ok: true; remaining: number; resetMs: number }
  | { ok: false; retryAfterMs: number; remaining: 0; resetMs: number };

/**
 * Pluggable store interface. Implement this with Redis/Upstash for
 * multi-instance deployments. The default InMemoryStore is fine for
 * single-instance (the SecureVoice reference architecture).
 */
export interface RateLimitStore {
  consume(
    scope: string,
    id: string,
    cost: number,
    capacity: number,
    refillPerSec: number,
  ): ConsumeResult;
}

/* ── In-memory store (default) ── */

const BUCKETS = new Map<string, Bucket>();

// A bucket fully refills in at most 2h at the default rate — anything idle
// longer than that is equivalent to a fresh bucket and can be evicted.
const STALE_MS = 2 * 60 * 60 * 1000;
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
  consume(
    scope: string,
    id: string,
    cost: number,
    capacity: number,
    refillPerSec: number,
  ): ConsumeResult {
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
      return { ok: true, remaining: Math.floor(b.tokens), resetMs };
    }
    const deficit = cost - b.tokens;
    const retryAfterMs = Math.ceil((deficit / refillPerSec) * 1000);
    return { ok: false, retryAfterMs, remaining: 0, resetMs: retryAfterMs };
  }
}

let store: RateLimitStore = new InMemoryStore();

/** Swap the store backend (call once at boot for Redis/etc). */
export function setRateLimitStore(s: RateLimitStore): void {
  store = s;
}

/**
 * Try to consume `cost` tokens for (scope, id). Always returns within O(1)
 * and never throws.
 *
 * `capacityPerHour` lets a caller ask for a budget appropriate to its own
 * traffic rather than inheriting RATE_LIMIT_PER_HOUR. That default is sized for
 * expensive metered calls (TTS/ASR/agent turns), so reusing it for a per-request
 * edge check would rate-limit ordinary page navigation on those same numbers —
 * a demo visitor would be locked out after a handful of requests. Omit it and
 * the historical behaviour is unchanged.
 */
export function consume(
  scope: string,
  id: string,
  cost = 1,
  capacityPerHour?: number,
): ConsumeResult {
  // Parens are required: `??` cannot be mixed with `||` without them. An explicit
  // capacity wins even when it is 0 — 0 is a legitimate "allow nothing" budget,
  // which a falsy fallback would silently turn into the default.
  const capacity = capacityPerHour ?? (Number(process.env.RATE_LIMIT_PER_HOUR) || 60);
  const refillPerSec = capacity / 3600;
  return store.consume(scope, id, cost, capacity, refillPerSec);
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

/* ── Redis store template (reference — not wired by default) ──

import Redis from "ioredis";

export class RedisStore implements RateLimitStore {
  private redis: Redis;
  constructor(redis: Redis) { this.redis = redis; }

  async consume(scope, id, cost, capacity, refillPerSec): Promise<ConsumeResult> {
    const key = `rl:${safeId(scope)}:${safeId(id)}`;
    // Lua script: atomic refill + check-and-decrement
    const script = `
      local key = KEYS[1]
      local cost = tonumber(ARGV[1])
      local capacity = tonumber(ARGV[2])
      local refillPerSec = tonumber(ARGV[3])
      local now = tonumber(ARGV[4])
      local data = redis.call("HMGET", key, "tokens", "last")
      local tokens = tonumber(data[1]) or capacity
      local last = tonumber(data[2]) or now
      local elapsed = (now - last) / 1000
      tokens = math.min(capacity, tokens + elapsed * refillPerSec)
      if tokens >= cost then
        tokens = tokens - cost
        redis.call("HMSET", key, "tokens", tokens, "last", now)
        redis.call("EXPIRE", key, 7200)
        return {1, math.floor(tokens)}
      end
      local deficit = cost - tokens
      local retry = math.ceil(deficit / refillPerSec * 1000)
      return {0, retry}
    `;
    const [ok, val] = await this.redis.eval(script, 1, key, cost, capacity, refillPerSec, Date.now()) as [number, number];
    return ok === 1
      ? { ok: true, remaining: val, resetMs: 0 }
      : { ok: false, retryAfterMs: val, remaining: 0, resetMs: val };
  }
}

*/
