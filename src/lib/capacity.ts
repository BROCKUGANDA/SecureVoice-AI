import "server-only";
import { env } from "./config";

/**
 * Capacity ceilings — the numbers that actually cap the platform.
 *
 * Our capacity is the LOWER of (a) what our own compute can serve and (b) what
 * our vendors will permit. In practice (b) binds first: you can buy more app
 * instances in a minute, but a carrier's calls-per-second limit and a voice
 * provider's concurrent-session limit are contracted numbers that take weeks to
 * raise. These are therefore config, not code, and every one carries its
 * provenance — a ceiling we cannot cite is a ceiling we should not enforce.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ELEVENLABS CONCURRENT CALLS
 * Source: https://elevenlabs.io/pricing/agents — read 2026-10-02.
 * Published per-tier limits; burst pricing ($0.16/min, double the standard
 * $0.08/min) applies to calls running above the limit.
 *
 *   Free 4 · Starter 6 · Creator 10 · Pro 20 · Scale 30 · Business 40
 *
 * We do NOT assume the tier we are on. `ELEVENLABS_MAX_CONCURRENT` is set
 * explicitly per deployment, defaulting to the FREE tier (4) because assuming a
 * paid tier is exactly how a demo discovers it was throttled on the day it
 * mattered. Check the real number in the ElevenLabs dashboard and set it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const ELEVENLABS_TIER_CONCURRENCY = {
  free: 4,
  starter: 6,
  creator: 10,
  pro: 20,
  scale: 30,
  business: 40,
} as const;

export type ElevenLabsTier = keyof typeof ELEVENLABS_TIER_CONCURRENCY;

/** Our enforced ceiling. Default = free tier. Override per deployment. */
export const ELEVENLABS_MAX_CONCURRENT = (() => {
  const raw = process.env.ELEVENLABS_MAX_CONCURRENT;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return ELEVENLABS_TIER_CONCURRENCY.free;
})();

/**
 * Burst allowance. ElevenLabs sells burst at 3× the subscription concurrency
 * for calls above the limit, at double the per-minute rate — a far cheaper
 * failure than refusing a fraud intervention. We allow it up to
 * `ELEVENLABS_BURST_MULTIPLIER`, then shed.
 */
const ELEVENLABS_BURST_MULTIPLIER = env.elevenLabsBurstMultiplier;
export const ELEVENLABS_BURST_CEILING = ELEVENLABS_MAX_CONCURRENT * ELEVENLABS_BURST_MULTIPLIER;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TWILIO OUTBOUND TELEPHONY
 *
 * Two distinct limits, both per Twilio account and both raised by support, not
 * by config:
 *   1. Calls per second, PER FROM-NUMBER. Additional from-numbers are
 *      additional lanes — the reason the limiter below is keyed by number and
 *      not global.
 *   2. Account-level concurrent calls in flight.
 *
 * Neither is published as a fixed number: Twilio assigns them per account and
 * they change with usage history and plan. The defaults below are conservative
 * starting points for a new account, NOT quoted terms — read the real numbers
 * from Twilio Console → Voice → Settings (or ask support) and set them.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const TWILIO_CPS_PER_FROM_NUMBER = (() => {
  const raw = process.env.TWILIO_CPS_PER_FROM_NUMBER;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return 2;
})();

export const TWILIO_MAX_CONCURRENT_CALLS = (() => {
  const raw = process.env.TWILIO_MAX_CONCURRENT_CALLS;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return 10;
})();

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ADMISSION CONTROL BANDS
 *
 * When offered volume exceeds what we can serve, we degrade in a defined,
 * audited, risk-prioritised order rather than dropping cases silently. A silent
 * drop during a fraud campaign is the failure mode that would disqualify us in
 * procurement; an audited shed with a stated fallback channel is a feature.
 *
 *   NORMAL      — dial freely.
 *   CONSTRAINED — dial only above the expected-loss threshold; the rest fall
 *                 back to SMS/app push.
 *   SHED        — voice is reserved for the top risk tier only; everything else
 *                 is asynchronous.
 *
 * Thresholds are percentages of `ELEVENLABS_BURST_CEILING`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const BAND_ENTER_CONSTRAINED_PCT = env.bandEnterConstrainedPct;
export const BAND_ENTER_SHED_PCT = env.bandEnterShedPct;

/** Expected-loss score used for triage ordering: risk × amount at risk. */
export function expectedLossScore(riskScore: number, amountMinor: number): number {
  const risk = Number.isFinite(riskScore) ? Math.min(Math.max(riskScore, 0), 1) : 0;
  const amount = Number.isFinite(amountMinor) ? Math.max(amountMinor, 0) : 0;
  return risk * amount;
}

export type AdmissionBand = "NORMAL" | "CONSTRAINED" | "SHED";

/**
 * Decide the band from current in-flight conversations. Pure function: it
 * takes the observed load and returns a decision, so it is testable without a
 * database, a socket, or a vendor.
 */
export function bandFor(activeConversations: number): AdmissionBand {
  if (activeConversations >= ELEVENLABS_BURST_CEILING * BAND_ENTER_SHED_PCT) return "SHED";
  if (activeConversations >= ELEVENLABS_BURST_CEILING * BAND_ENTER_CONSTRAINED_PCT)
    return "CONSTRAINED";
  return "NORMAL";
}

/**
 * May this case use the voice channel right now?
 *
 * @param band            current admission band
 * @param expectedLoss    expected-loss score (risk × amount)
 * @param shedThreshold   expected-loss below which SHED refuses a dial
 */
export function admitsVoice(
  band: AdmissionBand,
  expectedLoss: number,
  shedThreshold: number,
): { admitted: boolean; fallback: "sms" | "app_push" | null; reason: string } {
  if (band === "NORMAL") return { admitted: true, fallback: null, reason: "normal_capacity" };
  if (band === "CONSTRAINED") {
    if (expectedLoss >= shedThreshold)
      return { admitted: true, fallback: null, reason: "constrained_above_threshold" };
    return {
      admitted: false,
      fallback: "sms",
      reason: "constrained_below_expected_loss_threshold",
    };
  }
  // SHED — voice reserved for the top tier only.
  if (expectedLoss >= shedThreshold * 4)
    return { admitted: true, fallback: null, reason: "shed_top_tier_exception" };
  return { admitted: false, fallback: "app_push", reason: "shed_voice_reserved_for_top_tier" };
}

/** Snapshot for the metrics/status surface — no secrets, no customer data. */
export function capacitySnapshot(activeConversations: number) {
  return {
    activeConversations,
    band: bandFor(activeConversations),
    ceilings: {
      elevenLabsConcurrent: ELEVENLABS_MAX_CONCURRENT,
      elevenLabsBurstCeiling: ELEVENLABS_BURST_CEILING,
      twilioCpsPerFromNumber: TWILIO_CPS_PER_FROM_NUMBER,
      twilioMaxConcurrent: TWILIO_MAX_CONCURRENT_CALLS,
    },
    source: {
      elevenLabs: "elevenlabs.io/pricing/agents, read 2026-10-02",
      twilio: "account-specific — verify in Twilio Console before load testing",
    },
  };
}
