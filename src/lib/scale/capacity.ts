import "server-only";
/**
 * WP-19 — the capacity model as CODE, not as a paragraph.
 *
 * `docs/CAPACITY.md` is the prose version of this file and the two must agree.
 * The reason the model lives in code is that a capacity number that only exists
 * in a document goes stale silently: nobody re-reads the deck when a bank's
 * card volume triples, and the number that decays is the one that decides
 * whether a campaign is survived or shed.
 *
 * The chain is: cards × flag rate → interventions/month → mean/hour → assumed
 * peak multiple → required concurrent calls → provider ceilings → cost at peak.
 * Every link is returned with its formula, its unit and its CONFIDENCE, because
 * the difference between a measured number and an extrapolated one is the whole
 * integrity of the model (see `Confidence` below and docs/CAPACITY.md §7).
 *
 * ── What this module deliberately does NOT do ────────────────────────────────
 * It does not enforce the vendor ceilings globally. `src/lib/capacity.ts` (the
 * bands) is the enforcement authority; this module supplies the numbers those
 * bands are reasoned from and the client-side limiter that stops us walking into
 * a 429 in the first place. Two modules disagreeing about capacity is exactly
 * the failure this avoids: the ceiling constants are re-exported from
 * `@/lib/capacity` here, never re-declared.
 */

import {
  BAND_ENTER_CONSTRAINED_PCT,
  BAND_ENTER_SHED_PCT,
  ELEVENLABS_BURST_CEILING,
  ELEVENLABS_MAX_CONCURRENT,
  TWILIO_CPS_PER_FROM_NUMBER,
  TWILIO_MAX_CONCURRENT_CALLS,
  bandFor,
  type AdmissionBand,
} from "@/lib/capacity";

// ── Provenance vocabulary ─────────────────────────────────────────────────────

/**
 * How much a number is worth. Nothing in this file is allowed to be unlabelled,
 * because the failure mode of an unlabelled capacity number is that it is quoted
 * to a bank as a commitment.
 */
export type Confidence =
  /** We ran this ourselves and have the artefact. */
  | "measured"
  /** Derived from a published figure or a documented observation, never at our scale. */
  | "calibrated"
  /** Projected by us from assumptions. Never quote one as a fact. */
  | "extrapolated";

/** What KIND of evidence sits behind a number — narrower than Confidence. */
export type Basis =
  | "published-vendor-limit"
  | "account-configuration"
  | "repo-documented"
  | "derived-from-model"
  | "modelling-assumption";

/** Every input the model consumed, with its label. Rendered into the evidence. */
export type Labelled<T> = {
  value: T;
  confidence: Confidence;
  basis: Basis;
  source: string;
};

// ── Mean call duration ───────────────────────────────────────────────────────

/**
 * 3 minutes — the modelled intervention: opening disclosure, one knowledge
 * challenge, the customer's answer, the closing advice.
 *
 * CALIBRATED, not measured: docs/UNIT-ECONOMICS.md §1 calls this the "observed
 * handle time" from demo traffic, not from a pilot with a real handle-time
 * distribution. A fraud verification that needs a second challenge is charged as
 * two interventions, so the true tail is longer than the mean. Recalibrate from
 * `Case.durationSeconds` (populated post-call, WP-4) once a pilot exists — until
 * then this is the assumption the concurrency ceiling is sized against, and the
 * burst ceiling is deliberately sized with headroom for it to be wrong upward.
 */
export const MEAN_CALL_SECONDS = 180;

// ── Vendor ceilings ──────────────────────────────────────────────────────────

export type CeilingName =
  "elevenLabsConcurrentSessions" | "twilioCallsPerSecondPerNumber" | "twilioAccountConcurrency";

export type VendorCeiling = {
  name: CeilingName;
  vendor: "elevenlabs" | "twilio";
  /** Enforcement value, after any env override. */
  value: number;
  unit: "concurrent_calls" | "calls_per_second";
  /** Where the default came from. */
  source: string;
  /** When the source was read. */
  checkedOn: string;
  basis: Basis;
  confidence: Confidence;
  /** Env var that overrides the default for this deployment. */
  envVar: string;
  /** Why this is not "measured", or what exactly is unverified. */
  note: string;
};

