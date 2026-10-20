import { NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/credits";
import { db } from "@/lib/db";
import {
  pilotStatus,
  pilotOrgIsShared,
  pilotApprovalPrefix,
  PILOT_WAITING_APPROVAL_MARKER,
} from "@/lib/pilot/mode";

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
 * A case is waiting when it has a PENDING dial job, that job is waiting for a
 * HUMAN (rather than for the cap, the concurrency limit, the calling window or
 * the kill switch), and no approval row exists for the attempt that job is on.
 *
 * The three conditions are not interchangeable, and getting them wrong is how
 * a console starts lying:
 *
 *   · The APPROVAL MATCH must use the SAME intent the writer uses. The intent
 *     is `pilot_dial_approved:<attempt>`, and `safeKey` in the audit chain
 *     strips every character outside `[\w.:-]`, so a `#` in a reader's pattern
 *     matches NOTHING. A reader that used one reported every parked job as
 *     "waiting" — including jobs already approved, and jobs the CAP was
 *     holding — and the operator could never clear the list. The prefix comes
 *     from `pilotApprovalPrefix()`, the same place the writer gets it.
 *   · The PARK REASON matters. A job parked by the daily cap, by the
 *     concurrency limit or by the kill switch is waiting for a SYSTEM, not for
 *     a person, and listing it as "waiting for a decision" invites an
 *     operator to approve cases the cap is holding.
 *   · The approval is bound to ONE attempt, so the attempt number is part of
 *     the match.
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
  // What this session may actually DO, derived from the SAME guards the
  // writers use — not from the org alone.
  //
  // The kill switch is PLATFORM-wide, so it needs the operator role AND no
  // active organisation. A demo session has no organisation, so checking the
  // org alone offered the button to exactly the org-less "judge-facing"
  // workspace, where it answers 403. A control that is present and cannot
  // work teaches people the console is lying.
  //
  // The per-dial approval needs the operator role AND an organisation: the
  // approvals route refuses an org-less session outright, because an approval
  // with no organisation would approve a case in no tenant.
  const isOperator = guard.profile.role === "operator";
  const canFlipKillSwitch = isOperator && !orgId;
  const canApprove = isOperator && Boolean(orgId);

  try {
    const status = await pilotStatus(orgId);

    const waiting: Array<{ caseRef: string; attemptNo: number }> = [];
    let waitingCount = 0;
    try {
      // The approval intent PREFIX is a bound parameter, and the WHOLE quoted
      // string is the parameter — a placeholder inside SQL quotes is a literal
      // to Postgres ("bind message supplies 1 parameters, but prepared
      // statement requires 0").
      const approvalPrefix = pilotApprovalPrefix();
      // A job is waiting for a HUMAN when it has never been parked for a
      // system reason. The worker parks a job awaiting approval with
      // `pilot_blocked:pilot_human_approval_required`; a job parked by the cap,
      // the concurrency limit or the kill switch carries a DIFFERENT reason and
      // is not a human's to answer.
      const rows = pilotOrgIsShared(orgId)
        ? await db.$queryRaw<{ case_ref: string; attempt_no: number; n: number }[]>`
            SELECT j."case_ref" AS "case_ref",
                   j."attempt_no"::int AS "attempt_no",
                   count(*) OVER ()::int AS "n"
              FROM "dial_job" j
             WHERE (j."org_id" IS NULL OR j."org_id" = 'default')
               AND j.state = 'PENDING'
               AND (
                 j."last_error" IS NULL
                 OR j."last_error" = ${PILOT_WAITING_APPROVAL_MARKER}
               )
               AND NOT EXISTS (
                 SELECT 1 FROM "AuditLog" a
                  WHERE a."callRef" = j."case_ref"
                    AND (a."orgId" IS NULL OR a."orgId" = 'default')
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
               AND (
                 j."last_error" IS NULL
                 OR j."last_error" = ${PILOT_WAITING_APPROVAL_MARKER}
               )
               AND NOT EXISTS (
                 SELECT 1 FROM "AuditLog" a
                  WHERE a."callRef" = j."case_ref"
                    AND a."orgId" = ${orgId}
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
          canFlipKillSwitch,
          canApprove,
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
