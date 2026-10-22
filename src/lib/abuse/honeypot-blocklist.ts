import "server-only";

import { createHash } from "node:crypto";
import { sharedRedisClient } from "@/lib/redis";

/**
 * The lightweight half of the honeypot: the blocklist itself.
 *
 * Kept separate from `honeypot.ts` so the proxy can import it without pulling
 * the audit chain, the database client or the alerting path into the pre-route
 * layer. The proxy needs one cheap question — "is this source blocked?" — and
 * nothing else.
 */

const BLOCK_MS = 24 * 60 * 60 * 1000;
const MISS_MS = 30_000;
const KEY_PREFIX = "sv:honeypot:block:";
const SCAMMER_SET = "sv:honeypot:scammer_numbers";

const blocks = new Map<string, number>();
const misses = new Map<string, number>();
const scammerHashes = new Set<string>();

/** Hash an identifier before it is stored, logged or sent to Redis. */
export function hashIdentifier(identifier: string): string {
  return createHash("sha256").update(identifier).digest("hex").slice(0, 24);
}

/** Already-known hashes, for a test that needs to verify a capture. */
export function hasScammerHash(hash: string): boolean {
  return scammerHashes.has(hash);
}

export async function recordHoneypotBlock(ip: string): Promise<string> {
  const key = hashIdentifier(ip);
  blocks.set(key, Date.now() + BLOCK_MS);
  misses.delete(key);
  try {
    const redis = await sharedRedisClient();
    if (redis) await redis.set(`${KEY_PREFIX}${key}`, "1", "PX", BLOCK_MS);
  } catch {
    // Local memory is still enforcement for this process; the caller logs the
    // degraded mode. Fail open is not an option here, so the local block stays.
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

  const miss = misses.get(key);
  if (miss !== undefined && miss > now) return false;

  try {
    const redis = await sharedRedisClient();
    if (!redis) {
      misses.set(key, now + MISS_MS);
      return false;
    }
    const hit = await redis.exists(`${KEY_PREFIX}${key}`);
    if (hit) {
      blocks.set(key, now + BLOCK_MS);
      return true;
    }
    misses.set(key, now + MISS_MS);
    return false;
  } catch {
    // A missing shared store must not put a Redis timeout in front of every
    // request. Cache the miss briefly and let a later request retry.
    misses.set(key, now + MISS_MS);
    return false;
  }
}

export async function recordScammerHash(key: string): Promise<void> {
  scammerHashes.add(key);
  try {
    const redis = await sharedRedisClient();
    if (redis) await redis.sadd(SCAMMER_SET, key);
  } catch {
    // Memory retains the capture for this process; the caller logs it.
  }
}

/** Test seam. The shared Redis list is intentionally not deleted here. */
export function _resetHoneypotForTest(): void {
  blocks.clear();
  misses.clear();
  scammerHashes.clear();
}
