/**
 * Hand-written types for `coverage-floor.mjs`, so the gate that decides whether a
 * PR into `main` may merge is typed where it is consumed (`tests/tools/coverage-floor.test.ts`)
 * rather than silently `any`.
 *
 * Written by hand because the runtime module is plain JS: TypeScript will not
 * generate these from it, and `any` here would hide exactly the mistakes that
 * matter — swapping `failReason` for `warnReason`, or reading `gapPoints` (which no
 * longer exists) instead of `gapToTarget`. Both would keep the suite green while the
 * gate stopped gating. The behaviour is pinned by tests against the real module, so
 * this file describes it; it does not define it.
 */

export const COVERAGE_TARGET: number;
export const FLOOR_FILE: string;
export const BUMP_STEP: number;

export type Floor = { overall: number; at: string; target: number };

export type ParsedFloor =
  { floor: Floor; error?: undefined } | { floor?: undefined; error: string };

export type CoverageVerdict = {
  bar: number;
  /** The committed floor, or null when it is missing or malformed. */
  floor: Floor | null;
  /** Set only in a blocking context and only when measured is below `bar`. */
  failReason: string | null;
  /** The same condition in a report-only context: prints, never fails. */
  warnReason: string | null;
  target: number;
  gapToTarget: number;
  gapToTargetLines: number;
  /** Non-null when coverage rose enough that the floor should be bumped in this PR. */
  bump: string | null;
};

export function pct(hit: number, total: number): number;
export function parseFloor(raw: string | null | undefined): ParsedFloor;
export function evaluateCoverage(input: {
  measured: number;
  hit: number;
  total: number;
  mergeBar: number;
  raw: string | null;
  blocking?: boolean;
}): CoverageVerdict;

/** One floor value as recorded at one commit, newest commit first. */
export type FloorHistoryEntry = { at: string; overall: number | null };

export type FloorHistoryVerdict = { error: string | null; peak: number | null };

/** Prove from a branch's own history that the ratchet never loosened. */
export function evaluateFloorHistory(entries: FloorHistoryEntry[]): FloorHistoryVerdict;
