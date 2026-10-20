import { NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/credits";
import { db } from "@/lib/db";
import { pilotStatus, pilotOrgIsShared, PILOT_APPROVAL_INTENT } from "@/lib/pilot/mode";

export const dynamic = "force-dynamic";

/**
 * The pilot state an operator can act on.
 *
 * `src/lib/pilot/mode.ts` owns the mode and the kill switch; this route is the
 * read surface. It is shown to every signed-in console role on purpose: a
 * specialist mid-incident must be able to SEE that dialling is stopped even
 * though they are not the person allowed to un-stop it.
 *
 * The org operand of the status is derived from the session, never from a
 * query parameter: a tenant goes on trusting a signed-in session, not whatever
 * org id a caller happened to put in a URL. The kill switch, the mode and the
 * caps are platform-level and the same for every org; only the today/in-flight
 * counters differ.
 *
 * ── The cases waiting for a human ───────────────────────────────────────────
 *
 * Phase 1's defining rule is "a human approves every dial", so the queue of
 * cases waiting for that approval IS the pilot's work item, and an operator
 * who cannot see it cannot do the job. The list is here rather than in a
 * separate route because it is the same question as the counters: "what is the
 * pilot doing right now".
 *
 * A case is waiting when it has a PENDING dial job and no approval row for
 * the attempt that job is on. The approval is bound to ONE attempt (see
 * `pilotApprovalIntent`), so a case that was approved on attempt 1 and is now
 * waiting on attempt 2 is waiting again — and the count has to say so, or an
 * operator looks at "0 waiting" while a case sits parked for want of a
 * signature.
 *
 * The list is BOUNDED. A pilot with a thousand parked cases is a pilot whose
 * cap is being ignored, and rendering a thousand rows to say so helps nobody:
 * the operator needs the first few, and the COUNT says how many there really
 * are.
 *
 * The bound is a PARAMETER, cast to int, because Postgres cannot infer the
 * type of a bare parameter in a LIMIT through this driver's query builder
 * ("could not determine data type of parameter $2"). The number is a
 * compile-time constant here and never anything a caller controls.
 */
const MAX_WAITING_CASES = 25;

export async function GET() {
  const guard = await requireSignedIn();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const orgId = guard.profile.orgId ?? null;

  try {
    const status = await pilotStatus(orgId);

    // The cases whose next dial is waiting for a human.
    //
    // The lookup mirrors the decision path's own rule: a job is waiting when
    // it is PENDING and no approval row exists for ITS attempt. The attempt
    // number is the one the job carries, which is the one the operator is
    // about to authorise.
    //
    // The org predicate is the SHARED one for an org-less session, exactly as
    // the counters use it: `null` and `"default"` are the same namespace, and
    // a predicate that treated them as different would count a different set
    // of rows from the one the worker counts.
    const waiting: Array<{ caseRef: string; attemptNo: number }> = [];
    let waitingCount = 0;
    try {
      // The approval intent PREFIX is a bound parameter, and the WHOLE quoted
      // string is the parameter — a placeholder inside SQL quotes is a literal
      // to Postgres ("bind message supplies 1 parameters, but prepared
      // statement requires 0"), so the prefix is bound as
      // `pilot_dial_approved#` and the attempt number is concatenated onto it
      // in SQL.
      const approvalPrefix = `${PILOT_APPROVAL_INTENT}#`;
      const rows = pilotOrgIsShared(orgId)
        ? await db.$queryRaw<{ case_ref: string; attempt_no: number; n: number }[]>`
            SELECT j."case_ref" AS "case_ref",
                   j."attempt_no"::int AS "attempt_no",
                   count(*) OVER ()::int AS "n"
              FROM "dial_job" j
             WHERE (j."org_id" IS NULL OR j."org_id" = 'default')
               AND j.state = 'PENDING'
               AND NOT EXISTS (
                 SELECT 1 FROM "AuditLog" a
                  WHERE a."callRef" = j."case_ref"
                    AND a."intent" = ${approvalPrefix} || j."attempt_no"::text
               )
             ORDER BY j."created_at" ASC
             LIMIT ${MAX_WAITING_CASES}::int
          `
        : await db.$queryRaw<{ case_ref: string; attempt_no: number; n: number }[]>`
            SELECT j."case_ref" AS "case_ref",
                   j."attempt_no"::int AS "attempt_no",
                   count(*) OVER ()::int AS "n"
              FROM "dial_job" j
             WHERE j."org_id" = ${orgId}
               AND j.state = 'PENDING'
               AND NOT EXISTS (
                 SELECT 1 FROM "AuditLog" a
                  WHERE a."callRef" = j."case_ref"
                    AND a."intent" = ${approvalPrefix} || j."attempt_no"::text
               )
             ORDER BY j."created_at" ASC
             LIMIT ${MAX_WAITING_CASES}::int
          `;
      waitingCount = rows[0]?.n ?? 0;
      for (const r of rows) waiting.push({ caseRef: r.case_ref, attemptNo: r.attempt_no });
    } catch {
      // The counters are the important half; the list is a convenience. A
      // failure to read it must not take the status surface down with it.
      waiting.length = 0;
    }

    return NextResponse.json(
      {
        pilot: {
          ...status,
          waiting,
          waitingCount,
          // The kill switch is PLATFORM-WIDE — "stop contacting customers" is
          // not a per-tenant decision — so only a platform operator may flip
          // it, and the console has to know that BEFORE it offers the button.
          // A control that is present and answers 403 is worse than one that is
          // absent: it teaches people that the console is lying.
          canFlipKillSwitch: !orgId,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: `Pilot status unavailable: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 503 },
    );
  }
}