/** Env override per ceiling. Read at CALL time, not at import — see below. */
export const CEILING_ENV_VARS: Record<CeilingName, string> = {
  elevenLabsConcurrentSessions: "ELEVENLABS_MAX_CONCURRENT",
  twilioCallsPerSecondPerNumber: "TWILIO_CPS_PER_FROM_NUMBER",
  twilioAccountConcurrency: "TWILIO_MAX_CONCURRENT_CALLS",
};

const READ_DATE = "2026-10-02";

const CEILING_DEFAULTS: Record<
  CeilingName,
  {
    value: number;
    unit: VendorCeiling["unit"];
    vendor: VendorCeiling["vendor"];
    source: string;
    note: string;
  }
> = {
  elevenLabsConcurrentSessions: {
    value: ELEVENLABS_MAX_CONCURRENT,
    unit: "concurrent_calls",
    vendor: "elevenlabs",
    source:
      "elevenlabs.io/pricing/agents — concurrency by tier (Free 4 · Starter 6 · Creator 10 · Pro 20 · Scale 30 · Business 40)",
    note: "CALIBRATED against a published tier table, NOT measured against our account: we have never run a real conversation at the ceiling. The default is the FREE tier (4) on purpose — assuming a paid tier is how a demo discovers it was throttled on the day it mattered. Read the real number in the ElevenLabs dashboard (Settings → Usage / Limits) and set ELEVENLABS_MAX_CONCURRENT.",
  },
  twilioCallsPerSecondPerNumber: {
    value: TWILIO_CPS_PER_FROM_NUMBER,
    unit: "calls_per_second",
    vendor: "twilio",
    source:
      "Twilio account-specific voice limit — Twilio Console → Voice → Settings, or support. Not a published fixed number; assigned per account and raised by support.",
    note: "CALIBRATED as a conservative starting point for a new account, NOT a quoted term. It is PER FROM-NUMBER, which is why from-numbers are a scaling lever and not a detail: N numbers at C cps give N×C. The default (2) is ours, not Twilio's — set TWILIO_CPS_PER_FROM_NUMBER from the console before load testing.",
  },
  twilioAccountConcurrency: {
    value: TWILIO_MAX_CONCURRENT_CALLS,
    unit: "concurrent_calls",
    vendor: "twilio",
    source:
      "Twilio account-level concurrent calls in flight — Console → Voice → Settings, or support.",
    note: "CALIBRATED conservative default (10) for a new account, NOT a quoted term. This is an ACCOUNT limit, so unlike the per-number CPS it does not improve by buying numbers. The default (10) is ours — set TWILIO_MAX_CONCURRENT_CALLS from the console.",
  },
};

function labelledFor(name: CeilingName): Labelled<number> {
  const d = CEILING_DEFAULTS[name];
  return {
    value: d.value,
    confidence: "calibrated",
    basis: "published-vendor-limit",
    source: d.source,
  };
}

/**
 * One vendor ceiling, with any per-deployment override applied.
 *
 * The env var is read HERE, at call time, rather than captured at module load.
 * That is deliberate and load-bearing: a ceiling raised during an incident
 * ("we bought another ElevenLabs tier, let them back in") must take effect on
 * the next call, not on the next deploy. An incident lever that needs a redeploy
 * is not an incident lever. It also makes the ceilings directly controllable
 * from a load test, which is how tests/load asserts behaviour at a chosen tier.
 *
 * A malformed override falls back to the default AND says so in `note` — a
 * typo'd ceiling must not become "unlimited", which is the direction that costs
 * money.
 */
export function vendorCeiling(name: CeilingName): VendorCeiling {
  const d = CEILING_DEFAULTS[name];
  const envVar = CEILING_ENV_VARS[name];
  const raw = process.env[envVar];
  let value = d.value;
  let note = d.note;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) {
      value = Math.floor(n);
    } else {
      note = `⚠ ${envVar}="${raw}" is not a positive number — using the default ${d.value}. ${d.note}`;
    }
  }
  return {
    name,
    vendor: d.vendor,
    value,
    unit: d.unit,
    envVar,
    source: d.source,
    checkedOn: READ_DATE,
    basis: "published-vendor-limit",
    confidence: "calibrated",
    note,
  };
}

/** All three ceilings, in the order they are quoted in docs/CAPACITY.md §3. */
export function vendorCeilings(): VendorCeiling[] {
  return [
    vendorCeiling("elevenLabsConcurrentSessions"),
    vendorCeiling("twilioCallsPerSecondPerNumber"),
    vendorCeiling("twilioAccountConcurrency"),
  ];
}

