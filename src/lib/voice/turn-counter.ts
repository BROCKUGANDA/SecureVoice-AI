/**
 * Consecutive unclear turns, counted where the counting can be trusted.
 *
 * A fraud call that cannot get a clear answer after four turns is a call a human
 * should be on, not a script a customer is arguing with at 2am. That rule exists
 * (`MAX_UNCLEAR_TURNS`), and until now it read the turn number out of the request
 * body — so the guard could not fire in two different ways at once:
 *
 *   1. A caller that omits `turn` (the live browser panel omits it) is "unknown",
 *      which never reaches the threshold. The handoff was unreachable on the plane
 *      judges actually use.
 *   2. A caller that sends `turn: 1` on every request keeps the threshold out of
 *      reach forever. A guard whose input is supplied by the party it guards
 *      against is not a guard.
 *
 * So the server counts. It remembers the streak of consecutive unclear turns per
 * call and resets it the moment anything classifies clearly — a caller who finally
 * says "no, that's not mine" is not still carrying the earlier confusion.
 *
 * State is in-process, like the bad-actor ladder it sits beside: one replica
 * counts its own turns. A multi-replica deployment needs the streak in shared
 * storage to be exact; the ceiling is still enforced per instance, and the media
 * stream worker (the plane real bank calls take) holds one process per call and
 * so is already exact.
 */
const STREAKS = new Map<string, { count: number; lastSeenAt: number }>();

/** Entries nobody has touched in this long are forgotten. */
const IDLE_MS = Number(process.env.CALL_TURN_IDLE_MS ?? 1_800_000);
const MAX_TRACKED = 10_000;

function sweep(now: number): void {
  if (STREAKS.size <= MAX_TRACKED) return;
  for (const [key, entry] of STREAKS) {
    if (now - entry.lastSeenAt > IDLE_MS) STREAKS.delete(key);
  }
}

/**
 * Record one turn for a call.
 *
 * @param callRef the identity the call is audited under — not a client-chosen
 *                number, which is the whole defect this replaces.
 * @param unclear true when the turn classified as `unclear`; anything else resets
 *                the streak.
 * @returns the streak INCLUDING this turn, so the caller compares it against its
 *          own threshold.
 */
export function noteTurn(callRef: string, unclear: boolean, now = Date.now()): number {
  if (!callRef) return 0;
  sweep(now);
  if (!unclear) {
    STREAKS.delete(callRef);
    return 0;
  }
  const prev = STREAKS.get(callRef);
  const count = (prev?.count ?? 0) + 1;
  STREAKS.set(callRef, { count, lastSeenAt: now });
  return count;
}

/** Current streak, without recording a turn. */
export function unclearStreak(callRef: string, now = Date.now()): number {
  const entry = STREAKS.get(callRef);
  if (!entry) return 0;
  if (now - entry.lastSeenAt > IDLE_MS) {
    STREAKS.delete(callRef);
    return 0;
  }
  return entry.count;
}

/** Forget a call — on hangup, so a reused reference cannot inherit a streak. */
export function resetCallTurns(callRef: string): void {
  STREAKS.delete(callRef);
}

/** Test seam. */
export function _resetTurnCounter(): void {
  STREAKS.clear();
}
