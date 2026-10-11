/**
 * Unit tests for the email outbox retry arithmetic.
 *
 * ## Why these exist
 *
 * The outbox is the promise that a magic link, an invite, or a pilot
 * notification is delivered EVENTUALLY even when the provider is down. The
 * retry schedule is the part of that promise that is pure arithmetic, and it is
 * worth pinning on its own:
 *
 *   - the delay must GROW, or a provider having a bad minute is retried into
 *     the same bad minute
 *   - it must be JITTERED, because when a provider has an outage every queued
 *     message retries on the same schedule otherwise and re-creates the burst
 *     that caused the rate limit
 *   - it must be CAPPED, or a long outage schedules a retry a day out
 *
 * `deliverEmail` itself is deliberately NOT here: it persists its state
 * transition to the database inline, so it needs a live database and belongs
 * with the other DB-backed outbox specs (tests/workers/email-delivery-signals).
 * The sender is injectable precisely so those specs need no provider key.
 *
 *   bun test tests/unit/email-outbox.test.ts
 */
import { test, expect, describe } from "bun:test";
import { backoffMs, maxAttempts } from "@/lib/email/outbox";

describe("backoffMs — the retry schedule", () => {
  test("grows with the attempt number", () => {
    // A zero rand gives the lower bound of each attempt's window, so the
    // ordering is deterministic rather than jitter-dependent.
    const first = backoffMs(1, 0);
    const second = backoffMs(2, 0);
    const third = backoffMs(3, 0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  test("is jittered, so workers do not retry in lockstep", () => {
    // The point of jitter: when a provider has an outage, every queued message
    // would otherwise retry together and re-create the burst that caused the
    // rate limit. Same attempt, different rand, different delay.
    const a = backoffMs(4, 0);
    const b = backoffMs(4, 1);
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeGreaterThan(1000);
  });

  test("never returns zero", () => {
    // A zero delay would retry immediately, which is not a backoff.
    for (let attempt = 1; attempt <= maxAttempts(); attempt += 1) {
      expect(backoffMs(attempt, 0)).toBeGreaterThan(0);
    }
  });

  test("is capped, so a long outage does not schedule a day out", () => {
    const capped = backoffMs(20, 1);
    expect(capped).toBeLessThanOrEqual(15 * 60_000);
  });

  test("stays inside its window for every rand", () => {
    for (const rand of [0, 0.25, 0.5, 0.75, 1]) {
      const value = backoffMs(3, rand);
      const base = Math.min(2 ** 3 * 1000, 15 * 60_000);
      expect(value).toBeGreaterThanOrEqual(Math.floor(base * 0.5));
      expect(value).toBeLessThanOrEqual(Math.floor(base * 1.0));
    }
  });
});

describe("maxAttempts", () => {
  test("is the documented ladder length", () => {
    expect(maxAttempts()).toBe(6);
  });
});