/** Load values are labelled, not just numbers. Kept for the evidence artifact. */
export function ceilingInputs(): Record<CeilingName, Labelled<number>> {
  return {
    elevenLabsConcurrentSessions: labelledFor("elevenLabsConcurrentSessions"),
    twilioCallsPerSecondPerNumber: labelledFor("twilioCallsPerSecondPerNumber"),
    twilioAccountConcurrency: labelledFor("twilioAccountConcurrency"),
  };
}

// ── The model ────────────────────────────────────────────────────────────────

/** Hours in an average month — 365.25/12. Avoids a 31-day month read as 744. */
export const HOURS_PER_MONTH = 730;

export type CapacityModelInput = {
  /** Transactions (card events) the institution processes per month. */
  cardsPerMonth: number;
  /** Share of transactions that raise an intervention. 0.35% = 0.0035. */
  flagRate: number;
  /** Mean talk time. Defaults to MEAN_CALL_SECONDS (calibrated). */
  meanCallSeconds?: number;
  /**
   * Peak as a multiple of the mean arrival rate. The single most load-bearing
   * assumption in the model: an extrapolated number, and the one an institution
   * will argue with. 8 is our planning figure, not a measurement.
   */
  peakMultiple?: number;
  /** Carrier $/min. DEFAULT 0 = EXCLUDED, because docs/UNIT-ECONOMICS.md §2
   *  marks it INPUT REQUIRED. A cost model that silently assumed a carrier rate
   *  would be the exact failure of the integrity rule. */
  carrierUsdPerMinute?: number;
  /** ElevenLabs standard rate, $/min. Sourced, see docs/UNIT-ECONOMICS.md §1. */
  elevenLabsUsdPerMinute?: number;
  /** ElevenLabs rate above the plan concurrency, $/min. Sourced, same. */
  elevenLabsBurstUsdPerMinute?: number;
  /** Number of Twilio from-numbers we hold. A lever, not a ceiling. */
  fromNumbers?: number;
  /**
   * Length of the peak window, in minutes. Set it for a burst ("a campaign
   * lands on 8,000 customers in 40 minutes"); leave it out for a steady state
   * and the burst cost fields stay null rather than being invented.
   */
  peakWindowMinutes?: number;
};

export type CapacityStep = {
  id: string;
  formula: string;
  value: number;
  unit: string;
  confidence: Confidence;
  basis: Basis;
  note: string;
};

export type CapacityModel = {
  inputs: {
    cardsPerMonth: Labelled<number>;
    flagRate: Labelled<number>;
    meanCallSeconds: Labelled<number>;
    peakMultiple: Labelled<number>;
    carrierUsdPerMinute: Labelled<number>;
    fromNumbers: Labelled<number>;
  };
  steps: CapacityStep[];
  interventionsPerMonth: number;
  /** Hours the volume above was averaged over: 730, or the burst window. */
  averagingWindowHours: number;
  /** The burst window in minutes, when one was supplied. */
  peakWindowMinutes: number | null;
  meanInterventionsPerHour: number;
  peakInterventionsPerHour: number;
  peakInterventionsPerSecond: number;
  /** Calls in flight at the modelled peak = arrival rate × talk time. */
  requiredConcurrentCalls: number;
  /** From-numbers needed to place `peakInterventionsPerSecond` at the CPS ceiling. */
  fromNumbersRequired: number;
  ceilings: {
    elevenLabsConcurrentSessions: VendorCeiling;
    twilioCallsPerSecondPerNumber: VendorCeiling;
    twilioAccountConcurrency: VendorCeiling;
  };
  /** The ceiling that binds first, and by how much. */
  bindingConstraint: {
    name: CeilingName | "none";
    ratio: number;
    oversubscribed: boolean;
    statement: string;
  };
  /** Modelled demand ÷ each ceiling. > 1 means oversubscribed on that ceiling. */
  ceilingRatios: Record<CeilingName, number>;
  /** Share of the burst voice can serve before the burst allowance runs out. */
  voiceCoverageOfPeak: number;
  /** Band the admission ladder would be in at the modelled peak. */
  bandAtPeak: AdmissionBand;
  bandGates: { constrainedAt: number; shedAt: number; burstCeiling: number };
  costAtPeak: {
    usdPerHour: number;
    usdPerPeakBurst: number | null;
    usdPerPeakBurstMinutes: number | null;
    carrierIncluded: boolean;
    /** The hourly billing cap this peak requires, in minor units (×100). */
    requiredHourlyBillingCeilingMinor: number;
    breakdown: {
      withinPlanConcurrent: number;
      overPlanBurstConcurrent: number;
      conversationalAiUsd: number;
      carrierUsd: number;
    };
    confidence: Confidence;
    note: string;
  };
  verdict: string[];
};

