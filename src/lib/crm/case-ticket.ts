import "server-only";
/**
 * Open a handoff ticket for a CASE, from anywhere that decides a human is needed.
 *
 * `createHandoffTicket` takes a fully-built `HandoffTicket`, which suited the one
 * caller that had a case row in hand already (`src/lib/sms-verdict.ts`). The voice
 * plane reaches the same decision from two agent tools, each holding only a
 * `caseRef` — the tool guard hands back `{caseRef, state, conversationId}` and no
 * organisation. Building the ticket at each call site would have meant duplicating
 * the column list, the unscoped-org carve-out and the institution lookup in three
 * places, which is how a data-minimisation rule gets honoured in one of them.
 *
 * NEVER THROWS and never blocks the caller: a ticketing failure must not become a
 * refused handoff. The customer is already on the line waiting for a human, and
 * `createHandoffTicket` has the same rule internally.
 */

import { db } from "@/lib/db";
import { getInstitutionType } from "@/lib/institution";
import { createHandoffTicket } from "./index";
import type { HandoffPriority, HandoffReason } from "./types";

/**
 * Resolve the case and open the ticket.
 *
 * Returns false when nothing was attempted — no row, or no organisation. That
 * second case is not cosmetic: `createHandoffTicket` refuses an empty orgId
 * because a CRM connection belongs to exactly one institution, and an
 * org-less signal has no CRM to write to. It is reported rather than swallowed
 * so a caller that cares can log it.
 */
export async function openCaseHandoffTicket(
  caseRef: string,
  reason: HandoffReason,
  priority: HandoffPriority,
): Promise<boolean> {
  try {
    const row = await db.case.findUnique({
      where: { caseRef },
      select: {
        orgId: true,
        signalKind: true,
        language: true,
        transactionRef: true,
      },
    });
    if (!row?.orgId) return false;

    const institutionType = await getInstitutionType(row.orgId);
    await createHandoffTicket({
      caseRef,
      orgId: row.orgId,
      institutionType,
      signalKind: row.signalKind,
      reason,
      priority,
      language: row.language,
      transactionRef: row.transactionRef,
      // The call ended with a human being asked, not with a resolution method,
      // and the customer has not confirmed anything by typing. Both stay null
      // rather than being invented to fill the shape.
      resolutionMethod: null,
      customerResponse: null,
      auditRef: caseRef,
      consoleUrl: null,
    });
    return true;
  } catch {
    return false;
  }
}
