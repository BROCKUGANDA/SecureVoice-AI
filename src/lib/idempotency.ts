import "server-only";
/**
 * Idempotency wrapper for upstream-billing API calls (ElevenLabs TTS, ASR,
 * agent turns). Persists (scope, key, callerId) → response in Postgres for 24h
 * so a network retry returns the cached answer instead of a second billable
 * upstream call.
 *
 * Concurrency (claim pattern):
 *   1. Fast path — read existing completed row, replay if present.
 *   2. Claim — INSERT a row with response="" and a 30s claim TTL.
 *      First INSERT wins the claim; a unique-constraint violation means a
 *      concurrent request already claimed it.
 *   3. Execute — the claim winner calls fn() (the billable upstream call).
 *   4. Finalise — UPDATE the claim row with the real response.
 *   5. If we lost the claim — poll (200ms intervals, 5s max) for the winner
 *      to fill in the response, then replay it.
 *
 * This eliminates the TOCTOU race where two concurrent requests both miss the
 * fast path and both make billable upstream calls.
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
const CLAIM_TTL_MS = 30_000; // a claim older than 30s is abandoned (crashed worker)
const POLL_INTERVAL_MS = 200;
const MAX_POLL_MS = 8_000; // slightly above CLAIM_TTL so we catch late winners

export type IdempotencyOptions<T> = {
  scope: "tts" | "tts-upstream" | "tts-stream" | "asr" | "agent" | "interventions";
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

/** A row with an empty response string is an in-flight claim, not a result. */
function isClaim(row: { response: string }): boolean {
  return row.response === "";
}

/** Deserialize a stored response; a corrupt row is treated as absent (and
 *  deleted) rather than 500ing every replay of that key for 24h. */
function tryDeserialize<T>(
  deserialize: (s: string) => T,
  s: string,
): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: deserialize(s) };
  } catch {
    return { ok: false };
  }
}