const DEFAULT_PEAK_MULTIPLE = 8;
const DEFAULT_EL_USD_PER_MIN = 0.08; // sourced 2026-10-02
const DEFAULT_EL_BURST_USD_PER_MIN = 0.16; // sourced 2026-10-02

function step(
  id: string,
  formula: string,
  value: number,
  unit: string,
  confidence: Confidence,
  basis: Basis,
  note: string,
): CapacityStep {
  return { id, formula, value, unit, confidence, basis, note };
}

/**
 * Project capacity from a card volume and a flag rate.
 *
 * Pure: no database, no network, no clock. Everything it returns is either a
 * function of the inputs or a labelled constant, so a disagreement about the
 * answer is a disagreement about an assumption — which is the argument worth
 * having with a bank, instead of an argument about a spreadsheet.
 *
 * ## The averaging window is the whole trick
 *
 * `interventionsPerMonth` (cards × flag rate) is a VOLUME, and a volume divided
 * by a month is not a load. Which window you average it over decides whether
 * the answer is "0.4 concurrent calls" or "210":
 *
 *   · steady state → no `peakWindowMinutes`, so the volume is averaged over 730 h
 *     and multiplied by `peakMultiple` (8×) to get the busy hour;
 *   · a campaign   → `peakWindowMinutes: 40`, so the SAME volume is averaged over
 *     40 minutes. The campaign IS the peak, so pass `peakMultiple: 1`.
 *
 * Concurrency (arrival rate × talk time) is invariant under time compression, so
 * there is no way to make a burst cheap by scaling the clock — which is exactly
 * why the burst is the number the platform is sized against.
 */
