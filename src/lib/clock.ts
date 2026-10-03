/**
 * Clock implementations (WP-18).
 *
 * Two clocks, and the choice between them is a test-harness decision rather
 * than a code decision:
 *
 *   - `systemClock()` — wall clock. Production.
 *   - `fixedClock(at)` — a clock that stands still until told to move.
 *
 * Why this file exists at all: every evidence artifact in this repo is a
 * promise that a reader can re-run the gate and get the same bytes. A single
 * implicit `Date.now()` in a timestamped decision makes that promise
 * unreproducible, and the reader cannot tell which fields were wall-clock and
 * which were not. Making the clock an injected port puts the choice at the
 * composition root, where it is visible in one line.
 *
 * There is deliberately no server-only marker here: a clock is pure, and
 * keeping it importable from a test or a client bundle costs nothing and
 * removes a class of "why does my unit test explode" failures.
 */

import type { Clock } from "@/lib/ports/types";

export const SYSTEM_CLOCK_ID = "clock.system";
export const FIXED_CLOCK_ID = "clock.fixed";

/**
 * Wall clock. Returns a new `Date` per call so a caller that mutates the
 * result cannot move time for everybody else.
 */
export function systemClock(): Clock {
  return {
    adapterId: SYSTEM_CLOCK_ID,
    mode: "real",
    now: () => new Date(),
  };
}

/**
 * A clock that only moves when it is told to.
 *
 * `step()` advances by a delta and returns the new instant; `set()` jumps to
 * an absolute one. Both return the resulting `Date` so a scripted run can
 * write `await clock.step(1_000)` and use the value without a second lookup.
 *
 * Frozen at an explicit instant by default rather than at construction time:
 * `fixedClock()` with no argument means "epoch", which makes the failure
 * obvious in the artifact instead of quietly tracking the wall clock.
 */
export type FixedClock = Clock & {
  /** Advance by `ms` and return the new instant. */
  step(ms: number): Date;
  /** Jump to an absolute instant and return it. */
  set(at: string | Date): Date;
  /** The instant this clock started at, untouched by later steps. */
  readonly origin: Date;
};

const EPOCH_DEFAULT = "2026-01-01T00:00:00.000Z";

export function fixedClock(at: string | Date = EPOCH_DEFAULT): FixedClock {
  const origin = toInstant(at, "fixedClock.at");
  let current = origin.getTime();

  const read = (): Date => new Date(current);

  return {
    adapterId: FIXED_CLOCK_ID,
    mode: "fake",
    now: read,
    get origin(): Date {
      return new Date(origin.getTime());
    },
    step(ms: number): Date {
      if (!Number.isFinite(ms))
        throw new TypeError(`fixedClock.step(ms) requires a finite number (got ${String(ms)})`);
      // Backwards steps are allowed on purpose: a replay of an out-of-order
      // event must be expressible without a second clock.
      current += Math.trunc(ms);
      return read();
    },
    set(next: string | Date): Date {
      current = toInstant(next, "fixedClock.set").getTime();
      return read();
    },
  };
}

/** Parse an instant, rejecting anything Date would silently call `Invalid`. */
export function toInstant(at: string | Date, name = "instant"): Date {
  const d = at instanceof Date ? new Date(at.getTime()) : new Date(at);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`${name} is not a valid ISO-8601 instant (got ${JSON.stringify(at)})`);
  }
  return d;
}
