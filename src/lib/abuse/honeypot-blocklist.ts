import "server-only";

import { createHmac } from "node:crypto";
import { sharedRedisClient } from "@/lib/redis";

/**
 * The lightweight half of the honeypot: the blocklist itself.
 *
 * Kept separate from `honeypot.ts` so the proxy can import it without pulling
 * the audit chain, the database client or the alerting path into the pre-route
 * layer. The proxy needs one cheap question — "is this source blocked?" — and
 * nothing else.
 *
 * The identifiers are HMACs under a server secret, not bare SHA-256: an E.164
 * number is enumerable, so an unsalted digest of it is reversible by anyone who
 * can read the Redis set or the audit hashes.
 */

const BLOCK_MS = 24 * 60 * 60 * 1000;
const MISS_MS = 30_000;
const MAX_TRACKED = 10_000;
const KEY_PREFIX = "sv:honeypot:block:";
const SCAMMER_SET = "sv:honeypot:scammer_numbers";

const HASH_SECRET =
  process.env.HONEYPOT_HASH_SECRET?.trim() ||
  process.env.AUTH_SECRET?.trim() ||
  "dev-honeypot-not-for-production";

const blocks = new Map<string, number>();
const misses = new Map<string, number>();
const scammerHashes = new Set<string>();

/** Hash an identifier before it is stored, logged or sent to Redis. */
export function hashIdentifier(identifier: string): string {
  return createHmac("sha256", HASH_SECRET).update(identifier).digest("hex").slice(0, 24);
}

/** Drop expired entries and enforce a hard cap if a source rotates identifiers. */
function prune(now: number): void {
  if (blocks.size > MAX_TRACKED) {
    for (const [key, until] of blocks) if (until <= now) blocks.delete(key);
    while (blocks.size > MAX_TRACKED) {
      const first = blocks.keys().next().value;
      if (first === undefined) break;
      blocks.delete(first);
    }
  }
  if (misses.size > MAX_TRACKED) {
    for (const [key, until] of misses) if (until <= now) misses.delete(key);
    while (misses.size > MAX_TRACKED) {
      const first = misses.keys().next().value;
      if (first === undefined) break;
      misses.delete(first);
    }
  }
  if (scammerHashes.size > MAX_TRACKED) {
    while (scammerHashes.size > MAX_TRACKED) {
      const first = scammerHashes.values().next().value;
      if (first === undefined) break;
      scammerHashes.delete(first);
    }
  }
}

export async function recordHoneypotBlock(ip: string): Promise<string> {
  const now = Date.now();
  prune(now);
  const key = hashIdentifier(ip);
  blocks.set(key, now + BLOCK_MS);
  misses.delete(key);
  try {
    const redis = await sharedRedisClient();
    if (redis) await redis.set(`${KEY_PREFIX}${key}`, "1", "PX", BLOCK_MS);
  } catch {
    // Local memory is still enforcement for this process; the caller logs the
    // degraded mode. A trap that cannot write the shared store still blocks.
  }
  return key;
}

/** Is this source currently blocked by a decoy hit? */
export async function isHoneypotBlocked(ip: string): Promise<boolean> {
  const key = hashIdentifier(ip);
  const now = Date.now();
  const until = blocks.get(key);
  if (until !== undefined) {
    if (until > now) return true;
    blocks.delete(key);
  }

  let redis: Awaited<ReturnType<typeof sharedRedisClient>> = null;
  try {
    redis = await sharedRedisClient();
  } catch {
    redis = null;
  }

  if (!redis) {
    // Local mode only: a short negative cache is safe because no other
    // replica can hold a newer block.
    const miss = misses.get(key);
    if (miss !== undefined && miss > now) return false;
    misses.set(key, now + MISS_MS);
    prune(now);
    return false;
  }

  // Shared mode deliberately has NO negative cache: another replica can record
  // a hit while this process last saw a miss, and a stale miss would admit the
  // blocked source until it expired.
  try {
    const ttl = await redis.pttl(`${KEY_PREFIX}${key}`);
    if (ttl > 0) {
      blocks.set(key, now + ttl);
      return true;
    }
    if (ttl === -1) {
      // A key without an expiry is still a block; use the standard window.
      blocks.set(key, now + BLOCK_MS);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function recordScammerHash(key: string): Promise<void> {
  prune(Date.now());
  scammerHashes.add(key);
  try {
    const redis = await sharedRedisClient();
    if (redis) await redis.sadd(SCAMMER_SET, key);
  } catch {
    // Memory retains the capture for this process; the caller logs it.
  }
}

/**
 * Was this caller captured by the voice decoy? The inbound route uses this to
 * refuse a known decoy caller before it reaches a tenant's line.
 */
export async function isScammerNumber(phone: string): Promise<boolean> {
  const clean = phone.trim();
  if (!clean) return false;
  const key = hashIdentifier(clean);
  if (scammerHashes.has(key)) return true;
  try {
    const redis = await sharedRedisClient();
    if (!redis) return false;
    return (await redis.sismember(SCAMMER_SET, key)) === 1;
  } catch {
    return false;
  }
}

/** Test seam. The shared Redis list is intentionally not deleted here. */
export function _resetHoneypotForTest(): void {
  blocks.clear();
  misses.clear();
  scammerHashes.clear();
}