export function projectCapacity(input: CapacityModelInput): CapacityModel {
  const meanCallSeconds = input.meanCallSeconds ?? MEAN_CALL_SECONDS;
  const peakMultiple = input.peakMultiple ?? DEFAULT_PEAK_MULTIPLE;
  const carrierUsdPerMinute = input.carrierUsdPerMinute ?? 0;
  const elUsdPerMin = input.elevenLabsUsdPerMinute ?? DEFAULT_EL_USD_PER_MIN;
  const elBurstUsdPerMin = input.elevenLabsBurstUsdPerMinute ?? DEFAULT_EL_BURST_USD_PER_MIN;
  const fromNumbers = input.fromNumbers ?? 1;

  const peakWindowMinutes = input.peakWindowMinutes ?? null;
  const windowHours = peakWindowMinutes === null ? HOURS_PER_MONTH : peakWindowMinutes / 60;
  const windowLabel =
    peakWindowMinutes === null
      ? "an average month (730 h)"
      : `a ${peakWindowMinutes}-minute campaign window`;

  const interventionsPerMonth = input.cardsPerMonth * input.flagRate;
  const meanPerHour = interventionsPerMonth / windowHours;
  const peakPerHour = meanPerHour * peakMultiple;
  const peakPerSecond = peakPerHour / 3600;
  // Little's law, applied to a call: in-flight = arrival rate × time in system.
  const requiredConcurrent = peakPerSecond * meanCallSeconds;
  const fromNumbersRequired = Math.max(
    1,
    Math.ceil(peakPerSecond / vendorCeiling("twilioCallsPerSecondPerNumber").value),
  );

  const elCeiling = vendorCeiling("elevenLabsConcurrentSessions");
  const twCps = vendorCeiling("twilioCallsPerSecondPerNumber");
  const twConc = vendorCeiling("twilioAccountConcurrency");
  const burstCeiling = ELEVENLABS_BURST_CEILING;

  const ratios: { name: CeilingName; ratio: number; statement: string }[] = [
    {
      name: "elevenLabsConcurrentSessions",
      ratio: requiredConcurrent / elCeiling.value,
      statement: `conversational-AI concurrency: modelled peak needs ${round(requiredConcurrent)}, plan allows ${elCeiling.value} (burst allowance ${burstCeiling} = 3×, billed at $${elBurstUsdPerMin}/min)`,
    },
    {
      name: "twilioAccountConcurrency",
      ratio: requiredConcurrent / twConc.value,
      statement: `carrier account concurrency: modelled peak needs ${round(requiredConcurrent)}, account allows ${twConc.value} — this one does NOT improve by buying more numbers`,
    },
    {
      name: "twilioCallsPerSecondPerNumber",
      ratio: peakPerSecond / (twCps.value * fromNumbers),
      statement: `carrier calls/second: modelled peak needs ${round(peakPerSecond, 3)}/s, ${fromNumbers} number(s) allow ${twCps.value * fromNumbers}/s — needs ${fromNumbersRequired} number(s)`,
    },
  ];
  const worst = ratios.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  const oversubscribed = worst.ratio > 1;

  const withinPlan = Math.min(requiredConcurrent, elCeiling.value);
  const overPlan = Math.max(0, requiredConcurrent - elCeiling.value);
  // In an hour at the modelled peak, minutes of talk = concurrent calls, because
  // each concurrent call consumes one voice-minute per minute. That identity is
  // what makes the cost ceiling arithmetic exact rather than approximate.
  const conversationalAiUsd = withinPlan * elUsdPerMin + overPlan * elBurstUsdPerMin;
  const carrierUsd = requiredConcurrent * carrierUsdPerMinute;
  const usdPerHour = conversationalAiUsd + carrierUsd;

  const voiceCoverageOfPeak =
    requiredConcurrent > 0 ? Math.min(1, burstCeiling / requiredConcurrent) : 1;

  const verdict: string[] = [];
  verdict.push(
    `${round(interventionsPerMonth)} interventions, averaged over ${windowLabel} → ${round(meanPerHour)}/hour mean, ${round(peakPerHour)}/hour at the modelled peak.`,
  );
  verdict.push(
    `Modelled peak ${round(requiredConcurrent)} concurrent calls (${round(peakPerSecond, 3)}/s offered, mean talk ${meanCallSeconds}s).`,
  );
  if (oversubscribed) {
    verdict.push(
      `⚠ OVERSUBSCRIBED by ${round(worst.ratio, 2)}× against ${worst.name}: ${worst.statement}. Voice can cover ${(voiceCoverageOfPeak * 100).toFixed(1)}% of the modelled peak even at the 3× burst allowance; the remainder must take the fallback channel (SMS / app push) WITH an audit row per case.`,
    );
  } else {
    verdict.push(
      `Within every vendor ceiling. Headroom is held by the admission ladder, not by the vendors.`,
    );
  }
  verdict.push(
    `At the modelled peak the admission ladder sits in ${bandFor(requiredConcurrent)} (CONSTRAINED ≥ ${round(ELEVENLABS_BURST_CEILING * BAND_ENTER_CONSTRAINED_PCT)}, SHED ≥ ${round(ELEVENLABS_BURST_CEILING * BAND_ENTER_SHED_PCT)}).`,
  );
  if (carrierUsdPerMinute === 0) {
    verdict.push(
      "Cost EXCLUDES the carrier: docs/UNIT-ECONOMICS.md §2 marks the carrier $/min INPUT REQUIRED (destination-specific). Fill TWILIO_CARRIER_USD_PER_MINUTE per destination before quoting a cost.",
    );
  }

  return {
    inputs: {
      cardsPerMonth: {
        value: input.cardsPerMonth,
        confidence: "extrapolated",
        basis: "modelling-assumption",
        source: "institution-supplied (their card volume); we have no pilot figure yet",
      },
      flagRate: {
        value: input.flagRate,
        confidence: "extrapolated",
        basis: "modelling-assumption",
        source:
          "institution-supplied; ~0.35% steady state is our planning figure, NOT a measurement",
      },
      meanCallSeconds: {
        value: meanCallSeconds,
        confidence: "calibrated",
        basis: "repo-documented",
        source: "docs/UNIT-ECONOMICS.md §1 (demo-traffic handle time; no pilot distribution yet)",
      },
      peakMultiple: {
        value: peakMultiple,
        confidence: "extrapolated",
        basis: "modelling-assumption",
        source:
          "our planning figure; replace with the institution's own peak-hour ratio once measured",
      },
      carrierUsdPerMinute: {
        value: carrierUsdPerMinute,
        confidence: carrierUsdPerMinute === 0 ? "extrapolated" : "calibrated",
        basis: carrierUsdPerMinute === 0 ? "modelling-assumption" : "repo-documented",
        source:
          carrierUsdPerMinute === 0
            ? "EXCLUDED — INPUT REQUIRED (docs/UNIT-ECONOMICS.md §2, Twilio rate card by destination)"
            : "supplied per destination from the Twilio console",
      },
      fromNumbers: {
        value: fromNumbers,
        confidence: "measured",
        basis: "repo-documented",
        source:
          "deployment configuration; buying numbers is the cheapest scale lever on the carrier side",
      },
    },
    steps: [
      step(
        "interventions_per_month",
        "cards_per_month × flag_rate",
        interventionsPerMonth,
        "interventions/month",
        "extrapolated",
        "derived-from-model",
        "One intervention = one billable voice attempt. This is a VOLUME, not a load.",
      ),
      step(
        "mean_per_hour",
        `interventions ÷ ${round(windowHours, 2)} h (averaging window)`,
        meanPerHour,
        "interventions/hour",
        "extrapolated",
        "derived-from-model",
        `Averaged over ${windowLabel}. Dividing the same volume by 730 h instead of 0.67 h is the difference between a trivial number and a campaign.`,
      ),
      step(
        "peak_per_hour",
        "mean_per_hour × peak_multiple",
        peakPerHour,
        "interventions/hour",
        "extrapolated",
        "derived-from-model",
        peakWindowMinutes === null
          ? "The whole design question lives in peak_multiple."
          : "peak_multiple = 1 for a burst: the campaign window IS the peak, so applying an 8× multiple on top would invent a peak nobody is going to send us.",
      ),
      step(
        "peak_per_second",
        "peak_per_hour ÷ 3600",
        peakPerSecond,
        "interventions/second",
        "extrapolated",
        "derived-from-model",
        "Arrival rate at the peak.",
      ),
      step(
        "required_concurrent",
        "peak_per_second × mean_call_seconds",
        requiredConcurrent,
        "concurrent calls",
        "extrapolated",
        "derived-from-model",
        "Little's law. This is the number a vendor ceiling is compared against, and it is invariant under time compression — you cannot make a burst cheaper by speeding up the clock.",
      ),
      step(
        "from_numbers_required",
        `ceil(peak_per_second ÷ twilio_cps_per_number)`,
        fromNumbersRequired,
        "numbers",
        "extrapolated",
        "derived-from-model",
        "Per-NUMBER CPS is a lever; account concurrency is not.",
      ),
    ],
    interventionsPerMonth,
    /** The period `interventionsPerMonth` was averaged over. 730 h, or the burst. */
    averagingWindowHours: windowHours,
    peakWindowMinutes,
    meanInterventionsPerHour: meanPerHour,
    peakInterventionsPerHour: peakPerHour,
    peakInterventionsPerSecond: peakPerSecond,
    requiredConcurrentCalls: requiredConcurrent,
    fromNumbersRequired,
    ceilings: {
      elevenLabsConcurrentSessions: elCeiling,
      twilioCallsPerSecondPerNumber: twCps,
      twilioAccountConcurrency: twConc,
    },
    bindingConstraint: {
      name: worst.name,
      ratio: worst.ratio,
      oversubscribed,
      statement: worst.statement,
    },
    ceilingRatios: {
      elevenLabsConcurrentSessions: requiredConcurrent / elCeiling.value,
      twilioAccountConcurrency: requiredConcurrent / twConc.value,
      twilioCallsPerSecondPerNumber: peakPerSecond / (twCps.value * fromNumbers),
    },
    voiceCoverageOfPeak,
    bandAtPeak: bandFor(requiredConcurrent),
    bandGates: {
      constrainedAt: ELEVENLABS_BURST_CEILING * BAND_ENTER_CONSTRAINED_PCT,
      shedAt: ELEVENLABS_BURST_CEILING * BAND_ENTER_SHED_PCT,
      burstCeiling: ELEVENLABS_BURST_CEILING,
    },
    costAtPeak: {
      usdPerHour,
      usdPerPeakBurst: peakWindowMinutes === null ? null : (usdPerHour * peakWindowMinutes) / 60,
      usdPerPeakBurstMinutes: peakWindowMinutes,
      carrierIncluded: carrierUsdPerMinute > 0,
      requiredHourlyBillingCeilingMinor: Math.ceil(usdPerHour * 100),
      breakdown: {
        withinPlanConcurrent: withinPlan,
        overPlanBurstConcurrent: overPlan,
        conversationalAiUsd,
        carrierUsd,
      },
      confidence: carrierUsdPerMinute > 0 ? "calibrated" : "extrapolated",
      note:
        `Conversational AI at $${elUsdPerMin}/min in-plan and $${elBurstUsdPerMin}/min above the plan ceiling (both sourced, ${READ_DATE}). Minutes of talk in an hour = concurrent calls. ` +
        (carrierUsdPerMinute > 0
          ? `Carrier included at $${carrierUsdPerMinute}/min.`
          : `CARRIER EXCLUDED — the per-minute carrier rate is destination-specific and is still INPUT REQUIRED (docs/UNIT-ECONOMICS.md §2), so this figure is a FLOOR, not an estimate.`) +
        ` The billing breaker (src/lib/billing/breaker.ts, BILLING_HOURLY_LIMIT_MINOR) must be set above requiredHourlyBillingCeilingMinor or a legitimate campaign gets stopped by the spend breaker.`,
    },
    verdict,
  };
}

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ── Client-side enforcement of the conversational-AI ceiling ─────────────────

