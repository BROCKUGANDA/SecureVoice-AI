/**
 * Consecutive unclear turns, counted where the counting cannot be defeated.
 *
 * A fraud call that cannot get a clear answer after four turns is a call a human
 * should be on, not a script a customer is arguing with at 2am. That rule exists
 * (`MAX_UNCLEAR_TURNS`).
 *
 * ## Why this file was rewritten rather than tweaked
 *
 * The counter keyed its streak on `callRef`, taken from the request BODY. The
 * module's own docstring claimed "not a client-chosen number, which is the whole
 * defect this replaces" — and then took one. So the guard could not fire in three
 * distinct ways:
 *
 *   1. The live browser panel omitted the ref entirely, so every judge demo turn
 *      counted as a fresh conversation and the streak was always 1. The handoff
 *      was unreachable on the plane judges actually use.
 *   2. A caller that sent a fresh `callRef` per request never reached the
 *      threshold. A guard whose input is supplied by the party it guards against
 *      is not a guard.
 *   3. The counter also grew unbounded: `sweep()` returned early unless the map
 *      was already over `MAX_TRACKED`, so below 10 000 entries nothing was ever
 *      evicted, and the only thing that trimmed it was the process exiting.
 *
 * ## What the key is now
 *
 * TWO keys, because one is not enough:
 *
 *   · `convId` — a SERVER-ISSUED opaque token. Absent from the request, the
 *     server mints one and returns it; the client echoes it back on the next turn
 *     so the streak follows the conversation. This is the normal path and it is
 *     correct: a caller who drops the token starts a new conversation, which is
 *     the honest reading of what they sent.
 *
 *   · `source` — the trust-gated caller identity, which never appears in the body
 *     and cannot be chosen by the caller (`resolveClientIp` refuses to believe
 *     any header the proxy did not set). This is the ANTI-DEFECT ceiling: a
 *     caller spinning a fresh `convId` per turn still burns the source's budget,
 *     so the cap holds against exactly the rotation that defeated the old key.
 *
 * Using only `source` would have been simpler and wrong in the other direction:
 * several analysts behind one office NAT share an address, and four collectively
 * unclear turns would hand a fifth an unwanted handoff. Using only `convId`
 * replays the original defect. Both, each doing the job it is right for.
 *
 * ## State is in-process, and says so
 *
 * Same posture as the bad-actor ladder beside it: one replica counts its own
 * turns. The media-stream worker — the plane real bank calls take — holds one
 * process per call and so is already exact. This HTTP plane is the demo and
 * preview surface, where a rolling deploy resets the streak to zero; the worst
 * case is that a cap takes one more turn to trip after a deploy, which is the
 * benign direction for a safety ceiling.
 */

import { randomUUID } from "node:crypto";

/** Per-conversation streaks. Keyed by the server-issued convId. */
const STREAKS = new Map<string, { count: number; lastSeenAt: number }>();

/**
 * Every conversation this process has issued, whether or not it ever had an
 * unclear turn.
 *
 * `STREAKS` cannot answer "is this the first turn?" because a clear turn
 * deletes its entry by design. Without this separate ledger, a client's echoed
 * `convId` would look unrecognised after every clear answer, the server would
 * mint a new conversation each turn, and an opening disclosure would be
 * injected on turn five. Only the conversation identity is recorded here —
 * never the customer's words.
 */
const CONVS = new Map<string, number>();

/**
 * Per-SOURCE budgets, the anti-rotation ceiling.
 *
 * Counted across every conversation that source has opened, so `MAX_SOURCE_UNCLEAR`
 * fresh conversations cannot buy `MAX_SOURCE_UNCLEAR * MAX_UNCLEAR_TURNS` unclear
 * turns. It resets on any clear turn from that source, for the same reason the
 * per-conversation streak does: a customer who finally says "no, that's not
 * mine" is not still carrying earlier confusion, and neither is the person behind
 * them on the same address.
 */
const SOURCES = new Map<string, { count: number; lastSeenAt: number }>();

/** Entries nobody has touched in this long are forgotten. */
const IDLE_MS = Number(process.env.CALL_TURN_IDLE_MS ?? 1_800_000);
const MAX_TRACKED = 10_000;

/**
 * Forget idle entries — ALWAYS, not only when the map is already oversized.
 *
 * The old `if (STREAKS.size <= MAX_TRACKED) return` meant that below the cap
 * nothing was ever evicted, so the map grew without bound until the process
 * restarted. Evicting unconditionally is O(n) per turn, which is the wrong shape
 * for a hot path, so this is amortised: it runs on every 256th call.
 */
