/**
 * The latency budget is a decision, so it gets a gate.
 *
 * `src/lib/voice/latency-budget.ts` decides when a turn that has not produced
 * audio stops trying to sound human and degrades to SMS. Two properties are
 * asserted here, and both are the ones a bare number cannot have:
 *
 *   — the trip threshold is the SAME number the telemetry span is measured
 *     against, so the budget the docs quote is the budget the code enforces —
 *     a hardcoded copy here would drift the day the span target changed;
 *   — a turn that DID answer is never cut off by the budget. Degrading the NEXT
 *     turn is recovery; truncating the customer's own sentence mid-word is a
 *     failure that presents as one.
 */
import { describe, expect, test } from "bun:test";
import { HOP_BUDGET_MS, firstAudioBudgetMs, shouldFallbackToSms } from "@/lib/voice/latency-budget";
import { SPAN_TARGETS } from "@/lib/telemetry/spans";

describe("the latency budget", () => {
  test("every hop has a positive ceiling", () => {
    for (const [hop, ms] of Object.entries(HOP_BUDGET_MS)) {
      expect(ms, `${hop} has no ceiling`).toBeGreaterThan(0);
    }
  });

  test("the trip threshold is the span target, not a second copy of it", () => {
    expect(firstAudioBudgetMs()).toBe(SPAN_TARGETS.answered_to_first_agent_word);
  });

  test("an unanswered turn past the budget degrades to SMS", () => {
    expect(shouldFallbackToSms(firstAudioBudgetMs() + 1, false)).toBe(true);
    expect(shouldFallbackToSms(firstAudioBudgetMs(), false)).toBe(false);
  });

  test("a turn that already produced audio is never cut off by the budget", () => {
    // Even wildly over budget: the customer is mid-utterance, and finishing it is
    // the whole point of the interaction.
    expect(shouldFallbackToSms(firstAudioBudgetMs() * 10, true)).toBe(false);
  });
});