/**
 * A 429 is not an error to be counted and shrugged at — it is the vendor telling
 * us the plan ceiling, and the only correct responses are to wait or to degrade.
 * This recognises a throttle from whatever shape it arrives in: a typed status,
 * a `code`, or a message that simply says 429.
 */
export function isThrottle(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  for (const candidate of [e.status, e.statusCode, e.code]) {
    if (candidate === 429) return true;
  }
  return (
    typeof e.message === "string" &&
    /\b429\b|too many requests|rate.?limit|concurrenc/i.test(e.message)
  );
}

/** The local gate could not get a slot in time — the caller must degrade. */
export class VendorCeilingExhaustedError extends Error {
  readonly name = "VendorCeilingExhaustedError";
  constructor(
    readonly inFlight: number,
    readonly ceiling: number,
    readonly waitedMs: number,
  ) {
    super(
      `local vendor ceiling exhausted: ${inFlight} in flight against a ceiling of ${ceiling} after ${waitedMs}ms. Degrade (fallback channel + audit row) rather than queueing without bound.`,
    );
  }
}

/** First backoff step, and the cap it saturates at. */
export const BACKOFF_BASE_MS = 250;
export const BACKOFF_MAX_MS = 8_000;
export const MAX_THROTTLE_ATTEMPTS = 5;

