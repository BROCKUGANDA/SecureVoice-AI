import "server-only";
/**
 * Per-API-key character-usage tracking.
 *
 * ## Why this exists
 *
 * The pool (./pool.ts) rotates across several ElevenLabs keys precisely because
 * each key has its OWN quota. That only helps if the platform can SEE per-key
 * spend: without it, an operator cannot tell which key is about to be exhausted,
 * which one is carrying the load, or whether a key has quietly stopped working.
 * This module is that ledger — characters synthesised, calls made, and the daily
 * figure, all keyed per API key, in the shared Redis meter.
 *
 * ## The raw key never reaches the store
 *
 * A Redis key is durable, replicated and readable by anything with the URL, so
 * an API key must never be part of one. Every entry is addressed by
 * `hashKey(key)` — a truncated SHA-256 — so the ledger can be exported, logged or
 * inspected without containing a credential. That is also why `getKeyUsage`
 * returns a `keyHash` and never the key.
 *
 * ## Reading from a write-only meter
 *
 * `src/lib/redis.ts` exposes a `Meter` of atomic COUNTERS (`incrBy`/`decrBy`/
 * `expire`) — there is no `get`. Rather than bolt a new method onto a shared core
 * that several modules import, the read primitive here is `incrBy(key, 0)`: both
 * backends return the current value, it leaves an existing key's TTL untouched,
 * and it is the same call the writer already makes. The one visible consequence
 * is that reading a key that was never written materialises a zero-valued
 * counter — harmless, and exactly the `0` a caller would have computed anyway.
 *
 * ## Accounting must never break a call
 *
 * This is observability, not a gate, so neither function ever throws. A Redis
 * outage falls back to an in-process mirror (the same philosophy as
 * `degradedMeter` in src/lib/redis.ts) and the snapshot reports `via: "local"`
 * so a caller can tell a durable number from a per-process one. A cost meter
 * that can take down a fraud call is worse than a cost meter that under-reports.
 */

import { createHash } from "node:crypto";

import { redis } from "@/lib/redis";
import { logWarn } from "@/lib/validation/safe-log";

/** Namespace for every counter this module writes. */
export const KEY_USAGE_PREFIX = "elevenlabs:key_usage";

/** Lifetime counters outlive a billing cycle; a year of slack is plenty. */
const TOTAL_TTL_SEC = 400 * 24 * 60 * 60;
/** Daily counters only need to outlive their day; two days covers a late read. */
const DAILY_TTL_SEC = 2 * 24 * 60 * 60;

/** A snapshot of one key's usage. Contains no key material by construction. */
export type KeyUsage = {
  /** Stable, non-reversible id for the key (truncated SHA-256 of the key). */
  keyHash: string;
  /** Lifetime characters synthesised on this key. */
  chars: number;
  /** Lifetime synthesis calls attributed to this key. */
  calls: number;
  /** Characters synthesised today (UTC). */
  dailyChars: number;
  /** The UTC day the daily figure covers, `YYYY-MM-DD`. */
  day: string;
  /** Best-effort last-use time from this process, or null if unseen here. */
  lastUsedAt: number | null;
  /** `shared` = the durable Redis meter answered; `local` = the in-process mirror. */
  via: "shared" | "local";
};

/**
 * The address of a key in the ledger. SHA-256, truncated to 32 hex chars — long
 * enough that a collision is not a concern, short enough to keep Redis keys
 * readable. One-way: the ledger can never be turned back into a credential.
 */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** The UTC day a write belongs to. UTC, so two instances never disagree. */
function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const charsKey = (h: string): string => `${KEY_USAGE_PREFIX}:${h}:chars`;
const callsKey = (h: string): string => `${KEY_USAGE_PREFIX}:${h}:calls`;
const dailyKey = (h: string, day: string): string => `${KEY_USAGE_PREFIX}:${h}:chars:${day}`;

/**
 * Per-process fallback figures, used only when the durable meter cannot answer.
 * Keyed by `keyHash`. Carries the same fields as the durable counters so a
 * degraded read is still a usable number rather than a hole.
 */
type MirrorEntry = {
  chars: number;
  calls: number;
  dailyChars: number;
  day: string;
  lastUsedAt: number;
};
const mirror = new Map<string, MirrorEntry>();

