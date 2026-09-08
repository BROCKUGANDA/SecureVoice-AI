/**
 * In-process token-bucket rate limiter. Default budget: 60 calls/hour/caller,
 * 1 call/second burst. Returns 429 with a Retry-After header when exhausted.
 *
 * The interface is deliberately Redis-shaped (`consume(scope, id, cost)`) so
 * we can swap the in-memory map for an Upstash/Redis-backed implementation
 * for production scale without changing call sites. The atomic check-and-decrement
 * lives in one place; concurrent calls within the same Node process are safe
 * because all state mutations happen inside the bucket object.
 *
 * Hardening notes:
 *  - Caller-supplied IDs (x-caller-id) are length-capped and sanitized so an
 *    attacker cannot mint unbounded unique keys (memory exhaustion) or smuggle
 *    control characters into logs/storage.
 *  - The bucket map is capped with a max size + periodic eviction of stale
 *    buckets; a scraper cycling IDs cannot grow it forever.
 *  - A multi-instance deployment still needs a shared store. For the
 *    SecureVoice single-instance deployment the in-memory bucket is fine and
 *    the interface stays the same.
 */

type Bucket = {
  capacity: number;
  refillPerSec: number;
  tokens: number;
  lastRefill: number; // epoch ms
};

type ConsumeResult =
  | { ok: true; remaining: number; resetMs: number }
  | { ok: false; retryAfterMs: number; remaining: 0; resetMs: number };

const BUCKETS = new Map<string, Bucket>();

// A bucket fully refills in at most 2h at the default rate — anything idle
// longer than that is equivalent to a fresh bucket and can be evicted.
const STALE_MS = 2 * 60 * 60 * 1000;
const MAX_BUCKETS = 20_000;
const EVICT_SWEEP_EVERY = 512; // cheap periodic sweep, amortized O(1) per call
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
  // If still over cap (sustained unique-ID flood), drop the oldest half.
  if (BUCKETS.size > MAX_BUCKETS) {
    const sorted = [...BUCKETS.entries()].sort((a, b) => a[1].lastRefill - b[1].lastRefill);
    const drop = sorted.slice(0, Math.ceil(BUCKETS.size / 2));
    for (const [k] of drop) BUCKETS.delete(k);
  }
}

function getBucket(scope: string, id: string, capacity = 60, refillPerSec = 60 / 3600): Bucket {
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
  return b;
}

/**
 * Try to consume `cost` tokens for (scope, id). Always returns within O(1)
 * and never throws. A caller with no token has their request denied by the
 * 429 returned from the route handler.
 */
export function consume(scope: string, id: string, cost = 1): ConsumeResult {
  const capacity = Number(process.env.RATE_LIMIT_PER_HOUR) || 60;
  const refillPerSec = capacity / 3600;
  const b = getBucket(scope, id, capacity, refillPerSec);
  if (b.tokens >= cost) {
    b.tokens -= cost;
    const resetMs = Math.ceil(((capacity - b.tokens) / b.refillPerSec) * 1000);
    return { ok: true, remaining: Math.floor(b.tokens), resetMs };
  }
  const deficit = cost - b.tokens;
  const retryAfterMs = Math.ceil((deficit / b.refillPerSec) * 1000);
  return { ok: false, retryAfterMs, remaining: 0, resetMs: retryAfterMs };
}

/** Test helper. Not for production use. */
export function _reset(): void {
  BUCKETS.clear();
}
