/**
 * The SLA-breach sweep — the enforcement half of a deadline that has only ever been a
 * number in a response body.
 *
 * `SLA_SECONDS` (60 by default, `src/lib/config.ts`) has been the platform's published
 * promise since the intake handler began computing `slaDeadline`. Nothing ever checked
 * it. That is the quietest kind of broken promise: the response says the case is on a
 * clock, the queue says it will be dialled when a worker reaches it, and no component is
 * responsible for noticing when the clock ran out. Under load, or with a provider
 * outage, or after a dial-job lease expiry, a case can sit unanswered for minutes and
 * every surface still reads "healthy".
 *
 * What a breach means here, and why it is defined by ABSENCE OF CONTACT rather than by
 * state: the promise is that the customer is reached — by voice, or by the SMS fallback
 * when voice cannot be admitted. So a case has breached when its own persisted arrival
 * instant is older than the window and it has no `ringingAt`, no `smsSentAt` and no
 * post-call record. Enumerating "bad states" instead would drift the first time someone
 * adds a state, and `FAILED`/`EXHAUSTED`/`RETRY_SCHEDULED` cases with no ring are exactly
 * the ones a state allowlist tends to forget.
 *
 * What this deliberately does NOT do:
 *
 *   - **It does not send the fallback SMS.** Escalating a missed deadline by dialling or
 *     texting a customer again is a second contact on a promise the platform already
 *     failed to keep, and duplicate contact is the harm the SMS pre-notification path is
 *     built to avoid. The breach is recorded, counted and audited; whether to act on it is
 *     an operator decision, and the same reasoning that made an expired staged freeze
 *     escalate rather than reverse applies here.
 *   - **It does not judge cases with no arrival instant.** A case from before
 *     `signalReceivedAt` existed has no measurable deadline. Marking those as breaches
 *     would manufacture an incident history, and reporting them as compliant would
 *     manufacture the opposite; they are simply out of the population, and
 *     `slaBreachPopulation()` says how big the evaluated population is so the rate never
 *     has to be guessed at.
 *
 * Write-once by compare-and-set, so the breach count is a count of cases, not of sweep
 * passes, and two workers running this concurrently still produce one record each.
 */
import "server-only";

import { append as auditAppend } from "@/lib/audit-chain";
import { slaSeconds } from "@/lib/config";
import { db } from "@/lib/db";
import { pilotMode } from "@/lib/pilot/mode";
import { logError, logInfo } from "@/lib/validation/safe-log";

/** Candidates per pass. A breach is not urgent; a breach storm is not a backlog fix. */
const SWEEP_LIMIT = Number(process.env.SLA_SWEEP_LIMIT ?? 100);

export type SlaBreachSweepResult = {
  /** Cases newly marked by this pass. */
  breached: number;
  windowSecs: number;
};

/**
 * Mark every case whose contact deadline passed with no contact of any kind.
 *
 * `now` is injectable because the alternative is a test that sleeps for 61 seconds, and
 * a test that sleeps is a test that gets deleted.
 */
