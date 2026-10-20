import "server-only";
/**
 * The pilot charter gate — the intake half of pilot mode.
 *
 * `src/lib/pilot/mode.ts` owns the mode, the kill switch and the dial-time
 * decision. This module owns the question a BANK asks at ingest: "may this
 * signal become a pilot intervention at all?"
 *
 * ── What it decides, and what it deliberately does not ───────────────────────
 *
 * Two refusals, and two:
 *
 *   · `pilot_signal_kind_out_of_scope` — the pilot is chartered for one alert
 *     type and this signal is another. Refused, not deferred: a charter the
 *     institution agreed to is not the platform's to reinterpret, and a
 *     deferred out-of-scope signal would sit in the queue waiting for a
 *     decision nobody is going to make.
 *
 *   · `pilot_daily_cap_reached` — the contracted daily volume is spent. The
 *     signal is refused at ingest rather than accepted and queued, because a
 *     queued signal that will not be dialled today is a case whose SLA clock
 *     is already blown: the bank's fraud team would be told "we have it" and
 *     then hear nothing.
 *
 * And ONE thing it does not decide: whether this specific dial happens. In
 * `live` mode a human approves every dial, and that decision belongs to the
 * dial worker (`pilotDialDecision`) and to the console, not to the ingest
 * path. A gate that approved dials would be a second, invisible way for a
 * call to be placed.
 *
 * ── Shadow mode ──────────────────────────────────────────────────────────────
 *
 * In `shadow` mode the signal is ACCEPTED and the case is RECORDED — that is
 * the whole point of Phase 0: the platform must run the real gates over a real
 * (pseudonymised) dataset so the shadow readout measures the real pipeline.
 * What it must not do is contact anybody. So the caller is told
 * `shadow: true` and the rest of the ingest path skips the dial job, the
 * pre-notification SMS and the admission slot.
 */

import {
  pilotActedToday,
  pilotDailyCallCap,
  pilotMode,
  pilotSignalKind,
  type PilotMode,
} from "@/lib/pilot/mode";

export type PilotGateResult =
  | {
      ok: true;
      mode: PilotMode;
      /** True when the signal must not reach a customer. */ shadow: boolean;
    }
  | { ok: false; code: string; reason: string };

/**
 * A pilot refusal, as a THROWN error.
 *
 * The intake gate returns a result because the caller turns it into a 409 in
 * its own envelope. The queue's enqueue path throws instead, because a caller
 * that believes it enqueued a job and did not will report a case as live to a
 * bank — a silent no-op is the worse failure at that point in the flow.
 *
 * `code` and `reason` are carried so a caller can produce the SAME 409 the
 * intake gate produces, rather than a generic 500 that tells the bank to
 * retry into the same refusal.
 */
export class PilotRefusalError extends Error {
  readonly code: string;
  readonly status = 409;

  constructor(code: string, reason: string) {
    super(reason);
    this.name = "PilotRefusalError";
    this.code = code;
  }
}

/**
 * Refuse to create a dial job the pilot will not act on.
 *
 * Throws `PilotRefusalError` when the pilot says no. In `off` mode it returns
 * immediately without touching the database, so a deployment that has never
 * heard of pilot mode pays nothing for it — not one extra query, not one
 * extra import.
 *
 * This is the choke point every dial job passes through, so a NEW ingest path
 * added later cannot bypass the charter or the volume cap by forgetting to
 * ask.
 */
export async function assertPilotAllowsEnqueue(params: {
  orgId: string | null;
  signalKind?: string | null;
}): Promise<void> {
  const result = await runPilotGate(params);
  if (!result.ok) {
    throw new PilotRefusalError(result.code, result.reason);
  }
}

/**
 * May this signal become a pilot intervention?
 *
 * Never throws. A refusal is a decision, not a fault: it must arrive at the
 * bank as a 409 with a cause, never as a 500 that says "retry" and invites a
 * retry into the same refusal.
 */
export async function runPilotGate(params: {
  orgId: string | null;
  signalKind?: string | null;
}): Promise<PilotGateResult> {
  const mode = pilotMode();

  if (mode === "off") {
    return { ok: true, mode, shadow: false };
  }

  // Shadow: no call, no SMS, no admission slot. The case is still recorded by
  // the caller, and every other gate still runs, because the shadow readout is
  // only worth anything if it was produced by the real pipeline.
  if (mode === "shadow") {
    return { ok: true, mode, shadow: true };
  }

  // Live mode. The charter first: one alert type.
  //
  // THE CHARTER FAILS CLOSED ON AN UNKNOWN ALERT TYPE, exactly as the
  // dial-time decision does. `signal_kind` is OPTIONAL in the v1 bank
  // contract and `Case.signalKind` is nullable, so an untyped signal is the
  // common case — and "we cannot show it is the chartered type" is not the
  // same as "it is the chartered type". The earlier reading
  // (`kind && signalKind && mismatch`) let every untyped alert through, which
  // made the one-alert-type rule unenforced for exactly the inputs a bank was
  // most likely to send.
  const kind = pilotSignalKind();
  if (kind) {
    const signalKind = (params.signalKind ?? "").trim();
    if (signalKind !== kind) {
      return {
        ok: false,
        code: "pilot_signal_kind_out_of_scope",
        reason:
          signalKind === ""
            ? `This pilot is chartered for '${kind}' alerts only, and this signal carries no alert type. An untyped alert cannot be shown to be in scope, so no case was recorded and no call was placed.`
            : `This pilot is chartered for '${kind}' alerts only; this signal is '${signalKind}'. No intervention was created and no case was recorded for it.`,
      };
    }
  }

  // The volume cap. A malformed cap is refused rather than treated as "no
  // cap": `pilotDailyCallCap` throws on a malformed value, and a cap that
  // silently became unlimited is the failure this control exists to prevent.
  //
  // `pilot_cap_misconfigured` is deliberately NOT `pilot_daily_cap_reached`. A
  // malformed `PILOT_DAILY_CALL_CAP` is a CONFIGURATION fault, and the
  // remediation the `cap_reached` code tells the bank to apply — "do not retry
  // today, it will be refused identically" — is the wrong instruction for it:
  // the cap is broken until somebody fixes the environment, and the bank's next
  // signal is refused for a reason that has nothing to do with its volume. The
  // dial-time path already used a distinct reason
  // (`pilot_invalid_configuration`); the two surfaces now agree.
  let cap: number | null;
  try {
    cap = pilotDailyCallCap();
  } catch {
    return {
      ok: false,
      code: "pilot_cap_misconfigured",
      reason:
        "The pilot's daily volume cap is misconfigured, so the platform refuses new pilot signals rather than running without a ceiling. The operator has been notified.",
    };
  }

  if (cap !== null) {
    // The SAME counter and the SAME comparator the dial-time decision uses:
    // "how many interventions has this organisation already acted on today",
    // counting distinct cases, over the union of "admitted today" and
    // "settled today". One predicate, one number — the two surfaces cannot
    // disagree about the same ceiling.
    const acted = await pilotActedToday(params.orgId);
    if (acted >= cap) {
      return {
        ok: false,
        code: "pilot_daily_cap_reached",
        reason: `This pilot has acted on its contracted ${cap} interventions for today. No case was created and no call was placed. The cap resets on the platform's next daily boundary.`,
      };
    }
  }

  return { ok: true, mode, shadow: false };
}
