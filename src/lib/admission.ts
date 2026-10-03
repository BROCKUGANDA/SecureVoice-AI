import "server-only";

/**
 * Admission control — what happens when we are already full.
 *
 * The failure mode this exists to prevent: during a fraud campaign the offered
 * volume rises 35× in minutes, and if we are at capacity the alternatives are to
 * queue without bound, refuse indiscriminately, or drop cases silently. All
 * three are bad; the third is disqualifying in a bank's procurement review,
 * because "we could not reach this customer" with no record is indistinguishable
 * from not having tried.
 *
 * So: a defined band, a risk-prioritised decision, a stated fallback channel,
 * and an audit row for every single shed decision.
 *
 * ── The gauge is the database, not a counter in memory ────────────────────────
 * An in-process counter is wrong the moment there are two app instances — and
 * wrong in the dangerous direction (each instance believes it has full
 * headroom). Counting in-flight cases from the `Case` table is naturally
 * correct across instances, survives a restart, and needs no reconciliation
 * sweep. It costs one indexed COUNT per ingest.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { db } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";
import {
  bandFor,
  admitsVoice,
  expectedLossScore,
  capacitySnapshot,
  type AdmissionBand,
} from "@/lib/capacity";

/** States in which a customer is on a line (or about to be). */
const IN_FLIGHT_STATES = ["DIALING", "RINGING", "ANSWERED", "DISCLOSED", "VERIFYING"] as const;

/**
 * Expected-loss threshold below which we stop spending the voice channel.
 * Amount in minor units, so the number is currency-agnostic and integer-only.
 */
function shedThresholdMinor(): number {
  const raw = Number(process.env.SHED_EXPECTED_LOSS_MINOR ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 50_000; // default: AED 500 equivalent
}

/** Live count of conversations currently consuming a voice slot. */
export async function activeConversations(): Promise<number> {
  try {
    return await db.case.count({ where: { state: { in: [...IN_FLIGHT_STATES] } } });
  } catch {
    // A DB blip must not turn into "we are full" — that would shed traffic on
    // our outage rather than the campaign's. Fail open on the gauge; the vendor
    // will reject the call if we are genuinely over, and that rejection is
    // visible in the delivery audit.
    return 0;
  }
}

export type AdmissionDecision = {
  admitted: boolean;
  band: AdmissionBand;
  fallback: "sms" | "app_push" | null;
  reason: string;
  expectedLoss: number;
  activeConversations: number;
};

/**
 * Decide whether this case may use the voice channel right now, and record the
 * decision. Every non-admitted case produces an audit row naming the band, the
 * reason and the fallback taken — that row is the deliverable, and it is what
 * makes "we shed load" answerable to a regulator.
 */
export async function admitOrDegrade(args: {
  callRef: string;
  orgId?: string | null;
  callerId: string;
  riskScore: number;
  amountMinor: number;
}): Promise<AdmissionDecision> {
  const active = await activeConversations();
  const band = bandFor(active);
  const expectedLoss = expectedLossScore(args.riskScore, args.amountMinor);
  const decision = admitsVoice(band, expectedLoss, shedThresholdMinor());

  const outcome: AdmissionDecision = {
    admitted: decision.admitted,
    band,
    fallback: decision.fallback,
    reason: decision.reason,
    expectedLoss: Math.round(expectedLoss),
    activeConversations: active,
  };

  // Only the decisions that cost a customer voice contact are recorded. A
  // NORMAL admit is noise in the audit chain; a shed is the single most
  // important row that case will ever produce.
  if (!decision.admitted) {
    await auditAppend(
      {
        callRef: args.callRef,
        action: "handoff",
        intent: `admission_${band.toLowerCase()}_shed`,
        callerId: args.callerId,
        redactedText: `voice channel shed; fallback=${decision.fallback ?? "none"}`,
        meta: {
          band,
          reason: decision.reason,
          fallback: decision.fallback,
          expectedLoss: outcome.expectedLoss,
          shedThresholdMinor: shedThresholdMinor(),
          activeConversations: active,
          riskScore: args.riskScore,
        },
        orgId: args.orgId ?? undefined,
      },
      // Shedding is exactly the hot path we are protecting — do not let the
      // audit write delay the fallback delivery.
      { fast: true },
    ).catch((err) => {
      // Never let an audit failure swallow a fraud case: the fallback still
      // goes out. The failure is logged loudly and surfaces in monitoring.
      console.error(
        "[admission] shed audit append failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }

  return outcome;
}

/** Metrics/status payload — no secrets, no customer data. */
export async function admissionSnapshot() {
  return capacitySnapshot(await activeConversations());
}
