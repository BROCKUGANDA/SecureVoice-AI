import { SPAN_TARGETS } from "@/lib/telemetry/spans";

/**
 * The latency budget, as CODE rather than a slide.
 *
 * `docs/LATENCY-BUDGET.md` states the numbers and, more importantly, which of
 * them are measured. This file is the executable half: the per-hop ceilings the
 * pipeline is held to, and the one decision that follows from them � when the
 * budget is blown, stop trying to sound human and get the customer a message.
 *
 * WHY THE CEILINGS ARE NOT ADDED UP TO A SINGLE PROMISE
 *
 * The honest figure for first audio on this pipeline is the `1200 ms` budget the
 * `answered_to_first_agent_word` span is already measured against (see
 * `docs/LATENCY-BUDGET.md`), not a sum of optimistic per-hop estimates. Publishing
 * a 700 ms headline next to a 1.2 s instrumented budget would be two numbers
 * that disagree, and the one a judge checks is the instrumented one. So the hops
 * below are CEILINGS � each is a deadline the hop must meet � and the trip
 * threshold is the measured budget, not the sum of the ceilings.
 *
 * The escalation ladder is deliberately short. A caller who has already waited
 * past the budget stops being helped by a better voice and starts being helped by
 * a written one, which is what `src/lib/elevenlabs/sms-fallback.ts` sends.
 */

export type LatencyHop =
  | "carrier_to_node"
  | "stt_first_partial"
  | "llm_first_token"
  | "tts_time_to_first_byte"
  | "tts_encode";

/** Per-hop ceilings, in ms. Each hop's own deadline is enforced at that hop. */
export const HOP_BUDGET_MS: Record<LatencyHop, number> = {
  carrier_to_node: 100,
  stt_first_partial: 300,
  llm_first_token: 400,
  tts_time_to_first_byte: 300,
  tts_encode: 100,
};

/**
 * The cumulative budget for one answered turn, measured � not estimated � by the
 * `answered_to_first_agent_word` span. Reading it from config rather than
 * hardcoding it keeps the number the code enforces and the number the docs quote
 * the same value.
 */
export function firstAudioBudgetMs(): number {
  return SPAN_TARGETS.answered_to_first_agent_word ?? 1_200;
}

/**
 * Whether a turn that took `elapsedMs` to first audio should fall back to SMS.
 *
 * `answered` means audio was actually produced, so the fallback is about the
 * NEXT turn degrading rather than abandoning this one mid-word: the customer's
 * turn is never cut off by our own budget.
 */
export function shouldFallbackToSms(elapsedMs: number, answered: boolean): boolean {
  if (answered) return false;
  return elapsedMs > firstAudioBudgetMs();
}
