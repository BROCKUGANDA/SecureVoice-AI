/**
 * Idempotency wrapper for upstream-billing API calls (ElevenLabs TTS, ASR,
 * agent turns). Persists (scope, key, callerId) → response in SQLite for 24h
 * so a network retry returns the cached answer instead of a second billable
 * upstream call.
 *
 * Concurrency: SQLite enforces the unique constraint on (scope, key, callerId).
 * The first writer wins; concurrent same-key requests get a 200ms wait loop
 * that resolves once the first writer commits, then returns the stored response.
 *
 * The wrapper's return type preserves the upstream's response shape (TTS
 * returns audio Buffer; ASR/agent return objects). Callers wrap a fetch:
 *
 *   const result = await withIdempotency({ scope: "tts", key, callerId, fn })
 *   // result.replayed === true means no upstream call was made
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";

const TTL_HOURS = 24;
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;
const CONCURRENCY_WAIT_MS = 200;
const MAX_CONCURRENCY_WAIT_MS = 5000;

export type IdempotencyOptions<T> = {
  scope: "tts" | "tts-upstream" | "asr" | "agent";
  key: string | Buffer; // canonical request bytes — caller hashes if needed
  callerId: string;
  fn: () => Promise<T>;
  /** Optional transform to serialize T for storage. Default: JSON.stringify. */
  serialize?: (v: T) => string;
  /** Optional inverse of serialize. Default: JSON.parse. */
  deserialize?: (s: string) => T;
};

export type IdempotencyResult<T> = {
  value: T;
  replayed: boolean;
  key: string; // canonical hash stored
};

function hashKey(raw: string | Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() <= Date.now();
}

export async function withIdempotency<T>(opts: IdempotencyOptions<T>): Promise<IdempotencyResult<T>> {
  const key = hashKey(opts.key);
  const serialize = opts.serialize ?? ((v: T) => JSON.stringify(v));
  const deserialize = opts.deserialize ?? ((s: string) => JSON.parse(s) as T);

  // Fast path: replay
  const hit = await db.idempotencyKey.findUnique({
    where: { scope_key_callerId: { scope: opts.scope, key, callerId: opts.callerId } },
  });
  if (hit && !isExpired(hit.expiresAt)) {
    return { value: deserialize(hit.response), replayed: true, key };
  }

  // Slow path: execute, then attempt to persist
  const value = await opts.fn();
  const expiresAt = new Date(Date.now() + TTL_MS);
  try {
    await db.idempotencyKey.create({
      data: {
        scope: opts.scope,
        key,
        callerId: opts.callerId,
        response: serialize(value),
        statusCode: 200,
        expiresAt,
      },
    });
    return { value, replayed: false, key };
  } catch (err: unknown) {
    // Unique constraint — a concurrent request won. Wait for its write.
    const start = Date.now();
    while (Date.now() - start < MAX_CONCURRENCY_WAIT_MS) {
      const winner = await db.idempotencyKey.findUnique({
        where: { scope_key_callerId: { scope: opts.scope, key, callerId: opts.callerId } },
      });
      if (winner && !isExpired(winner.expiresAt)) {
        return { value: deserialize(winner.response), replayed: true, key };
      }
      await new Promise((r) => setTimeout(r, CONCURRENCY_WAIT_MS));
    }
    // Fallback: serve the fresh result even though we couldn't cache it
    return { value, replayed: false, key };
  }
}

/** Best-effort eviction of expired keys. Call from a cron or boot path. */
export async function evictExpired(): Promise<number> {
  const r = await db.idempotencyKey.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return r.count;
}