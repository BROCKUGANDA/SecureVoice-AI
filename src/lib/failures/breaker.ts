import "server-only";
/**
 * A circuit breaker per dependency, each with a DECLARED fallback (WP-21).
 *
 * ── The declarations ──────────────────────────────────────────────────────────
 *
 * The point of a breaker is not the open/closed state machine; it is that when
 * a dependency is gone, the platform has an answer for each one BEFORE the
 * incident, not during it. Those answers are declared in `FALLBACKS` and quoted
 * from the brief verbatim, and the gate asserts every dependency in
 * `DEPENDENCIES` has one:
 *
 *   conversation plane  →  the continuity pipeline, else SMS
 *   telephony           →  queue the work and alert a human
 *   LLM                 →  scripted replies
 *   Redis               →  conservative in-process limits, logged as degraded
 *
 * Each declaration also answers the question that actually matters operationally
 * — `preservesIntervention`. Losing Redis must not lose an intervention; losing
 * telephony does not lose it either, because the work is queued. Only the
 * conversation plane fallback (SMS/app push) changes the channel the customer
 * is contacted on, and that is stated rather than implied.
 *
 * ── Half-open probing ─────────────────────────────────────────────────────────
 *
 * A breaker that only opens is a denial-of-service waiting for a deploy. After
 * `openMs` it admits exactly `halfOpenProbes` concurrent probes, records what
 * they did, and closes on `successThreshold` successes or re-opens on the first
 * failure with a fresh cooldown. A probe is a real call — it is not a
 * synthetic "let me through and hope", and its result decides the state.
 *
 * `now` is injected so the gate can walk the whole lifecycle without wall
 * clock; the default is `Date.now`.
 */

import { dependencyUnavailable, type Failure } from "./envelope";

// ── Dependencies and their declared fallbacks ─────────────────────────────────

export const DEPENDENCIES = ["conversation_plane", "telephony", "llm", "redis"] as const;
export type Dependency = (typeof DEPENDENCIES)[number];

export type FallbackChannel =
  | "continuity_pipeline"
  | "sms"
  | "app_push"
  | "queued"
  | "alert"
  | "scripted_reply"
  | "in_process_limits";

export type FallbackDecl = {
  /** What we actually do. */
  channel: FallbackChannel;
  /** The second line of defence, when the primary fallback has its own limits. */
  secondary: FallbackChannel | null;
  /** The brief's wording, quoted so the declaration cannot drift from it. */
  declared: string;
  /** A human must be told, not just the system. */
  alerts: boolean;
  /** The fallback is a degraded mode and is logged as one. */
  degraded: boolean;
  /**
   * Whether the intervention still happens. False means the customer is
   * contacted somewhere other than the normal channel.
   */
  preservesIntervention: boolean;
  /** Retry-After offered to the caller while the breaker is open. */
  retryAfterSec: number;
};

export const FALLBACKS: Record<Dependency, FallbackDecl> = {
  conversation_plane: {
    channel: "continuity_pipeline",
    secondary: "sms",
    declared: "conversation plane down → continuity pipeline or SMS",
    alerts: true,
    degraded: true,
    preservesIntervention: true,
    retryAfterSec: 30,
  },
  telephony: {
    channel: "queued",
    secondary: "alert",
    declared: "telephony down → queue and alert",
    alerts: true,
    degraded: false,
    preservesIntervention: true,
    retryAfterSec: 60,
  },
  llm: {
    channel: "scripted_reply",
    secondary: null,
    declared: "LLM down → scripted replies",
    alerts: false,
    degraded: true,
    preservesIntervention: true,
    retryAfterSec: 15,
  },
  redis: {
    channel: "in_process_limits",
    secondary: null,
    declared: "Redis down → conservative in-process limits logged as degraded",
    alerts: true,
    degraded: true,
    preservesIntervention: true,
    retryAfterSec: 5,
  },
};

export function fallbackFor(dependency: Dependency): FallbackDecl {
  return FALLBACKS[dependency];
}

// ── The breaker ───────────────────────────────────────────────────────────────

export type BreakerState = "closed" | "open" | "half_open";

export type BreakerConfig = {
  /** Consecutive failures needed to open. */
  failureThreshold?: number;
  /** Successes in half-open needed to close. */
  successThreshold?: number;
  /** How long the breaker stays open before admitting probes. */
  openMs?: number;
  /** Concurrent probes admitted while half-open. */
  halfOpenProbes?: number;
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
};

export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_OPEN_MS = 30_000;
export const DEFAULT_HALF_OPEN_PROBES = 1;

