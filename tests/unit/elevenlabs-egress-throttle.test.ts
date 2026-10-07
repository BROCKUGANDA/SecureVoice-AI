/**
 * UNIT — the ElevenLabs egress throttle's boundary.
 *
 * Separate file on purpose: the throttle ceiling is read from the environment
 * when the guard module is first imported, and a ceiling small enough to test
 * against (3/hour) would throttle every other property test in the suite. Bun
 * gives each file its own process and module registry, so this file can pin a
 * tiny ceiling without leaking it into the rest.
 *
 * What is being pinned:
 *   · The refusal happens BEFORE the vendor is contacted. A throttle that fires
 *     after the request is a counter, not a guard — the quota is already spent.
 *   · Buckets are per-caller, so one tenant's loop cannot lock out another.
 *   · The refusal carries a Retry-After a caller can honour.
 */
import { beforeEach, describe, expect, test } from "bun:test";

process.env.ELEVENLABS_API_KEY = "platform-key-should-never-leak";
delete process.env.ELEVENLABS_DRY_RUN;

const { elevenLabsFetch, elevenLabsBreaker, egressPerHour, cycleEndMs, _resetEgressForTest } =
  await import("@/lib/elevenlabs/egress");
const { _reset: resetRateLimits } = await import("@/lib/ratelimit");

/** Small enough that the boundary is two requests away, not a thousand. */
const CEILING = 3;

let calls = 0;

beforeEach(() => {
  process.env.ELEVENLABS_MONTHLY_CHAR_LIMIT = "1000000";
  process.env.ELEVENLABS_EGRESS_PER_HOUR = String(CEILING);
  _resetEgressForTest();
  resetRateLimits();
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});

describe("the egress throttle", () => {
  test("the ceiling comes from the environment per call, not frozen at import", () => {
    expect(egressPerHour()).toBe(3);
    process.env.ELEVENLABS_EGRESS_PER_HOUR = "7";
    expect(egressPerHour()).toBe(7);
    process.env.ELEVENLABS_EGRESS_PER_HOUR = String(CEILING);
  });

  test("a burst past the ceiling is refused before it reaches the vendor", async () => {
    const results = [];
    for (let i = 0; i < CEILING + 2; i++) {
      results.push(await elevenLabsFetch({ path: "/v1/any", billableChars: 0, callerId: "burst" }));
    }

    expect(results.filter((r) => r.ok)).toHaveLength(CEILING);
    const last = results[results.length - 1]!;
    expect(last.ok).toBe(false);
    if (last.ok) throw new Error("the throttle let the burst through");
    expect(last.error.status).toBe(429);
    expect(last.error.retryable).toBe(true);
    expect(last.error.retryAfterSec).toBeGreaterThan(0);
    // Refusals cost the vendor nothing — this is the whole point.
    expect(calls).toBe(CEILING);
  });

  test("one caller's burst does not exhaust another's bucket", async () => {
    for (let i = 0; i < CEILING; i++) {
      await elevenLabsFetch({ path: "/v1/any", billableChars: 0, callerId: "hog" });
    }
    const other = await elevenLabsFetch({ path: "/v1/any", billableChars: 0, callerId: "other" });
    expect(other.ok).toBe(true);
  });

  test("a refused burst does not trip the circuit breaker", async () => {
    for (let i = 0; i < CEILING + 5; i++) {
      await elevenLabsFetch({ path: "/v1/any", billableChars: 0, callerId: "flood" });
    }
    // Our own refusal is not the vendor being down. Opening the breaker here
    // would take the conversation plane out because of a client-side loop.
    expect(elevenLabsBreaker.state()).toBe("closed");
    expect(elevenLabsBreaker.snapshot().consecutiveFailures).toBe(0);
  });
});

describe("the monthly cycle boundary", () => {
  test("a month's cycle ends on the FIRST of the NEXT month", () => {
    // Regression pin: the month string is the HUMAN month (1-12), and used
    // directly as a 0-indexed Date month it IS next month. The old code added
    // 1 again, putting October's cycle end in December (right only for
    // December itself) — so these two are the discriminators.
    expect(cycleEndMs("2026-10")).toBe(new Date(2026, 10, 1).getTime());
    expect(cycleEndMs("2026-01")).toBe(new Date(2026, 1, 1).getTime());
    // December rolls into the next year (old and new agree here).
    expect(cycleEndMs("2026-12")).toBe(new Date(2027, 0, 1).getTime());
  });

  test("consecutive cycle ends advance by exactly one month", () => {
    for (let m = 1; m <= 11; m++) {
      const mm = String(m).padStart(2, "0");
      const next = String(m + 1).padStart(2, "0");
      const gapDays = Math.round(
        (cycleEndMs(`2026-${next}`) - cycleEndMs(`2026-${mm}`)) / 86_400_000,
      );
      expect(gapDays).toBe(new Date(2026, m + 1, 0).getDate());
    }
  });
});