export async function withIdempotency<T>(
  opts: IdempotencyOptions<T>,
): Promise<IdempotencyResult<T>> {
  const key = hashKey(opts.key);
  const serialize = opts.serialize ?? ((v: T) => JSON.stringify(v));
  const deserialize = opts.deserialize ?? ((s: string) => JSON.parse(s) as T);
  const where = { scope_key_callerId: { scope: opts.scope, key, callerId: opts.callerId } };

  // ── 1. Fast path: a completed row exists → replay ──
  const hit = await db.idempotencyKey.findUnique({ where });
  if (hit && !isExpired(hit.expiresAt) && !isClaim(hit)) {
    const parsed = tryDeserialize(deserialize, hit.response);
    if (parsed.ok) return { value: parsed.value, replayed: true, key };
    // Corrupt stored response — drop it and re-claim below.
    await db.idempotencyKey.delete({ where: { id: hit.id } }).catch(() => {});
  }

  // If the existing row is expired or a stale claim, delete it so we can
  // re-claim. (An expired claim means the previous worker crashed mid-flight.)
  if (hit && (isExpired(hit.expiresAt) || isClaim(hit))) {
    await db.idempotencyKey.delete({ where: { id: hit.id } }).catch(() => {});
  }

  // ── 2. Claim: try to INSERT a placeholder row ──
  let claimed = false;
  try {
    await db.idempotencyKey.create({
      data: {
        scope: opts.scope,
        key,
        callerId: opts.callerId,
        response: "", // empty = in-flight claim
        statusCode: 0,
        expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
      },
    });
    claimed = true;
  } catch {
    // Unique constraint — a concurrent request already claimed this key.
    claimed = false;
  }

  if (claimed) {
    // ── 3. We own the claim → execute the billable upstream call ──
    try {
      const value = await opts.fn();
      // ── 4. Finalise: replace the claim with the real response ──
      await db.idempotencyKey.update({
        where: { scope_key_callerId: where.scope_key_callerId },
        data: {
          response: serialize(value),
          statusCode: 200,
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      });
      return { value, replayed: false, key };
    } catch (err) {
      // fn() threw — release the claim so a retry can proceed immediately
      await db.idempotencyKey
        .delete({ where: { scope_key_callerId: where.scope_key_callerId } })
        .catch(() => {});
      throw err;
    }
  }

  // ── 5. Lost the claim → poll for the winner's result ──
  const start = Date.now();
  while (Date.now() - start < MAX_POLL_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const winner = await db.idempotencyKey.findUnique({ where });
    if (winner && !isExpired(winner.expiresAt) && !isClaim(winner)) {
      const parsed = tryDeserialize(deserialize, winner.response);
      if (parsed.ok) return { value: parsed.value, replayed: true, key };
      await db.idempotencyKey.delete({ where: { id: winner.id } }).catch(() => {});
      break; // corrupt winner row — fall through to executing our own call
    }
    // The winner's claim expired without filling in — they crashed. Take over.
    if (winner && isClaim(winner) && isExpired(winner.expiresAt)) {
      await db.idempotencyKey.delete({ where: { id: winner.id } }).catch(() => {});
      break; // loop back conceptually — caller will retry on next request
    }
  }

  // Poll timed out — the winner is still working. Execute our own call as a
  // safe fallback (worst case: one duplicate upstream call, never zero).
  const value = await opts.fn();
  return { value, replayed: false, key };
}

/** Best-effort eviction of expired keys. Call from a cron or boot path. */
export async function evictExpired(): Promise<number> {
  const r = await db.idempotencyKey.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return r.count;
}

/**
 * Fast-path idempotency for mutating endpoints where the key is unique per
 * request (e.g. a bank's Idempotency-Key on a risk signal). Two round-trips
 * for a new key instead of three: findUnique → create-with-response.
 *
 * Concurrency: if two requests with the same key arrive simultaneously, both
 * may execute fn(). The unique constraint on (scope, key, callerId) means
 * only one create wins; the loser polls for the winner's response. This is
 * the same safety guarantee as withIdempotency, just without the separate
 * claim row — appropriate when fn() is idempotent by construction (the
 * signal's own transaction is the real dedup).
 */
export async function withIdempotencyFast<T>(opts: {
  scope: string;
  key: string;
  callerId: string;
  fn: () => Promise<T>;
  serialize?: (v: T) => string;
  deserialize?: (s: string) => T;
}): Promise<{ value: T; replayed: boolean; key: string }> {
  const key = hashKey(opts.key);
  const serialize = opts.serialize ?? ((v: T) => JSON.stringify(v));
  const deserialize = opts.deserialize ?? ((s: string) => JSON.parse(s) as T);
  const where = { scope_key_callerId: { scope: opts.scope, key, callerId: opts.callerId } };

  // 1. Fast path: a completed row exists → replay.
  const hit = await db.idempotencyKey.findUnique({ where });
  if (hit && !isExpired(hit.expiresAt)) {
    const parsed = tryDeserialize(deserialize, hit.response);
    if (parsed.ok) return { value: parsed.value, replayed: true, key };
    await db.idempotencyKey.delete({ where: { id: hit.id } }).catch(() => {});
  }

  // 2. Execute and store. The create is fire-and-forget: the response is
  //    returned before the idempotency row lands. A replay that arrives
  //    before the create completes will re-execute fn() — acceptable because
  //    fn() is idempotent by construction (the signal's own transaction is
  //    the real dedup). This keeps the critical path to two round-trips.
  try {
    const value = await opts.fn();
    // Fire-and-forget the store. If it loses a race to a concurrent request,
    // the unique constraint fires and we log — the winner's row stands.
    void db.idempotencyKey
      .create({
        data: {
          scope: opts.scope,
          key,
          callerId: opts.callerId,
          response: serialize(value),
          statusCode: 200,
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      })
      .catch(() => {});
    return { value, replayed: false, key };
  } catch (err) {
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}