export type Permit = {
  /** May the caller attempt the primary path? */
  allowed: boolean;
  /** True when this permit IS the half-open probe. */
  probe: boolean;
  state: BreakerState;
  /** Null while the breaker is closed. */
  fallback: FallbackDecl | null;
  /** Present whenever `allowed` is false, so the caller has something to send. */
  failure: Failure | null;
  /** Consecutive failures as of this call. */
  consecutiveFailures: number;
};

export type BreakerSnapshot = {
  dependency: Dependency;
  state: BreakerState;
  consecutiveFailures: number;
  halfOpenSuccesses: number;
  probesInFlight: number;
  /** Transitions, in order. The gate asserts the lifecycle through this. */
  transitions: BreakerState[];
  fallback: FallbackDecl;
};

export interface Breaker {
  readonly dependency: Dependency;
  state(): BreakerState;
  permit(): Permit;
  recordSuccess(): void;
  recordFailure(): void;
  reset(): void;
  snapshot(): BreakerSnapshot;
}

/**
 * Build a breaker. Pure with respect to the outside world: it holds counters and
 * reads the injected clock, and nothing else.
 */
export function createBreaker(dependency: Dependency, config: BreakerConfig = {}): Breaker {
  const failureThreshold = config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const successThreshold = config.successThreshold ?? 1;
  const openMs = config.openMs ?? DEFAULT_OPEN_MS;
  const halfOpenProbes = Math.max(1, config.halfOpenProbes ?? DEFAULT_HALF_OPEN_PROBES);
  const now = config.now ?? Date.now;
  const fallback = FALLBACKS[dependency];

  if (!Number.isFinite(failureThreshold) || failureThreshold < 1) {
    throw new RangeError("failureThreshold must be >= 1");
  }

  let state: BreakerState = "closed";
  let consecutiveFailures = 0;
  let halfOpenSuccesses = 0;
  let probesInFlight = 0;
  let openedAt = 0;
  const transitions: BreakerState[] = ["closed"];

  const moveTo = (next: BreakerState): void => {
    if (state === next) return;
    state = next;
    transitions.push(next);
    if (next === "open") openedAt = now();
  };

  /**
   * Leave `open` once the cooldown has elapsed.
   *
   * Done lazily rather than on a timer — a timer per breaker is a timer per
   * dependency per process, and a breaker nobody asks anything is a breaker
   * nobody needs. Both `state()` and `permit()` call this, so a caller that
   * inspects the state sees the same state a call would be governed by.
   */
  const refresh = (): void => {
    if (state === "open" && now() - openedAt >= openMs) moveTo("half_open");
  };

  return {
    dependency,
    state: () => {
      refresh();
      return state;
    },

    permit(): Permit {
      refresh();

      if (state === "closed") {
        return {
          allowed: true,
          probe: false,
          state,
          fallback: null,
          failure: null,
          consecutiveFailures,
        };
      }

      if (state === "half_open" && probesInFlight < halfOpenProbes) {
        probesInFlight++;
        return {
          allowed: true,
          probe: true,
          state,
          fallback,
          failure: null,
          consecutiveFailures,
        };
      }

      return {
        allowed: false,
        probe: false,
        state,
        fallback,
        failure: dependencyUnavailable(fallback.retryAfterSec),
        consecutiveFailures,
      };
    },

    recordSuccess(): void {
      if (state === "half_open") {
        probesInFlight = Math.max(0, probesInFlight - 1);
        halfOpenSuccesses++;
        if (halfOpenSuccesses >= successThreshold) {
          halfOpenSuccesses = 0;
          consecutiveFailures = 0;
          moveTo("closed");
        }
        return;
      }
      consecutiveFailures = 0;
    },

    recordFailure(): void {
      if (state === "half_open") {
        // One failed probe re-opens with a fresh cooldown. Half-open is a
        // question, and a wrong answer ends the questioning.
        probesInFlight = Math.max(0, probesInFlight - 1);
        halfOpenSuccesses = 0;
        consecutiveFailures = failureThreshold;
        moveTo("open");
        return;
      }
      if (state === "closed") {
        consecutiveFailures++;
        if (consecutiveFailures >= failureThreshold) moveTo("open");
        return;
      }
      // A failure while open (a probe that was already in flight when the
      // breaker opened) re-arms the cooldown. `moveTo` early-returns when the
      // state is unchanged, so calling it here would NOT restamp `openedAt` and
      // the re-arm this comment promises would silently never happen — the
      // breaker would go half-open on the ORIGINAL deadline regardless of what
      // kept failing. Stamp the clock directly instead. No transition is
      // pushed, because the state genuinely did not change.
      probesInFlight = Math.max(0, probesInFlight - 1);
      openedAt = now();
    },

    reset(): void {
      state = "closed";
      consecutiveFailures = 0;
      halfOpenSuccesses = 0;
      probesInFlight = 0;
      openedAt = 0;
      transitions.length = 0;
      transitions.push("closed");
    },

    snapshot(): BreakerSnapshot {
      refresh();
      return {
        dependency,
        state,
        consecutiveFailures,
        halfOpenSuccesses,
        probesInFlight,
        transitions: [...transitions],
        fallback,
      };
    },
  };
}