/**
 * Equal jitter: half the delay is fixed, half is random.
 *
 * Fixed delay alone synchronises every worker onto the same retry instant and
 * reproduces the overload that caused the 429. Full random (`0..delay`) can
 * retry at ~0 ms and hammer the endpoint. Equal jitter keeps a floor and still
 * spreads the herd. Same reasoning as AWS's "Exponential Backoff And Jitter"
 * (aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/, checked
 * ${READ_DATE}), which is why the shape is cited rather than invented.
 */
export function throttleBackoffMs(
  attempt: number,
  rand: () => number = Math.random,
  baseMs: number = BACKOFF_BASE_MS,
  maxMs: number = BACKOFF_MAX_MS,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const exponential = Math.min(maxMs, baseMs * 2 ** (n - 1));
  const half = exponential / 2;
  return Math.round(half + rand() * half);
}

export type GateStats = {
  inFlight: number;
  ceiling: number;
  waiters: number;
  granted: number;
  timeouts: number;
};

type Waiter = {
  resolve: () => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * The client-side semaphore in front of the conversational-AI API.
 *
 * Scope, stated plainly: this is a PER-PROCESS gate. It stops one instance from
 * walking into a 429 storm on its own; it is not a cluster-wide admission
 * control and must never be treated as one. The cross-instance authority is the
 * database gauge in `src/lib/admission.ts` (a COUNT of live cases) — a number
 * that is correct with two instances precisely because it is not in memory. Both
 * exist because they answer different questions: the DB gauge decides who gets
 * voice at all; this gate decides how hard we push one process at the vendor.
 *
 * The ceiling is re-read from the environment on every grant, so lowering it is
 * an incident lever that takes effect on the next call.
 */
export class VendorConcurrencyGate {
  private active = 0;
  private waiters: Waiter[] = [];
  private granted = 0;
  private timeouts = 0;

  constructor(
    private readonly ceilingFn: () => number = () =>
      vendorCeiling("elevenLabsConcurrentSessions").value,
  ) {}

  ceiling(): number {
    return Math.max(1, this.ceilingFn());
  }

  stats(): GateStats {
    return {
      inFlight: this.active,
      ceiling: this.ceiling(),
      waiters: this.waiters.length,
      granted: this.granted,
      timeouts: this.timeouts,
    };
  }

  /**
   * Take a slot, or time out. The wait is bounded on purpose: an unbounded wait
   * in front of a fraud intervention converts a vendor limit into a hung request
   * on a customer's fraud case, which is worse than shedding.
   */
  async acquire(maxWaitMs: number): Promise<void> {
    const ceiling = this.ceiling();
    // Single-threaded JS: this check-and-increment cannot interleave.
    if (this.active < ceiling) {
      this.active++;
      this.granted++;
      this.drain();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        this.timeouts++;
        reject(new VendorCeilingExhaustedError(this.active, ceiling, maxWaitMs));
      }, maxWaitMs);
      // The timer exists only to reject; it must not be the reason a process
      // stays alive. Untyped because `setTimeout` resolves to different things
      // under the DOM and Node type environments this project compiles against.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.waiters.push({ resolve, reject, timer });
    });
  }

  release(): void {
    if (this.active > 0) this.active--;
    this.drain();
  }

  /** Hand the freed slot to the longest-waiting caller (FIFO). */
  private drain(): void {
    while (this.waiters.length > 0 && this.active < this.ceiling()) {
      const next = this.waiters.shift();
      if (!next) return;
      clearTimeout(next.timer);
      this.active++;
      this.granted++;
      next.resolve();
    }
  }

  /** Waiters that gave up — reported in the load evidence as a capacity symptom. */
  get exhausted(): number {
    return this.timeouts;
  }
}

