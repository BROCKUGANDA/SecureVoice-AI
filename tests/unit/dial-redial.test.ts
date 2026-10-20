import { describe, expect, it } from "bun:test";
import { shouldSkipRedial } from "@/worker/dial";

/**
 * The redial gate is the line between "attempt 2 should finally ring" and
 * "a reclaimed attempt 1 must never ring twice". Both are cases with a
 * conversation id on the row, so the decision has to use the attempt identity
 * plus the case's terminal state, not the id alone.
 */
describe("shouldSkipRedial", () => {
  const conv = "conv_123";

  it("does not skip a case with no prior conversation", () => {
    expect(shouldSkipRedial(null, 1)).toBe(false);
    expect(shouldSkipRedial({ conversationId: null, state: "SCREENED" }, 1)).toBe(false);
  });

  it("skips a reclaimed first attempt", () => {
    expect(shouldSkipRedial({ conversationId: conv, state: "DIALING" }, 1)).toBe(true);
    expect(shouldSkipRedial({ conversationId: conv, state: "RINGING" }, 1)).toBe(true);
  });

  it("allows a later attempt after a completed failed call", () => {
    for (const state of ["NO_ANSWER", "BUSY", "VOICEMAIL", "RETRY_SCHEDULED"]) {
      expect(shouldSkipRedial({ conversationId: conv, state }, 2), state).toBe(false);
    }
  });

  it("does not redial a live or resolved case even on a later attempt", () => {
    for (const state of ["DIALING", "ANSWERED", "VERIFYING", "CONFIRMED_FRAUD", "CLOSED"]) {
      expect(shouldSkipRedial({ conversationId: conv, state }, 2), state).toBe(true);
    }
  });
});
