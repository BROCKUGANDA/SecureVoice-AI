/**
 * UNIT - making sustained abuse expensive without punishing honest mistakes.
 *
 * The control has two ways to fail and both matter:
 *   - TOO LENIENT: an attacker enumerating phone numbers, or hunting for an
 *     injection that sticks, is never slowed down.
 *   - TOO STRICT: a customer who replies "maybe" twice, or a bank engineer whose
 *     producer key mis-signs three requests, is locked out of a fraud channel.
 * Time is injected (`now`), so every window and doubling is exact, not sleepy.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { _resetBadActors, checkBadActor, recordStrike } from "@/lib/abuse/bad-actor";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => _resetBadActors());

describe("the ladder", () => {
  test("an unknown source is allowed", () => {
    expect(checkBadActor("sms:+971500000001", T0)).toEqual({ action: "allow", strikes: 0 });
  });

  test("honest mistakes never reach a throttle", () => {
    // a customer who answers "maybe" twice: 2 x 0.5
    recordStrike("sms:+971500000002", 0.5, T0);
    const v = recordStrike("sms:+971500000002", 0.5, T0 + 10_000);
    expect(v.action).toBe("allow");
  });

  test("sustained probing is throttled, then blocked", () => {
    const id = "sms:+971500000003";
    expect(recordStrike(id, 1, T0).action).toBe("allow");
    expect(recordStrike(id, 1, T0 + 1000).action).toBe("allow");
    expect(recordStrike(id, 1, T0 + 2000).action).toBe("throttle"); // 3
    expect(recordStrike(id, 1, T0 + 3000).action).toBe("throttle");
    expect(recordStrike(id, 1, T0 + 4000).action).toBe("throttle");
    const blocked = recordStrike(id, 1, T0 + 5000); // 6
    expect(blocked.action).toBe("block");
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(checkBadActor(id, T0 + 6000).action).toBe("block");
  });

  test("one injection attempt is worth three honest mistakes", () => {
    const id = "ip:203.0.113.9";
    expect(recordStrike(id, 3, T0).action).toBe("throttle");
    expect(recordStrike(id, 3, T0 + 1000).action).toBe("block");
  });

  test("a zero or negative weight can never HELP an attacker by cancelling strikes", () => {
    const id = "ip:203.0.113.10";
    recordStrike(id, 5, T0);
    recordStrike(id, -100, T0 + 1000);
    expect(checkBadActor(id, T0 + 2000).strikes).toBeGreaterThanOrEqual(5);
  });
});

describe("forgiveness", () => {
  test("strikes expire after an hour", () => {
    const id = "sms:+971500000004";
    recordStrike(id, 2.5, T0);
    expect(checkBadActor(id, T0 + 59 * MIN).strikes).toBeGreaterThan(0);
    expect(checkBadActor(id, T0 + HOUR + 1).strikes).toBe(0);
  });

  test("a block lifts after its duration", () => {
    const id = "sms:+971500000005";
    recordStrike(id, 6, T0);
    expect(checkBadActor(id, T0 + 30 * MIN).action).toBe("block");
    expect(checkBadActor(id, T0 + HOUR + 1).action).toBe("allow");
  });
});

describe("repeat offenders pay more", () => {
  test("each block doubles, capped at 24h", () => {
    const id = "sms:+971500000006";
    let now = T0;
    const durations: number[] = [];
    for (let i = 0; i < 8; i++) {
      const v = recordStrike(id, 6, now);
      expect(v.action).toBe("block");
      durations.push(v.retryAfterMs!);
      now += v.retryAfterMs! + 1; // wait out the block, then offend again
    }
    expect(durations[0]).toBeCloseTo(1 * HOUR, -2);
    expect(durations[1]).toBeCloseTo(2 * HOUR, -2);
    expect(durations[2]).toBeCloseTo(4 * HOUR, -2);
    expect(durations[3]).toBeCloseTo(8 * HOUR, -2);
    expect(durations[4]).toBeCloseTo(16 * HOUR, -2);
    // capped, never longer than a day
    for (const d of durations.slice(5)) expect(d).toBeLessThanOrEqual(24 * HOUR);
  });
});

describe("isolation and hygiene", () => {
  test("one source's strikes do not touch another's", () => {
    recordStrike("sms:+971500000007", 6, T0);
    expect(checkBadActor("sms:+971500000008", T0).action).toBe("allow");
  });

  test("a phone number is never held as a key: only a hash", () => {
    // Observable consequence: the identifier cannot be recovered or enumerated.
    // We cannot read the module's private map, so assert the contract instead -
    // the same identifier always maps to the same entry, different ones do not.
    recordStrike("sms:+971500000009", 3, T0);
    expect(checkBadActor("sms:+971500000009", T0).strikes).toBe(3);
    expect(checkBadActor("SMS:+971500000009", T0).strikes).toBe(0);
  });

  test("memory is bounded: a flood of distinct sources cannot grow it without limit", () => {
    // 10k is the ceiling; push well past it. The assertion is that this finishes
    // and that recent offenders are still tracked after pruning the oldest.
    for (let i = 0; i < 12_500; i++) recordStrike(`ip:flood-${i}`, 1, T0 + i);
    expect(checkBadActor("ip:flood-12499", T0 + 12_500).strikes).toBe(1);
  });
});