/** Coerce a caller-supplied count into a non-negative integer of characters. */
function normaliseChars(chars: number): number {
  return Number.isFinite(chars) ? Math.max(0, Math.trunc(chars)) : 0;
}

/**
 * Record `chars` of synthesis against `key` and return the updated snapshot.
 *
 * Never throws: a meter failure degrades to the in-process mirror and is logged,
 * so a live synthesis is never failed by its own accounting.
 *
 * @param key   The API key the synthesis ran on. Hashed before it is stored.
 * @param chars Characters billed to that key (the ElevenLabs billable unit).
 */
export async function trackKeyUsage(key: string, chars: number): Promise<KeyUsage> {
  const amount = normaliseChars(chars);
  const h = hashKey(key);
  const day = utcDay();
  const prior = mirror.get(h);

  try {
    const [total, calls, daily] = await Promise.all([
      redis.incrBy(charsKey(h), amount),
      redis.incrBy(callsKey(h), 1),
      redis.incrBy(dailyKey(h, day), amount),
    ]);
    // TTLs are best-effort: a counter that cannot be expired is still a correct
    // counter, so a failure here must not turn a good write into an error.
    await Promise.all([
      redis.expire(charsKey(h), TOTAL_TTL_SEC),
      redis.expire(callsKey(h), TOTAL_TTL_SEC),
      redis.expire(dailyKey(h, day), DAILY_TTL_SEC),
    ]).catch(() => undefined);

    const lastUsedAt = Date.now();
    mirror.set(h, { chars: total, calls, dailyChars: daily, day, lastUsedAt });
    return {
      keyHash: h,
      chars: total,
      calls,
      dailyChars: daily,
      day,
      lastUsedAt,
      via: redis.mode(),
    };
  } catch (err) {
    logWarn("[elevenlabs/token-tracker] meter write failed, using in-process mirror", {
      keyHash: h,
      error: err instanceof Error ? err.message : String(err),
    });
    const next: MirrorEntry = {
      chars: (prior?.chars ?? 0) + amount,
      calls: (prior?.calls ?? 0) + 1,
      // A mirror entry from a previous day must not carry its total into today.
      dailyChars: (prior?.day === day ? (prior.dailyChars ?? 0) : 0) + amount,
      day,
      lastUsedAt: Date.now(),
    };
    mirror.set(h, next);
    return {
      keyHash: h,
      chars: next.chars,
      calls: next.calls,
      dailyChars: next.dailyChars,
      day,
      lastUsedAt: next.lastUsedAt,
      via: "local",
    };
  }
}

/**
 * Read the current usage for `key`. Never throws — a meter failure returns the
 * in-process mirror with `via: "local"`, or zeros when this process has never
 * seen the key.
 *
 * @param key The API key to look up. Hashed before it is read.
 */
export async function getKeyUsage(key: string): Promise<KeyUsage> {
  const h = hashKey(key);
  const day = utcDay();
  const prior = mirror.get(h);

  try {
    // `incrBy(key, 0)` is the read primitive of the counter-only Meter: it
    // returns the current value and does not disturb an existing key's TTL.
    const [total, calls, daily] = await Promise.all([
      redis.incrBy(charsKey(h), 0),
      redis.incrBy(callsKey(h), 0),
      redis.incrBy(dailyKey(h, day), 0),
    ]);
    return {
      keyHash: h,
      chars: total,
      calls,
      dailyChars: daily,
      day,
      lastUsedAt: prior?.lastUsedAt ?? null,
      via: redis.mode(),
    };
  } catch (err) {
    logWarn("[elevenlabs/token-tracker] meter read failed, using in-process mirror", {
      keyHash: h,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      keyHash: h,
      chars: prior?.chars ?? 0,
      calls: prior?.calls ?? 0,
      dailyChars: prior?.day === day ? (prior.dailyChars ?? 0) : 0,
      day,
      lastUsedAt: prior?.lastUsedAt ?? null,
      via: "local",
    };
  }
}

/**
 * Reset the in-process mirror. Suites that assert on `via: "local"` figures need
 * this so one test's fallback counters do not leak into the next.
 */
export function _resetTokenTrackerForTest(): void {
  mirror.clear();
}
