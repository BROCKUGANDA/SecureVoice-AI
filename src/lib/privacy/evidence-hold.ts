/**
 * The five-year evidence hold, in one place.
 *
 * Retention selects locked rows after this window, and `eraseCase` must
 * re-check the same window at the moment of destruction: a case can become
 * confirmed fraud between the sweeper's selection and the erasure, and the
 * boolean "the sweeper already checked" is stale by then.
 */

const DAY_MS = 86_400_000;

export const EVIDENCE_RETENTION_DAYS = (() => {
  const raw = Number(process.env.PRIVACY_EVIDENCE_RETENTION_DAYS);
  return Number.isInteger(raw) && raw > 0 ? raw : 5 * 365;
})();

export const EVIDENCE_RETENTION_MS = EVIDENCE_RETENTION_DAYS * DAY_MS;

/** True only when the hold that started at `start` has fully elapsed. */
export function evidenceHoldElapsed(start: Date, now = Date.now()): boolean {
  return start.getTime() + EVIDENCE_RETENTION_MS <= now;
}