// ── Running a call under the breaker ──────────────────────────────────────────

export type GuardedOutcome<T> = {
  /** `primary` when the call was attempted, `fallback` when the fallback ran. */
  source: "primary" | "fallback";
  value: T | null;
  failure: Failure | null;
  fallback: FallbackDecl;
  /** True when the call that ran was the half-open probe. */
  wasProbe: boolean;
};

export type GuardOptions<T> = {
  /** What to do when the breaker is open or the call throws. Must not throw. */
  fallback: () => T;
  /** Classify a throw. Default: any throw is a failure. */
  isFailure?: (err: unknown) => boolean;
};

/**
 * Run one call under the breaker and fall back when it is refused or fails.
 *
 * The fallback is a FUNCTION, not a channel name: `queue it`, `speak a scripted
 * line`, `apply an in-process limit`. A declaration that is only a string is a
 * comment; this is the place the declaration is used.
 */
export async function withDeclaredFallback<T>(
  breaker: Breaker,
  call: () => Promise<T>,
  options: GuardOptions<T>,
): Promise<GuardedOutcome<T>> {
  const fallback = FALLBACKS[breaker.dependency];
  const permit = breaker.permit();

  if (!permit.allowed) {
    return {
      source: "fallback",
      value: options.fallback(),
      failure: permit.failure,
      fallback,
      wasProbe: false,
    };
  }

  try {
    const value = await call();
    breaker.recordSuccess();
    return { source: "primary", value, failure: null, fallback, wasProbe: permit.probe };
  } catch (err) {
    const failed = options.isFailure ? options.isFailure(err) : true;
    if (failed) breaker.recordFailure();
    else breaker.recordSuccess();
    if (!failed) {
      return { source: "primary", value: null, failure: null, fallback, wasProbe: permit.probe };
    }
    return {
      source: "fallback",
      value: options.fallback(),
      failure: dependencyUnavailable(fallback.retryAfterSec),
      fallback,
      wasProbe: permit.probe,
    };
  }
}

// ── Redis: the conservative in-process limiter ────────────────────────────────

/**
 * The declared Redis fallback, implemented: when the shared limiter is gone,
 * limits fall back to per-process counters with a deliberately tighter ceiling.
 *
 * Tighter because per-process counters under-count by the number of processes,
 * so matching the distributed limit would admit N× the traffic it was set to
 * allow. `ceilingMultiplier` is well below 1 and that is the point.
 */
export const IN_PROCESS_LIMIT_CEILING = 0.5;

export type InProcessLimiter = {
  limitPerProcess: number;
  degraded: true;
  /** The log line an operator needs in order to trust the number. */
  logLine: string;
  admission: { admitted: boolean; used: number; limit: number };
};

/**
 * A conservative in-process limit for one key. `used` is injected so the gate
 * can drive the boundary without a Redis or a clock.
 */
export function inProcessLimit(input: {
  key: string;
  limit: number;
  used: number;
  multiplier?: number;
}): InProcessLimiter {
  const multiplier = input.multiplier ?? IN_PROCESS_LIMIT_CEILING;
  // Both `limit` and `used` are caller-supplied, so both are guarded. `used`
  // always was; `limit` did not, and `Math.floor(NaN)` is NaN while
  // `Math.max(1, NaN)` is also NaN — so `limitPerProcess` reached the operator
  // snapshot as NaN. Admission was already fail-closed (`used < NaN` is false,
  // so everything refused), but the number an operator reads to decide whether
  // the Redis fallback is behaving was not a number.
  //
  // An unusable limit now yields 0 rather than 1: 1 would read as "one request
  // admitted" and silently re-open a limit that configuration is supposed to
  // have closed. Zero keeps the existing fail-closed behaviour and is at least
  // a value an operator can read.
  const limitOk = Number.isFinite(input.limit) && input.limit >= 0;
  const limitPerProcess = limitOk ? Math.max(1, Math.floor(input.limit * multiplier)) : 0;
  const used = Number.isFinite(input.used) ? Math.max(0, input.used) : 0;
  return {
    limitPerProcess,
    degraded: true,
    logLine: `degraded: in-process limit active for ${input.key} (redis unavailable)`,
    admission: { admitted: used < limitPerProcess, used, limit: limitPerProcess },
  };
}
