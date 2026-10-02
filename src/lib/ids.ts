/**
 * Id generators (WP-18) — a ULID implementation, real and seeded.
 *
 * A ULID is 26 characters of Crockford base32: 10 characters of millisecond
 * timestamp followed by 16 characters of randomness. Two properties matter here
 * and neither is about entropy:
 *
 *   1. **Lexicographic order is creation order.** A database insert, an audit
 *      chain or an evidence file can all sort by id and get the right answer
 *      without a separate sequence column. That is why ids, not `createdAt`,
 *      are the tiebreaker everywhere a chain picks a head.
 *   2. **`next()` is reproducible under a seed.** The seeded generator's
 *      entropy is derived from `sha256(seed)` and a counter, never from
 *      `Math.random()`, so the same seed replays the same sequence forever.
 *      That is the whole reason the evidence bundle is byte-stable.
 *
 * The real generator draws from `crypto.randomBytes` and bumps the random part
 * within the same millisecond, so two calls in one tick still sort in call
 * order. The seeded generator preserves BOTH properties: it is deterministic and
 * it is monotonic, because a fake that lost the ordering property would quietly
 * break every test that sorts ids and expects insertion order.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "@/lib/ports/types";
import { systemClock } from "@/lib/clock";

/** Crockford base32: no I, L, O or U, so a human can read one aloud. */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ULID_LENGTH = 26;
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const ENTROPY_BYTES = 10;
/** Guards the time component; a ULID stops being sortable past this date. */
const MAX_TIMESTAMP_MS = 281_474_976_710_655;

export const SYSTEM_IDS_ID = "ids.system.ulid";
export const SEEDED_IDS_ID = "ids.seeded.ulid";

/** Encode a nonnegative integer as fixed-width Crockford base32, MSB first. */
export function encodeBase32(value: number, length: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`encodeBase32 requires a non-negative safe integer (got ${String(value)})`);
  }
  let out = "";
  let n = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  if (n > 0) throw new RangeError(`value does not fit in ${length} base32 characters`);
  return out;
}

/** The 10-character time prefix of a ULID, as milliseconds. */
export function decodeUlidTime(ulid: string): number {
  const prefix = assertUlid(ulid).slice(0, TIME_CHARS);
  let n = 0;
  for (const ch of prefix) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) throw new TypeError(`ULID time prefix is not Crockford base32: ${prefix}`);
    n = n * 32 + idx;
  }
  return n;
}

export function assertUlid(ulid: string): string {
  if (typeof ulid !== "string" || ulid.length !== ULID_LENGTH) {
    throw new TypeError(`ULID must be a ${ULID_LENGTH}-character string (got ${JSON.stringify(ulid)})`);
  }
  for (const ch of ulid) {
    if (CROCKFORD.indexOf(ch) < 0) throw new TypeError(`ULID contains a non-Crockford character: ${ch}`);
  }
  return ulid;
}

/** Encode 10 entropy bytes as the 16-character ULID randomness part. */
function encodeEntropy(bytes: Uint8Array): string {
  if (bytes.length !== ENTROPY_BYTES) {
    throw new RangeError(`ULID entropy needs ${ENTROPY_BYTES} bytes (got ${bytes.length})`);
  }
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < RANDOM_CHARS; i++) {
    out = CROCKFORD[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/**
 * Add one to a little-endian byte counter, saturating rather than wrapping.
 * Saturation rather than wraparound on purpose: a wrapped counter would hand
 * out an id already issued in this millisecond.
 */
function bumpEntropy(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] === 0xff) {
      bytes[i] = 0x00;
      continue;
    }
    bytes[i] += 1;
    return;
  }
  throw new RangeError("ULID entropy exhausted: more than 2^80 ids in one millisecond");
}

/** Real ids: 80 bits from the CSPRNG, bumped within a millisecond. */
export function ulidGenerator(clock: Clock = systemClock()): {
  next(): string;
  readonly adapterId: string;
  readonly mode: "real";
} {
  let lastMs = -1;
  let entropy = randomBytes(ENTROPY_BYTES);
  return {
    adapterId: SYSTEM_IDS_ID,
    mode: "real",
    next(): string {
      const ms = clock.now().getTime();
      if (ms > lastMs) {
        lastMs = ms;
        entropy = randomBytes(ENTROPY_BYTES);
      } else {
        bumpEntropy(entropy);
      }
      if (ms > MAX_TIMESTAMP_MS) throw new RangeError(`ULID timestamp out of range (${ms})`);
      return encodeBase32(ms, TIME_CHARS) + encodeEntropy(entropy);
    },
  };
}

export type SeededIdGenerator = {
  readonly adapterId: string;
  readonly mode: "fake";
  /** The seed, verbatim. Recorded in the descriptor so a report can quote it. */
  readonly seed: string;
  /** How many ids have been minted. Part of the reproducible trace. */
  issued(): number;
  next(): string;
};

/**
 * Seeded ids: deterministic AND monotonic.
 *
 * `sha256(seed)` seeds a counter whose successive states are
 * `sha256(seed || previous-block)`. The 80-bit entropy for the first id in a
 * millisecond is the leading ten bytes of the current block; two more ids in the
 * SAME millisecond bump those bytes by one and by two, so the sequence is
 * strictly increasing exactly as the CSPRNG generator's is.
 *
 * The block advances only when the clock moves FORWARD. Walk the clock
 * backwards and the counter resumes where it was, so a replay of an earlier
 * instant replays the ids that instant produced, and no id is ever handed out
 * twice.
 */
export function seededUlidGenerator(seed: string, clock: Clock = systemClock()): SeededIdGenerator {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new TypeError("seededUlidGenerator requires a non-empty seed string");
  }
  let block = createHash("sha256").update(seed).digest();
  let lastMs = -1;
  let bumps = 0;
  let entropy: Uint8Array | null = null;
  let issuedCount = 0;

  return {
    adapterId: SEEDED_IDS_ID,
    mode: "fake",
    seed,
    issued: () => issuedCount,
    next(): string {
      const ms = clock.now().getTime();
      if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIMESTAMP_MS) {
        throw new RangeError(`ULID timestamp out of range (${ms})`);
      }
      if (ms > lastMs) {
        block = createHash("sha256").update(seed).update(block).digest();
        lastMs = ms;
        entropy = Uint8Array.from(block.subarray(0, ENTROPY_BYTES));
        bumps = 0;
      } else {
        // Same or earlier millisecond. `entropy` is non-null here because any
        // real clock yields ms > -1 on the first call.
        if (!entropy) {
          block = createHash("sha256").update(seed).update(block).digest();
          entropy = Uint8Array.from(block.subarray(0, ENTROPY_BYTES));
        }
        bumps += 1;
        for (let i = 0; i < bumps; i++) bumpEntropy(entropy);
      }
      issuedCount += 1;
      return encodeBase32(ms, TIME_CHARS) + encodeEntropy(entropy);
    },
  };
}