/** The process-wide gate. One instance, shared by every call in this process. */
export const elevenLabsGate = new VendorConcurrencyGate();

export type CeilingCallResult<T> = {
  value: T;
  attempts: number;
  throttles: number;
  /** Time the client spent backing off. Reported separately from latency. */
  waitedMs: number;
  /** Gate slots that timed out before a call could even be attempted. */
  gateTimeouts: number;
};

export type CeilingCallOptions<T> = {
  /** The vendor call. Injected, so tests mock at this seam. */
  call: (attempt: number) => Promise<T>;
  gate?: VendorConcurrencyGate;
  /** Override the enforced ceiling for this call. */
  ceiling?: number;
  maxAttempts?: number;
  /** Longest a caller will wait for a slot before degrading. */
  maxWaitMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  rand?: () => number;
  /** Injected so a load test costs no wall clock. Never `setTimeout` by default
   *  in a test — pass a no-op and report `waitedMs` separately. */
  sleep?: (ms: number) => Promise<void>;
  onThrottle?: (info: { attempt: number; delayMs: number; waitedMs: number }) => void;
  onGateTimeout?: (err: VendorCeilingExhaustedError) => void;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one vendor call under the conversational-AI ceiling, retrying 429s with
 * jittered exponential backoff.
 *
 * Ordering matters and is deliberate: the slot is RELEASED before the backoff
 * sleep. Holding a slot while sleeping would convert "the vendor is full" into
 * "we are full too", which is how a throttle becomes an outage.
 */
export async function withElevenLabsCeiling<T>(
  opts: CeilingCallOptions<T>,
): Promise<CeilingCallResult<T>> {
  const gate = opts.gate ?? elevenLabsGate;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_THROTTLE_ATTEMPTS);
  const maxWaitMs = opts.maxWaitMs ?? 2_000;
  const rand = opts.rand ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const baseDelayMs = opts.baseDelayMs ?? BACKOFF_BASE_MS;
  const maxDelayMs = opts.maxDelayMs ?? BACKOFF_MAX_MS;

  let throttles = 0;
  let waitedMs = 0;
  let gateTimeouts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await gate.acquire(maxWaitMs);
    } catch (err) {
      gateTimeouts++;
      opts.onGateTimeout?.(err as VendorCeilingExhaustedError);
      throw err;
    }
    try {
      const value = await opts.call(attempt);
      return { value, attempts: attempt, throttles, waitedMs, gateTimeouts };
    } catch (err) {
      if (!isThrottle(err) || attempt >= maxAttempts) throw err;
      throttles++;
    } finally {
      gate.release();
    }
    const delayMs = throttleBackoffMs(attempt, rand, baseDelayMs, maxDelayMs);
    waitedMs += delayMs;
    opts.onThrottle?.({ attempt, delayMs, waitedMs });
    await sleep(delayMs);
  }
  // Unreachable: the loop either returns or throws. Present so the function's
  // return type is total without a cast.
  throw new Error("withElevenLabsCeiling: exhausted attempts without a value or a throw");
}