export async function sweepSlaBreaches(
  now: Date = new Date(),
  limit: number = SWEEP_LIMIT,
): Promise<SlaBreachSweepResult> {
  const windowSecs = slaSeconds();

  // ── SHADOW MODE: no contact deadline was ever in force ─────────────────────
  //
  // In shadow mode the platform places no call and sends no SMS by design —
  // that is what Phase 0 is. Every case would therefore "miss" a deadline it
  // was never subject to, the sweep would mark ALL of them as breaches, and
  // the shadow readout — the deliverable of the phase — would read as a 100%
  // deadline miss.
  //
  // An audit trail full of breaches for calls that were deliberately never
  // placed is worse than no audit trail: it makes the one measure the pilot
  // exists to produce read as a failure of the platform rather than a
  // measurement of it.
  //
  // The check is MODE-scoped, not state-scoped, on purpose. The definition
  // this file has always used is "a breach is the ABSENCE OF CONTACT", and
  // enumerating states instead would drift the first time somebody adds one.
  // Shadow mode is not a state — it is a promise that has not been made yet,
  // and a promise not made is not a promise broken.
  if (pilotMode() === "shadow") {
    return { breached: 0, windowSecs };
  }

  const deadline = new Date(now.getTime() - windowSecs * 1000);

  const candidates = await db.case.findMany({
    where: {
      // The arrival instant must exist, or there is no deadline to miss.
      signalReceivedAt: { not: null, lt: deadline },
      ringingAt: null,
      smsSentAt: null,
      postCallAt: null,
      slaBreachedAt: null,
    },
    select: { caseRef: true, orgId: true, signalReceivedAt: true },
    orderBy: { signalReceivedAt: "asc" },
    take: limit,
  });

  let breached = 0;
  for (const c of candidates) {
    // Atomic claim, same discipline as the freeze-window sweep: the predicate repeats
    // the read's conditions, so a callback that lands between the two statements costs
    // this sweep its row instead of stamping a breach onto a case that just reached
    // its customer.
    const claimed = await db.case.updateMany({
      where: {
        caseRef: c.caseRef,
        slaBreachedAt: null,
        ringingAt: null,
        smsSentAt: null,
        postCallAt: null,
      },
      data: { slaBreachedAt: now },
    });
    if (claimed.count === 0) continue;
    breached += 1;

    const overSecs = Math.round((now.getTime() - c.signalReceivedAt!.getTime()) / 1000);
    try {
      await auditAppend({
        callRef: c.caseRef,
        action: "sla",
        intent: "sla_breached",
        callerId: "sla-sweep",
        redactedText: c.caseRef,
        meta: {
          deadline_secs: windowSecs,
          secs_since_signal: overSecs,
          contacted_by: null,
          // Stated in the record so nobody reads this as "the platform retried and
          // fixed it": the sweep reports, it does not contact the customer.
          enforcement: "recorded_for_operator",
        },
        orgId: c.orgId ?? undefined,
      });
    } catch (err) {
      // The row is marked either way: the breach is a fact about the case, and an audit
      // write that fails must not erase it. Logged at error because the append chain is
      // the evidence a bank asks for, and a missing append is the finding.
      logError("[sla-sweep] breach recorded without an audit append", {
        caseRef: c.caseRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (breached > 0) {
    logInfo("[sla-sweep] case deadlines passed with no contact", {
      breached,
      windowSecs,
      limit,
    });
  }
  return { breached, windowSecs };
}

/**
 * The population this check can honestly speak about, for the metric surface:
 * how many cases were eligible to be evaluated, and how many of those breached.
 *
 * Reported together on purpose. A breach count with no denominator is how "0 breaches"
 * gets read as "perfect" during an hour when nothing was ingested at all — and the
 * already-stamped count is exposed too, because an incident is worth more than a rate
 * when someone is on the phone at 2am.
 */
export async function slaBreachPopulation(now: Date = new Date()): Promise<{
  windowSecs: number;
  evaluated: number;
  breachedInWindow: number;
  breachedTotal: number;
  notEvaluatable: number;
}> {
  const windowSecs = slaSeconds();
  const since = new Date(now.getTime() - 3_600_000);
  const [evaluated, breachedInWindow, breachedTotal, notEvaluatable] = await Promise.all([
    db.case.count({ where: { signalReceivedAt: { not: null, lt: now } } }),
    db.case.count({ where: { slaBreachedAt: { not: null, gte: since } } }),
    db.case.count({ where: { slaBreachedAt: { not: null } } }),
    // Arrival instant unknown: a row this sweep is blind to, counted so the blindness is
    // visible rather than inferred from a suspiciously clean rate.
    db.case.count({ where: { signalReceivedAt: null } }),
  ]);
  return { windowSecs, evaluated, breachedInWindow, breachedTotal, notEvaluatable };
}
