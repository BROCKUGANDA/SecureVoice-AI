/**
 * Bad-actor arithmetic the sign-in lockout depends on.
 *
 * `checkBadActor` answers "where does this source stand"; two things a caller
 * needs beyond that, and neither was expressible before: how long a refusal under
 * its OWN ceiling actually lasts, and how to stop punishing a shared egress
 * address once someone in it has proved who they are.
 *
 *   bun test tests/unit/bad-actor-decay.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { env } from "@/lib/config";
import {
  _resetBadActors,
  checkBadActor,
  forgiveSource,
  recordStrike,
  timeUntilStrikesBelow,
} from "@/lib/abuse/bad-actor";

const W = env.abuseBadActorWindowMs;
const BLOCK_AT = env.abuseBadActorBlockAt;
const T0 = 1_700_000_000_000;
const MIN = 60_000;

beforeEach(() => _resetBadActors());

describe("timeUntilStrikesBelow", () => {
  test("an unknown source is not waiting for anything", () => {
    expect(timeUntilStrikesBelow("ip:1.2.3.4", 5, T0)).toBe(0);
  });

  test("under the threshold returns 0", () => {
    for (let i = 0; i < 4; i++) recordStrike("ip:a", 1, T0);
    expect(timeUntilStrikesBelow("ip:a", 5, T0)).toBe(0);
  });

  test("at the threshold, the wait is until the oldest strike decays", () => {
    for (let i = 0; i < 5; i++) recordStrike("ip:b", 1, T0);
    expect(timeUntilStrikesBelow("ip:b", 5, T0)).toBe(W);
    // One ms inside the window it is still over the line; after it, it is not.
    expect(timeUntilStrikesBelow("ip:b", 5, T0 + W - 1)).toBeGreaterThan(0);
    expect(timeUntilStrikesBelow("ip:b", 5, T0 + W + 1)).toBe(0);
  });

  test("the answer is the first decay that brings the sum under the line", () => {
    for (let i = 0; i < 3; i++) recordStrike("ip:c", 1, T0);
    for (let i = 0; i < 2; i++) recordStrike("ip:c", 1, T0 + 10 * MIN);
    // At t+20min: 3 strikes are 40min from decaying, 2 are 50min from decaying.
    // Losing the three oldest leaves 2 < 5, so the wait is 40 minutes — not the
    // full window, which would keep a paying customer out 20 minutes too long.
    expect(timeUntilStrikesBelow("ip:c", 5, T0 + 20 * MIN)).toBe(40 * MIN);
  });

  test("weights count, not request counts", () => {
    recordStrike("ip:d", 3, T0);
    recordStrike("ip:d", 2, T0);
    expect(checkBadActor("ip:d", T0).strikes).toBe(5);
    expect(timeUntilStrikesBelow("ip:d", 5, T0)).toBe(W);
  });
});

describe("forgiveSource", () => {
  test("a verified credential clears the strikes", () => {
    for (let i = 0; i < 4; i++) recordStrike("ip:e", 1, T0);
    expect(checkBadActor("ip:e", T0).strikes).toBe(4);
    forgiveSource("ip:e");
    expect(checkBadActor("ip:e", T0).strikes).toBe(0);
    // Four more failures after forgiveness still cost the full five to reach
    // the ceiling — forgiveness is a reset, not a discount.
    for (let i = 0; i < 4; i++) recordStrike("ip:e", 1, T0);
    expect(checkBadActor("ip:e", T0).strikes).toBe(4);
  });

  test("does not lift a block that is already in force", () => {
    for (let i = 0; i < BLOCK_AT; i++) recordStrike("ip:f", 1, T0);
    expect(checkBadActor("ip:f", T0).action).toBe("block");
    forgiveSource("ip:f");
    expect(checkBadActor("ip:f", T0).action).toBe("block");
  });

  test("is safe on a source never seen", () => {
    expect(() => forgiveSource("ip:never")).not.toThrow();
  });
});
