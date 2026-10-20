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
import { PRISMA } from "@/lib/failures/db-failures";
import {
  IDEMPOTENCY_CLAIM_TTL_MS,
  IDEMPOTENCY_MAX_POLL_MS,
  IDEMPOTENCY_POLL_MS,
  IDEMPOTENCY_TTL_HOURS,
} from "@/lib/config";

const TTL_MS = IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;

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

  // If the existing row is EXPIRED, delete it so we can re-claim. A live claim
  // is deliberately left in place: the caller below then loses the INSERT race
  // and waits for the winner, which is the entire point of the claim. Deleting
  // an unexpired claim here (the old condition was `isClaim(hit)`, with no
  // expiry test) let a second request remove a healthy in-flight claim and run
  // `fn()` concurrently with the request that still owned it — the exact
  // duplicate billable call this wrapper exists to prevent.
  if (hit && isExpired(hit.expiresAt)) {
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
        // a claim older than 30s is abandoned (crashed worker)
        expiresAt: new Date(Date.now() + IDEMPOTENCY_CLAIM_TTL_MS),
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
  // slightly above CLAIM_TTL so we catch late winners
  while (Date.now() - start < IDEMPOTENCY_MAX_POLL_MS) {
    await new Promise((r) => setTimeout(r, IDEMPOTENCY_POLL_MS));
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

/**
 * A unique violation, as this stack actually reports one.
 *
 * This used to test `code === "23505"` — the PostgreSQL code — while Prisma raises
 * `PrismaClientKnownRequestError` with `P2002`. The helper could never have fired,
 * and because nothing called it, nothing noticed. `case-state-machine.ts` documents
 * the same trap from the inside: a catch keyed on a code the runtime never emits
 * "silently never fire[s] — which is the worst possible failure mode for a guard
 * that exists to convert a 500 into a typed refusal."
 *
 * Both codes are accepted rather than one. Under the pg adapter the driver's own
 * SQLSTATE reaches the caller on some paths, and the shape this function exists to
 * distinguish is expected-race versus real-failure; a miss costs an error log, a
 * false hit costs the log that would have reported a broken store.
 *
 * Its last in-tree production caller (`withIdempotencyFast`) was deleted as dead
 * surface in the 2026-10-17 knob audit. It stays because two modules re-implement
 * this predicate inline (`src/lib/case-state-machine.ts:367`,
 * `src/lib/auth/store.ts:104`) and `tests/unit/idempotency-unique-violation.test.ts`
 * pins both codes; it is the canonical answer until those duplicates fold into it.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === PRISMA.UNIQUE_CONSTRAINT || code === "23505";
}
