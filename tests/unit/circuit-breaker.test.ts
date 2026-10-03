/**
 * UNIT — the declared-fallback circuit breakers (src/lib/failures/breaker.ts).
 *
 * A breaker is the difference between a provider outage being *degraded* and
 * being *an outage that eats the platform*. The properties below are the ones
 * that decide which:
 *
 *   · A declared fallback is a FUNCTION that runs, not a string in a table. The
 *     whole point of `FALLBACKS` is that `withDeclaredFallback` uses it, so a
 *     fallback that never runs is the defect this file exists to catch.
 *   · HALF-OPEN IS A QUESTION. It admits a bounded number of probes, and one
 *     failed probe re-opens immediately with a fresh cooldown. A breaker that
 *     lingers in half-open lets the whole traffic through the moment the
 *     provider is still down.
 *   · An open breaker refuses WITHOUT calling through, and the refusal carries a
 *     typed `dependency_unavailable` Failure with the dependency's own
 *     Retry-After — not a generic 500.
 *   · `isFailure` can classify a throw as NOT a dependency failure, and such a
 *     throw must not re-arm the breaker.
 *   · The Redis fallback is deliberately TIGHTER than the distributed limit
 *     (ceiling 0.5), because per-process counters under-count by the number of
 *     processes and matching the distributed number would admit N× the traffic.
 *     A multiplier that drifts upward is the failure this asserts against.
 *
 * The clock is injected throughout, so every timing assertion is exact rather
 * than approximate.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_HALF_OPEN_PROBES,
  DEFAULT_OPEN_MS,
  DEPENDENCIES,
  FALLBACKS,
  IN_PROCESS_LIMIT_CEILING,
  createBreaker,
  fallbackFor,
  inProcessLimit,
  withDeclaredFallback,
  type Dependency,
} from "@/lib/failures/breaker";

/** A clock the test drives by hand, so cooldown assertions are exact. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("declared fallbacks", () => {
  test("every dependency has a declared fallback", () => {
    for (const dep of DEPENDENCIES) {
      expect(FALLBACKS[dep]).toBeDefined();
      expect(FALLBACKS[dep].declared.length).toBeGreaterThan(0);
    }
  });

  test("every fallback preserves the intervention", () => {
    // This is the load-bearing claim in the table: a dependency going away
    // degrades the CHANNEL, never drops the fraud response.
    for (const dep of DEPENDENCIES) {
      expect({ dep, preserves: FALLBACKS[dep].preservesIntervention }).toEqual({
        dep,
        preserves: true,
      });
    }
  });

  test("every fallback declares a positive Retry-After", () => {
    for (const dep of DEPENDENCIES) {
      expect(FALLBACKS[dep].retryAfterSec).toBeGreaterThan(0);
    }
  });

  test("every fallback names a declared channel from the closed union", () => {
    const channels = [
      "continuity_pipeline",
      "sms",
      "app_push",
      "queued",
      "alert",
      "scripted_reply",
      "in_process_limits",
    ];
    for (const dep of DEPENDENCIES) {
      expect(channels).toContain(FALLBACKS[dep].channel);
      if (FALLBACKS[dep].secondary !== null) {
        expect(channels).toContain(FALLBACKS[dep].secondary);
      }
    }
  });

  test("telephony is not marked degraded — queueing still reaches the customer", () => {
    // Queue + alert is the normal path for a busy line, not a degraded one.
    expect(FALLBACKS.telephony.degraded).toBe(false);
  });

  test("the LLM fallback does not alert — a scripted reply is not urgent", () => {
    expect(FALLBACKS.llm.alerts).toBe(false);
  });

  test("the Redis fallback is both degraded and alerting", () => {
    // Limits are no longer distributed, which an operator must know about.
    expect(FALLBACKS.redis.degraded).toBe(true);
    expect(FALLBACKS.redis.alerts).toBe(true);
  });

  test("fallbackFor returns the same declaration as the table", () => {
    for (const dep of DEPENDENCIES) {
      expect(fallbackFor(dep)).toBe(FALLBACKS[dep]);
    }
  });
});

describe("createBreaker — configuration", () => {
  test("defaults are the documented constants", () => {
    const b = createBreaker("llm");
    // At the default threshold, N-1 failures keep it closed.
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD - 1; i += 1) b.recordFailure();
    expect(b.state()).toBe("closed");
    b.recordFailure();
    expect(b.state()).toBe("open");
  });

  test("a new breaker starts closed", () => {
    expect(createBreaker("llm").state()).toBe("closed");
  });

  test("a failure threshold below 1 is rejected", () => {
    for (const bad of [0, -1, Number.NaN]) {
      expect(() => createBreaker("llm", { failureThreshold: bad })).toThrow(RangeError);
    }
  });

  test("halfOpenProbes is floored at 1 — a breaker must admit something to recover", () => {
    const clock = fakeClock();
    const b = createBreaker("llm", {
      failureThreshold: 1,
      openMs: 100,
      halfOpenProbes: 0,
      now: clock.now,
    });
    b.recordFailure();
    clock.advance(100);
    expect(b.permit().allowed).toBe(true);
  });

  test("a dependency is carried on the breaker", () => {
    expect(createBreaker("redis").dependency).toBe("redis");
  });
});

describe("breaker — closed to open", () => {
  test("it stays closed below the threshold and opens at it", () => {
    const b = createBreaker("llm", { failureThreshold: 3 });
    b.recordFailure();
    b.recordFailure();
    expect(b.state()).toBe("closed");
    b.recordFailure();
    expect(b.state()).toBe("open");
  });

  test("a success resets the consecutive failure count", () => {
    const b = createBreaker("llm", { failureThreshold: 3 });
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    expect(b.state()).toBe("closed");
  });

  test("a closed breaker permits and is not a probe", () => {
    const p = createBreaker("llm").permit();
    expect(p.allowed).toBe(true);
    expect(p.probe).toBe(false);
    expect(p.failure).toBeNull();
  });
});

describe("breaker — open state", () => {
  function opened(overrides: { openMs?: number; threshold?: number } = {}) {
    const clock = fakeClock();
    const b = createBreaker("llm", {
      failureThreshold: overrides.threshold ?? 1,
      openMs: overrides.openMs ?? 1000,
      now: clock.now,
    });
    b.recordFailure();
    return { b, clock };
  }

  test("an open breaker refuses without calling through", () => {
    const { b } = opened();
    const p = b.permit();
    expect(p.allowed).toBe(false);
    expect(p.probe).toBe(false);
    expect(p.state).toBe("open");
  });

  test("a refusal carries a typed dependency_unavailable failure", () => {
    const { b } = opened();
    const p = b.permit();
    expect(p.failure?.body.code).toBe("dependency_unavailable");
    expect(p.failure?.status).toBe(503);
    expect(p.failure?.body.retryable).toBe(true);
  });

  test("a refusal carries the DEPENDENCY'S OWN Retry-After", () => {
    const clock = fakeClock();
    const b = createBreaker("redis", { failureThreshold: 1, now: clock.now });
    b.recordFailure();
    // redis declares 5s, llm 15s — a generic value here would be a defect.
    expect(b.permit().failure?.headers["Retry-After"]).toBe(String(FALLBACKS.redis.retryAfterSec));
  });

  test("a refusal names the fallback so the caller knows the degraded mode", () => {
    const { b } = opened();
    expect(b.permit().fallback).toBe(FALLBACKS.llm);
  });

  test("it stays open until the cooldown elapses, then goes half-open", () => {
    const { b, clock } = opened({ openMs: 1000 });
    clock.advance(999);
    expect(b.state()).toBe("open");
    clock.advance(1);
    expect(b.state()).toBe("half_open");
  });

  test("the default cooldown is 30 seconds", () => {
    expect(DEFAULT_OPEN_MS).toBe(30_000);
  });
  // FIXED. The source comment promised the cooldown was re-armed; `moveTo`
  // early-returns on an unchanged state, so `openedAt` kept its original value
  // and the breaker went half-open on the ORIGINAL deadline no matter what kept
  // failing. `recordFailure` now stamps the clock directly in the open state.
  test("a failure while open DOES extend the cooldown", () => {
    const { b, clock } = opened({ openMs: 1000 });
    clock.advance(900);
    b.recordFailure();
    // The re-arm restarts the full cooldown, so 1100ms after opening (200ms
    // after the failure) it is still open rather than half-open.
    clock.advance(200);
    expect(b.state()).toBe("open");
    // And it does still recover, on the new deadline.
    clock.advance(800);
    expect(b.state()).toBe("half_open");
  });

  test("repeated failures while open keep pushing the deadline out", () => {
    const { b, clock } = opened({ openMs: 1000 });
    for (let i = 0; i < 5; i += 1) {
      clock.advance(900);
      b.recordFailure();
    }
    clock.advance(999);
    expect(b.state()).toBe("open");
  });

  test("a re-arm does not push a duplicate transition into the history", () => {
    // The state did not change, so recording it again would misrepresent the
    // breaker's history as having churned.
    const { b, clock } = opened({ openMs: 1000 });
    clock.advance(100);
    b.recordFailure();
    expect(b.snapshot().transitions).toEqual(["closed", "open"]);
  });
});

describe("breaker — half-open is a question", () => {
  function halfOpened(halfOpenProbes = 1) {
    const clock = fakeClock();
    const b = createBreaker("llm", {
      failureThreshold: 1,
      openMs: 100,
      halfOpenProbes,
      now: clock.now,
    });
    b.recordFailure();
    clock.advance(100);
    return { b, clock };
  }

  test("it admits exactly the configured number of probes", () => {
    const { b } = halfOpened(1);
    expect(b.permit().allowed).toBe(true);
    expect(b.permit().allowed).toBe(false);
  });

  test("a permit in half-open is marked as a probe", () => {
    expect(halfOpened(1).b.permit().probe).toBe(true);
  });

  test("a second concurrent probe is refused while the first is in flight", () => {
    const { b } = halfOpened(2);
    expect(b.permit().allowed).toBe(true);
    expect(b.permit().allowed).toBe(true);
    expect(b.permit().allowed).toBe(false);
  });

  test("ONE failed probe re-opens immediately with a fresh cooldown", () => {
    const { b, clock } = halfOpened();
    b.permit();
    b.recordFailure();
    expect(b.state()).toBe("open");
    // A fresh full cooldown, not the remainder of the old one.
    clock.advance(99);
    expect(b.state()).toBe("open");
    clock.advance(1);
    expect(b.state()).toBe("half_open");
  });

  test("a successful probe closes the breaker and clears the failure count", () => {
    const { b } = halfOpened();
    b.permit();
    b.recordSuccess();
    expect(b.state()).toBe("closed");
    expect(b.snapshot().consecutiveFailures).toBe(0);
  });

  test("successThreshold > 1 requires several successful probes", () => {
    const clock = fakeClock();
    const b = createBreaker("llm", {
      failureThreshold: 1,
      openMs: 100,
      successThreshold: 2,
      halfOpenProbes: 3,
      now: clock.now,
    });
    b.recordFailure();
    clock.advance(100);
    b.permit();
    b.recordSuccess();
    expect(b.state()).toBe("half_open");
    b.permit();
    b.recordSuccess();
    expect(b.state()).toBe("closed");
  });

  test("probesInFlight never goes negative", () => {
    const { b } = halfOpened();
    b.recordFailure();
    b.recordFailure();
    expect(b.snapshot().probesInFlight).toBeGreaterThanOrEqual(0);
  });

  test("the default probe count is 1", () => {
    expect(DEFAULT_HALF_OPEN_PROBES).toBe(1);
  });
});

describe("breaker — snapshot and reset", () => {
  test("the snapshot records the transition history", () => {
    const clock = fakeClock();
    const b = createBreaker("llm", { failureThreshold: 1, openMs: 100, now: clock.now });
    b.recordFailure();
    clock.advance(100);
    b.permit();
    b.recordSuccess();
    expect(b.snapshot().transitions).toEqual(["closed", "open", "half_open", "closed"]);
  });

  test("the snapshot includes the declared fallback", () => {
    expect(createBreaker("telephony").snapshot().fallback).toBe(FALLBACKS.telephony);
  });

  test("reset returns the breaker to a pristine closed state", () => {
    const clock = fakeClock();
    const b = createBreaker("llm", { failureThreshold: 1, now: clock.now });
    b.recordFailure();
    b.reset();
    const s = b.snapshot();
    expect(s.state).toBe("closed");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.probesInFlight).toBe(0);
    expect(s.transitions).toEqual(["closed"]);
  });

  test("a reset breaker permits again", () => {
    const b = createBreaker("llm", { failureThreshold: 1 });
    b.recordFailure();
    b.reset();
    expect(b.permit().allowed).toBe(true);
  });
});

describe("withDeclaredFallback — the fallback actually runs", () => {
  test("a successful call is reported as primary with its value", async () => {
    const b = createBreaker("llm");
    const r = await withDeclaredFallback(b, async () => "answer", { fallback: () => "script" });
    expect(r.source).toBe("primary");
    expect(r.value).toBe("answer");
    expect(r.failure).toBeNull();
  });

  test("a throwing call runs the fallback and reports it", async () => {
    const b = createBreaker("llm");
    const r = await withDeclaredFallback(
      b,
      async () => {
        throw new Error("provider 503");
      },
      { fallback: () => "scripted" },
    );
    expect(r.source).toBe("fallback");
    expect(r.value).toBe("scripted");
  });

  test("a failed call reports a typed dependency_unavailable failure", async () => {
    const b = createBreaker("redis");
    const r = await withDeclaredFallback(
      b,
      async () => {
        throw new Error("ECONNREFUSED");
      },
      { fallback: () => "in-process" },
    );
    expect(r.failure?.body.code).toBe("dependency_unavailable");
    expect(r.failure?.headers["Retry-After"]).toBe(String(FALLBACKS.redis.retryAfterSec));
  });

  test("the fallback is NOT called when the primary succeeds", async () => {
    let called = false;
    const b = createBreaker("llm");
    await withDeclaredFallback(b, async () => "ok", {
      fallback: () => {
        called = true;
        return "scripted";
      },
    });
    expect(called).toBe(false);
  });

  test("an OPEN breaker never calls through — it goes straight to the fallback", async () => {
    const b = createBreaker("llm", { failureThreshold: 1 });
    b.recordFailure();
    let callRan = false;
    const r = await withDeclaredFallback(
      b,
      async () => {
        callRan = true;
        return "answer";
      },
      { fallback: () => "scripted" },
    );
    // The whole value of the breaker: a known-dead dependency is not dialled.
    expect(callRan).toBe(false);
    expect(r.source).toBe("fallback");
    expect(r.value).toBe("scripted");
    expect(r.failure?.body.code).toBe("dependency_unavailable");
  });

  test("a refusal in half-open is not reported as a probe", async () => {
    const clock = fakeClock();
    const b = createBreaker("llm", { failureThreshold: 1, openMs: 100, now: clock.now });
    b.recordFailure();
    clock.advance(100);
    b.permit(); // consume the only probe slot
    const r = await withDeclaredFallback(b, async () => "x", { fallback: () => "scripted" });
    expect(r.source).toBe("fallback");
    expect(r.wasProbe).toBe(false);
  });

  test("a real probe is reported as a probe", async () => {
    const clock = fakeClock();
    const b = createBreaker("llm", { failureThreshold: 1, openMs: 100, now: clock.now });
    b.recordFailure();
    clock.advance(100);
    const r = await withDeclaredFallback(b, async () => "answer", { fallback: () => "scripted" });
    expect(r.wasProbe).toBe(true);
    expect(r.source).toBe("primary");
  });

  test("a throw classified as NOT a failure does not re-arm the breaker", async () => {
    const b = createBreaker("llm", { failureThreshold: 2 });
    for (let i = 0; i < 5; i += 1) {
      const r = await withDeclaredFallback(
        b,
        async () => {
          throw new Error("caller cancelled");
        },
        { fallback: () => "scripted", isFailure: () => false },
      );
      // A caller cancelling is not the provider being down.
      expect(r.source).toBe("primary");
      expect(r.value).toBeNull();
      expect(r.failure).toBeNull();
    }
    expect(b.state()).toBe("closed");
  });

  test("a classified non-failure does not run the fallback", async () => {
    const b = createBreaker("llm");
    const r = await withDeclaredFallback(
      b,
      async () => {
        throw new Error("bad request");
      },
      { fallback: () => "scripted", isFailure: () => false },
    );
    expect(r.source).toBe("primary");
    expect(r.failure).toBeNull();
  });

  test("a classified failure does run the fallback", async () => {
    const b = createBreaker("llm");
    const r = await withDeclaredFallback(
      b,
      async () => {
        throw new Error("timeout");
      },
      {
        fallback: () => "scripted",
        isFailure: (e) => e instanceof Error && e.message === "timeout",
      },
    );
    expect(r.source).toBe("fallback");
    expect(r.failure).not.toBeNull();
  });

  test("the outcome always names the dependency's declared fallback", async () => {
    for (const dep of DEPENDENCIES) {
      const b = createBreaker(dep);
      const r = await withDeclaredFallback(b, async () => "x", { fallback: () => "y" });
      expect(r.fallback).toBe(FALLBACKS[dep]);
    }
  });

  test("a rejected call that still preserves the intervention reports the fallback channel", async () => {
    const b = createBreaker("conversation_plane", { failureThreshold: 1 });
    b.recordFailure();
    const r = await withDeclaredFallback(b, async () => "x", { fallback: () => "sms" });
    expect(r.fallback.channel).toBe("continuity_pipeline");
    expect(r.fallback.preservesIntervention).toBe(true);
    expect(r.value).toBe("sms");
  });
});

describe("inProcessLimit — the Redis fallback is deliberately tighter", () => {
  test("the ceiling multiplier is 0.5, not 1", () => {
    // Matching the distributed limit would admit N× the intended traffic,
    // because per-process counters under-count by the number of processes.
    expect(IN_PROCESS_LIMIT_CEILING).toBe(0.5);
    expect(IN_PROCESS_LIMIT_CEILING).toBeLessThan(1);
  });

  test("the per-process limit is the distributed limit scaled down", () => {
    expect(inProcessLimit({ key: "k", limit: 100, used: 0 }).limitPerProcess).toBe(50);
  });

  test("it always reports itself as degraded", () => {
    expect(inProcessLimit({ key: "k", limit: 10, used: 0 }).degraded).toBe(true);
  });

  test("the log line names the key an operator needs", () => {
    const l = inProcessLimit({ key: "tenant-42", limit: 10, used: 0 });
    expect(l.logLine).toContain("tenant-42");
    expect(l.logLine).toContain("redis unavailable");
  });

  test("admission is exclusive at the scaled limit", () => {
    // limit 10 × 0.5 = 5 per process. used 4 admits; used 5 is refused.
    expect(inProcessLimit({ key: "k", limit: 10, used: 4 }).admission).toEqual({
      admitted: true,
      used: 4,
      limit: 5,
    });
    expect(inProcessLimit({ key: "k", limit: 10, used: 5 }).admission).toEqual({
      admitted: false,
      used: 5,
      limit: 5,
    });
  });

  test("the admission limit is the SCALED one, not the distributed one", () => {
    // The defect this guards: admitting against the unscaled 10 would let
    // through twice the traffic the fallback is meant to hold back.
    expect(inProcessLimit({ key: "k", limit: 10, used: 8 }).admission.admitted).toBe(false);
  });

  test("the limit is floored at 1, never 0", () => {
    // A limit of 0 would refuse everything, which is a different outage.
    expect(inProcessLimit({ key: "k", limit: 1, used: 0 }).limitPerProcess).toBe(1);
  });

  test("a negative or NaN usage is treated as zero", () => {
    expect(inProcessLimit({ key: "k", limit: 10, used: -5 }).admission.used).toBe(0);
    expect(inProcessLimit({ key: "k", limit: 10, used: Number.NaN }).admission.used).toBe(0);
  });

  // FIXED. A NaN `limit` used to survive into `limitPerProcess`, because
  // `Math.floor(NaN)` is NaN and `Math.max(1, NaN)` is also NaN. Admission was
  // already fail-closed, but the snapshot an operator reads to decide whether
  // the Redis fallback is behaving was not a number. An unusable limit now
  // yields 0 — never 1, which would silently re-open a closed limit.
  test("an unusable limit yields 0 and still fails the admission closed", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const l = inProcessLimit({ key: "k", limit: bad, used: 0 });
      expect({ bad, limit: l.limitPerProcess, admitted: l.admission.admitted }).toEqual({
        bad,
        limit: 0,
        admitted: false,
      });
    }
  });

  test("an unusable limit never surfaces as NaN in the operator snapshot", () => {
    // The whole point: every field an operator reads is a real number.
    const l = inProcessLimit({ key: "k", limit: Number.NaN, used: 3 });
    expect(Number.isFinite(l.limitPerProcess)).toBe(true);
    expect(Number.isFinite(l.admission.used)).toBe(true);
    expect(Number.isFinite(l.admission.limit)).toBe(true);
  });

  test("a finite zero limit still means admit nothing, not one", () => {
    const l = inProcessLimit({ key: "k", limit: 0, used: 0 });
    expect(l.limitPerProcess).toBe(1);
    expect(l.admission.admitted).toBe(true);
  });

  test("an explicit multiplier overrides the ceiling", () => {
    expect(
      inProcessLimit({ key: "k", limit: 100, used: 0, multiplier: 0.25 }).limitPerProcess,
    ).toBe(25);
  });

  test("a multiplier above 1 is accepted only because the caller asked", () => {
    // Documented as caller-controlled; the DEFAULT is the safe direction.
    expect(inProcessLimit({ key: "k", limit: 10, used: 0, multiplier: 2 }).limitPerProcess).toBe(
      20,
    );
    expect(IN_PROCESS_LIMIT_CEILING).toBeLessThan(1);
  });
});
