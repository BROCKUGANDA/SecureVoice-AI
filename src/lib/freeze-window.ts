import "server-only";
/**
 * The reversal window, enforced by a clock instead of a promise.
 *
 * A soft freeze is staged with `committed: false` and a window (REVERSAL_WINDOW_SECS)
 * inside which a second, step-up-authenticated actor is supposed to decide it. Until
 * this module the window was only ever *described* — returned to the agent in a
 * payload and copied into audit meta — so a staged hold sat in FREEZE_STAGED
 * indefinitely, and the product's "reversible until a second actor commits them"
 * sentence had no mechanism behind it.
 *
 * ── Expiry escalates; it never reverses ───────────────────────────────────────
 * Nothing was ever frozen at a bank. This platform sends institutions evidence
 * (`case.notified` in src/lib/contracts/schema.ts) and the institution's own systems
 * hold the ledger, so there is no remote hold for a sweep to roll back. Reporting
 * "freeze reversed" would therefore assert a financial action that never happened —
 * on the record a post-incident review reads. So when the window closes the hold is
 * marked lapsed, a human is paged with the lapse as the reason, and the case moves to
 * ESCALATED through the state machine. `freezeStaged` is deliberately left true: the
 * agent really did stage a hold, and that fact is what the bank's evidence trail
 * must keep.
 *
 * ── Why the sweep is allowed to say "nothing happened" ────────────────────────
 * Every step is a single-winner race against a human committing the same hold. The
 * claim is one conditional UPDATE, so exactly one of {this sweep, the commit route}
 * takes the case out of FREEZE_STAGED; a lost claim is the normal outcome and is not
 * logged as a problem. The residual window is between the claim and the transition —
 * a commit that read the row microseconds earlier can still land its transition. Its
 * only effect is that the case ends up carrying both `freezeCommittedAt` and
 * `freezeLapsedAt`, with both audit rows: ambiguous ordering, no false statement
 * about a freeze that did not exist.
 */
import { append as auditAppend } from "@/lib/audit-chain";
import { IllegalTransitionError, transitionCase } from "@/lib/case-state-machine";
import { env } from "@/lib/config";
import { db } from "@/lib/db";
import { notify } from "@/lib/notifications";
import { logError } from "@/lib/validation/safe-log";

/**
 * Escalate every staged hold whose reversal window has closed with no commit.
 *
 * Bounded (`limit`) and oldest-first, like the SMS sweep it shares the worker's tick
 * with: the outstanding set is every hold nobody decided, so an unbounded read would
 * grow with the platform's own neglect.
 *
 * Returns the case refs it escalated, so the caller can log a count and a test can
 * assert on the ones it seeded.
 */
export async function sweepExpiredFreezeWindows(
  now: Date = new Date(),
  limit = 50,
): Promise<string[]> {
  const windowSecs = env.reversalWindowSecs;
  const deadline = new Date(now.getTime() - windowSecs * 1000);

  const stale = await db.case.findMany({
    where: {
      state: "FREEZE_STAGED",
      // A NULL clock is a hold staged before the clock existed. Those stay as they
      // are — see the migration: escalating them would fire a page storm about
      // decisions that were settled years ago.
      freezeStagedAt: { not: null, lt: deadline },
      freezeCommittedAt: null,
      freezeLapsedAt: null,
    },
    select: {
      caseRef: true,
      orgId: true,
      freezeStagedAt: true,
      freezeReference: true,
    },
    orderBy: { freezeStagedAt: "asc" },
    take: limit,
  });

  const lapsed: string[] = [];
  for (const c of stale) {
    // Atomic claim. `state` is in the predicate so a human who committed between the
    // read and this statement costs the sweep its row instead of costing the case a
    // false lapse marker.
    const claimed = await db.case.updateMany({
      where: {
        caseRef: c.caseRef,
        state: "FREEZE_STAGED",
        freezeCommittedAt: null,
        freezeLapsedAt: null,
      },
      data: { freezeLapsedAt: now },
    });
    if (claimed.count === 0) continue;

    try {
      await auditAppend({
        callRef: c.caseRef,
        action: "freeze",
        intent: "freeze_window_lapsed",
        callerId: "freeze-sweep",
        redactedText: c.caseRef,
        meta: {
          stage: "pending_specialist",
          committed: false,
          enforcement: "escalated",
          reversal_window_secs: windowSecs,
          reference: c.freezeReference ?? `SV-FRZ-${c.caseRef}`,
          staged_at: c.freezeStagedAt?.toISOString() ?? null,
          lapsed_at: now.toISOString(),
        },
        orgId: c.orgId ?? undefined,
      });
    } catch (err) {
      // The audit row is the record of the lapse, so a failure here stops the
      // escalation rather than performing it unrecorded. Releasing the claim puts the
      // case back in the next tick's set instead of stranding it marked-lapsed with
      // nobody paged.
      logError("[freeze-window] lapse audit append failed — releasing the claim", {
        caseRef: c.caseRef,
        error: err instanceof Error ? err.message : String(err),
      });
      await db.case
        .updateMany({
          where: { caseRef: c.caseRef, freezeLapsedAt: now },
          data: { freezeLapsedAt: null },
        })
        .catch(() => {});
      continue;
    }

    try {
      // The state machine's own record-keeping fires the transition audit row, the
      // in-app notification and the realtime event; the page below is the specific
      // one, because "ESCALATED" alone does not say the window closed.
      await transitionCase(c.caseRef, "ESCALATED", { freezeLapsedAt: now });
    } catch (err) {
      if (err instanceof IllegalTransitionError) continue; // a human moved it after the claim
      logError("[freeze-window] escalation transition failed", {
        caseRef: c.caseRef,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Awaited, unlike the notification the state machine fires for the transition
    // itself: this is a worker tick with no response to delay, and the page is the
    // escalation. Firing it off and continuing would let a tick report "lapsed 40
    // holds" while none of them reached anyone.
    try {
      await notify({
        orgId: c.orgId ?? null,
        alertType: "case:freeze_window_lapsed",
        severity: "page",
        title: `Case ${c.caseRef}: staged hold expired with no commit`,
        body: `The reversal window (${windowSecs}s) closed without a second actor deciding the hold. Nothing was frozen at the bank and nothing has been reversed — the case is escalated for a human decision.`,
        caseRef: c.caseRef,
      });
    } catch (err) {
      logError("[freeze-window] lapse notification failed", {
        caseRef: c.caseRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    lapsed.push(c.caseRef);
  }
  return lapsed;
}