let sinceSweep = 0;
function sweep(now: number): void {
  if (++sinceSweep < 256) return;
  sinceSweep = 0;
  for (const [key, entry] of STREAKS) {
    if (now - entry.lastSeenAt > IDLE_MS) STREAKS.delete(key);
  }
  for (const [key, entry] of SOURCES) {
    if (now - entry.lastSeenAt > IDLE_MS) SOURCES.delete(key);
  }
  for (const [key, lastSeenAt] of CONVS) {
    if (now - lastSeenAt > IDLE_MS) CONVS.delete(key);
  }
  // A hard ceiling as well as the idle rule. Idle eviction alone bounds the map
  // only if the source ever goes quiet, and the cheap defence against a caller
  // minting conversations back to back is to refuse to remember them all. The
  // oldest go first, so a burst evicts settled conversations rather than live
  // ones. Consequence, stated plainly: a caller who opens this many
  // conversations inside IDLE_MS loses the oldest streaks, which resets their
  // ceilings — but `SOURCES` is one entry per source and is keyed on an identity
  // the caller cannot forge, so the anti-rotation ceiling is unaffected.
  for (const [map, cap] of [
    [STREAKS, MAX_TRACKED],
    [SOURCES, MAX_TRACKED],
    [CONVS, MAX_TRACKED],
  ] as const) {
    if (map.size <= cap) continue;
    // `CONVS` stores a bare timestamp; the other two store records.
    const oldest = [...map.entries()].sort((a, b) => {
      const aAt = typeof a[1] === "number" ? a[1] : a[1].lastSeenAt;
      const bAt = typeof b[1] === "number" ? b[1] : b[1].lastSeenAt;
      return aAt - bAt;
    });
    for (let i = 0; i < oldest.length - cap; i++) {
      const key = oldest[i]?.[0];
      if (key !== undefined) map.delete(key);
    }
  }
}

export type TurnVerdict = {
  /** The identifier the CLIENT must echo on its next turn. */
  convId: string;
  /** True when this request opened a conversation the server had not seen. */
  first: boolean;
  /** Consecutive unclear turns in this conversation, including this one. */
  streak: number;
  /** True once either ceiling is reached — escalate to a human. */
  capped: boolean;
};

/** Read a positive integer env override, or fall back. */
function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/**
 * Mint an opaque conversation token.
 *
 * `crypto.randomUUID` rather than the `Math.random().toString(36)` shape used
 * elsewhere in this codebase for refs: this token is the thing an attacker would
 * rotate, so its unguessability is a security property rather than cosmetic.
 */
function mintConvId(): string {
  return `cv_${randomUUID().replace(/-/g, "")}`;
}

/**
 * Record one turn and say whether the handoff ceiling has been reached.
 *
 * `presentedConvId` is whatever the client echoed, which is only a HINT: an
 * unknown or absent token mints a fresh conversation rather than being trusted,
 * so a client cannot name a conversation it has not been given.
 *
 * `source` is the trust-gated caller identity and is NOT client-supplied.
 */
export function noteTurn(
  input: {
    presentedConvId?: string | null;
    source: string;
    unclear: boolean;
  },
  now = Date.now(),
): TurnVerdict {
  sweep(now);

  const known = input.presentedConvId != null && CONVS.has(input.presentedConvId);
  const convId = known ? input.presentedConvId! : mintConvId();
  CONVS.set(convId, now);
  const first = !known;

  if (!input.unclear) {
    // A clear turn clears BOTH ledgers. Leaving the source budget standing would
    // mean one confused call in an office permanently penalised everyone behind
    // that address afterwards.
    STREAKS.delete(convId);
    SOURCES.delete(input.source);
    return { convId, first, streak: 0, capped: false };
  }

  const prev = STREAKS.get(convId);
  const streak = (prev?.count ?? 0) + 1;
  STREAKS.set(convId, { count: streak, lastSeenAt: now });

  const prevSource = SOURCES.get(input.source);
  const sourceCount = (prevSource?.count ?? 0) + 1;
  SOURCES.set(input.source, { count: sourceCount, lastSeenAt: now });

  const capped =
    streak >= envInt("MAX_UNCLEAR_TURNS", 4) ||
    sourceCount >= envInt("MAX_UNCLEAR_TURNS_PER_SOURCE", 12);

  return { convId, first, streak, capped };
}

/** Current streak for a conversation, without recording a turn. */
export function unclearStreak(convId: string, now = Date.now()): number {
  const entry = STREAKS.get(convId);
  if (!entry) return 0;
  if (now - entry.lastSeenAt > IDLE_MS) {
    STREAKS.delete(convId);
    return 0;
  }
  return entry.count;
}

/** Forget a conversation — on hangup, so a reused token cannot inherit a streak. */
export function resetCallTurns(convId: string): void {
  STREAKS.delete(convId);
  CONVS.delete(convId);
}

/** Test seam. */
export function _resetTurnCounter(): void {
  STREAKS.clear();
  SOURCES.clear();
  CONVS.clear();
  sinceSweep = 0;
}
