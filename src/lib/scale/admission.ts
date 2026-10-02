import "server-only";
/**
 * WP-19 — the scale-facing view of admission control.
 *
 * This is a THIN WRAPPER and it must stay one. The band logic, the expected-loss
 * ordering, the audit row per shed decision and the global concurrency gauge all
 * live in `src/lib/admission.ts` and `src/lib/capacity.ts`, which are the
 * authorities. What this module adds is only what WP-19 needs on top:
 *
 *   1. the four metrics a load test, a dashboard and an operator all want, under
 *      the names they are filed under: `queue_depth`, `active_conversations`,
 *      `shed_count`, `band`;
 *   2. the arithmetic that turns "we are at 87 concurrent" into "CONSTRAINED
 *      starts at 84, SHED at 114", so a dashboard can render the gates instead of
 *      hard-coding percentages that drift from `src/lib/capacity.ts`;
 *   3. a shed counter, because a counter nobody reads is a counter nobody has.
 *
 * Why not extend the existing module instead? Two reasons, both about who
 * breaks. `src/lib/admission.ts` is imported on the signal→dial hot path by
 * routes that must not acquire new import edges; and the band semantics are
 * already gated by `tests/admission.test.ts` over pure functions. Adding metrics
 * to that file would put a mutable counter next to pure band logic and force
 * every caller of a pure function to carry a module with state in it. The
 * wrapper keeps the state in one place and leaves the hot path untouched.
 */

import {
  activeConversations,
  admitOrDegrade,
  admissionSnapshot,
  type AdmissionDecision,
} from "@/lib/admission";
import {
  BAND_ENTER_CONSTRAINED_PCT,
  BAND_ENTER_SHED_PCT,
  ELEVENLABS_BURST_CEILING,
  admitsVoice,
  bandFor,
  expectedLossScore,
  type AdmissionBand,
} from "@/lib/capacity";
import { queueDepth, type DialJob } from "@/lib/scale/queue";
import { vendorCeilings } from "@/lib/scale/capacity";

// Re-exported, never re-implemented: the band ladder is defined once.
export type { AdmissionDecision };
export { admitOrDegrade, activeConversations, admissionSnapshot, admitsVoice, bandFor, expectedLossScore };
export type { AdmissionBand };

/** The exact metric names WP-19 files them under. */
export type ScaleMetrics = {
  /** Durable rows that still owe the customer a contact (PENDING + CLAIMED). */
  queue_depth: number;
  /** Live gauge: cases on a line or about to be, counted from the Case table. */
  active_conversations: number;
  /** Shed decisions recorded in THIS process since the last reset. */
  shed_count: number;
  band: AdmissionBand;
  gates: {
    constrained_at: number;
    shed_at: number;
    burst_ceiling: number;
    burst_multiplier: number;
    headroom: number;
  };
  ceilings: ReturnType<typeof vendorCeilings>;
  source: { elevenLabs: string; twilio: string };
};

/**
 * Sheds counted in this process. Process-local by necessity: the cross-instance
 * truth is the audit chain (one row per shed, queryable), not a number in
 * memory. `audit-chain` is the ledger; this is the live counter on the panel.
 */
let shedCount = 0;
let shedByBand: Record<AdmissionBand, number> = { NORMAL: 0, CONSTRAINED: 0, SHED: 0 };

export function recordShed(band: AdmissionBand, n = 1): number {
  shedCount += n;
  shedByBand[band] = (shedByBand[band] ?? 0) + n;
  return shedCount;
}

export function shedTotal(): number {
  return shedCount;
}

export function shedTotalsByBand(): Record<AdmissionBand, number> {
  return { ...shedByBand };
}

/** Test hook — also the operator's "reset the counter after a drill" action. */
export function resetShedCounter(): void {
  shedCount = 0;
  shedByBand = { NORMAL: 0, CONSTRAINED: 0, SHED: 0 };
}

/** The gates, derived from the same constants the band ladder uses. */
export function bandGates(): Omit<ScaleMetrics["gates"], "headroom"> {
  const el = vendorCeilings().find((c) => c.name === "elevenLabsConcurrentSessions");
  return {
    constrained_at: ELEVENLABS_BURST_CEILING * BAND_ENTER_CONSTRAINED_PCT,
    shed_at: ELEVENLABS_BURST_CEILING * BAND_ENTER_SHED_PCT,
    burst_ceiling: ELEVENLABS_BURST_CEILING,
    burst_multiplier: ELEVENLABS_BURST_CEILING / Math.max(1, el?.value ?? 1),
  };
}

/**
 * The full metrics snapshot. One gauge read (the Case COUNT) plus one grouped
 * count over `dial_job` — two indexed queries, no locks, safe to poll at 1 Hz
 * per dashboard.
 */
export async function scaleMetricsSnapshot(): Promise<ScaleMetrics> {
  const [active, depth] = await Promise.all([activeConversations(), queueDepth()]);
  const gates = bandGates();
  return {
    queue_depth: depth.pending + depth.claimed,
    active_conversations: active,
    shed_count: shedCount,
    band: bandFor(active),
    gates: { ...gates, headroom: gates.burst_ceiling - active },
    ceilings: vendorCeilings(),
    source: {
      elevenLabs: "elevenlabs.io/pricing/agents, read 2026-10-02 (tier must be confirmed in the dashboard)",
      twilio: "account-specific — Twilio Console → Voice → Settings (not a published number)",
    },
  };
}

/**
 * The admission call the dial worker makes, with the metrics side effects
 * attached: a shed increments the counter, and the gauge/band are recorded even
 * on the happy path (a panel that only moves when something breaks is a panel
 * nobody trusts when something does).
 *
 * `admitOrDegrade` remains the single decision point and the single writer of
 * the shed audit row. This wrapper adds no decision and no audit row of its own:
 * if it ever disagreed with `admitOrDegrade`, we would have two admission
 * authorities, which is the failure mode this whole module is arranged to avoid.
 */
export async function admitAtScale(
  args: {
    callRef: string;
    orgId?: string | null;
    callerId: string;
    riskScore: number;
    amountMinor: number;
  },
): Promise<AdmissionDecision & { queueDepthAtDecision: number }> {
  const decision = await admitOrDegrade(args);
  if (!decision.admitted) recordShed(decision.band);
  return { ...decision, queueDepthAtDecision: (await queueDepth()).pending };
}

/**
 * Queue depth for one org's backlog, using the same scope the dial path uses.
 * Takes a job list rather than a query so a caller that already holds the claim
 * does not pay for a second round trip.
 */
export function pendingOf(jobs: readonly DialJob[]): number {
  return jobs.filter((j) => j.state === "PENDING").length;
}