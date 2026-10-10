import "server-only";
/**
 * Canonical case state machine — the ONE writer for case state.
 *
 * One enum, one writer, no exceptions. Illegal transitions throw and are
 * logged. The state machine is the enforcement point for invariant I-2:
 * `stage_card_freeze` is executable only from CONFIRMED_FRAUD.
 *
 *   RECEIVED → SCREENED → DIALING → RINGING → ANSWERED → DISCLOSED → VERIFYING
 *   VERIFYING → CONFIRMED_LEGITIMATE | CONFIRMED_FRAUD | UNCERTAIN
 *   CONFIRMED_FRAUD → FREEZE_STAGED → ESCALATED → NOTIFIED → CLOSED
 *   CONFIRMED_LEGITIMATE → NOTIFIED → CLOSED
 *   UNCERTAIN → ESCALATED → NOTIFIED → CLOSED
 */

import { db } from "@/lib/db";
import { enqueueOutbox, type BankEventInput } from "@/lib/outbox";
import { notify } from "@/lib/notifications";
import { notifyRealtime } from "@/lib/realtime";
import { logError } from "@/lib/validation/safe-log";

export const CASE_STATES = [
  "RECEIVED",
  "SCREENED",
  "DIALING",
  "RINGING",
  "ANSWERED",
  "DISCLOSED",
  "VERIFYING",
  "CONFIRMED_LEGITIMATE",
  "CONFIRMED_FRAUD",
  "UNCERTAIN",
  "FREEZE_STAGED",
  "ESCALATED",
  "NOTIFIED",
  "CLOSED",
  "REJECTED",
  "NO_ANSWER",
  "BUSY",
  "FAILED",
  "VOICEMAIL",
  "RETRY_SCHEDULED",
  "EXHAUSTED",
  // Voice failed (voicemail, no answer, dead-lettered dial) and the blind-ping
  // SMS is out; waiting up to 24h for YES / NO. NOT terminal: it is the only
  // state a later reply, or the expiry sweep, can move forward.
  "UNREACHABLE",
] as const;

export type CaseState = (typeof CASE_STATES)[number];

/** The single transition table. Any (from, to) not listed here is illegal. */
const TRANSITIONS: Record<string, readonly string[]> = {
  RECEIVED: ["SCREENED", "REJECTED"],
  // SCREENED -> UNREACHABLE: the dial job dead-lettered before any call connected.
  SCREENED: ["DIALING", "REJECTED", "UNREACHABLE"],
  // DIALING -> UNREACHABLE: the provider reported busy / no-answer / failure.
  DIALING: ["RINGING", "NO_ANSWER", "BUSY", "FAILED", "VOICEMAIL", "UNREACHABLE"],
  RINGING: ["ANSWERED", "NO_ANSWER", "BUSY", "VOICEMAIL", "UNREACHABLE"],
  ANSWERED: ["DISCLOSED", "NO_ANSWER"],
  DISCLOSED: ["VERIFYING", "CONFIRMED_LEGITIMATE", "CONFIRMED_FRAUD", "UNCERTAIN", "CLOSED"],
  VERIFYING: ["CONFIRMED_LEGITIMATE", "CONFIRMED_FRAUD", "UNCERTAIN"],
  CONFIRMED_FRAUD: ["FREEZE_STAGED", "ESCALATED", "NOTIFIED", "CLOSED"],
  CONFIRMED_LEGITIMATE: ["NOTIFIED", "CLOSED"],
  UNCERTAIN: ["ESCALATED", "NOTIFIED", "CLOSED"],
  FREEZE_STAGED: ["ESCALATED", "NOTIFIED", "CLOSED"],
  ESCALATED: ["NOTIFIED", "CLOSED"],
  NOTIFIED: ["CLOSED"],
  NO_ANSWER: ["RETRY_SCHEDULED", "EXHAUSTED", "UNREACHABLE"],
  BUSY: ["RETRY_SCHEDULED", "EXHAUSTED", "UNREACHABLE"],
  VOICEMAIL: ["RETRY_SCHEDULED", "EXHAUSTED", "UNREACHABLE"],
  // NOTIFIED is the way out that ENDS the case, written in ONE transaction with
  // the bank's outbound event (transitionCaseWithOutbox). That is deliberate: a
  // customer's SMS reply, or 24h of silence, must never leave a case in a
  // half-resolved state with no event behind it. The `resolution_method` on that
  // event says HOW it resolved (sms_reply_yes / sms_reply_no /
  // unreachable_no_reply / ...).
  //
  // RETRY_SCHEDULED is the second edge, and it exists so an SMS REPLY can put a
  // case back into the VOICE flow instead of reporting it as unanswered. The
  // blind-ping SMS is the fallback for a call that failed, but the fallback
  // cannot always finish the job: a customer who answers the text is provably
  // reachable on that handset while the text itself says nothing that resolves
  // the alert (they asked for a human, or the reply is unusable across two
  // tenants waiting on one number). Leaving that case in UNREACHABLE until the
  // window closes makes the sweep publish `unreachable_no_reply` — a false
  // statement to the bank's fraud team about a customer who did reply — when the
  // correct outcome is to try the voice channel again on a number that just
  // proved it is live.
  //
  // To RETRY_SCHEDULED and not to DIALING: the dial worker is the only thing
  // that may enter DIALING, and only from a job it has claimed (SCREENED and
  // RETRY_SCHEDULED are its two legal predecessors — src/worker/dial.ts). A
  // direct UNREACHABLE -> DIALING edge would let a webhook mark a call as placed
  // with no job, no attempt number, no calling-window check and no carrier
  // behind it, which is the exact falsehood
  // tests/unit/dial-media-streams-truth.test.ts exists to prevent.
  // RETRY_SCHEDULED is also where the attempt ladder, the after-hours deferral
  // and the `dial_job` (case_id, attempt_no) uniqueness already hang.
  //
  // NOTIFIED stays the only edge that closes the loop with the bank, so adding
  // this one strands nothing: RETRY_SCHEDULED reaches DIALING, and a dial that
  // exhausts dead-letters back through the SMS fallback. A writer must first
  // check WHY the case became UNREACHABLE — a `hearing_impaired` case enters it
  // with voice deliberately skipped (src/app/api/v1/interventions/route.ts), and
  // re-dialling that customer is the accessibility failure the SMS-only path
  // exists to avoid.
  UNREACHABLE: ["NOTIFIED", "RETRY_SCHEDULED"],
  RETRY_SCHEDULED: ["DIALING", "EXHAUSTED"],
  REJECTED: [],
  FAILED: [],
  EXHAUSTED: [],
  CLOSED: [],
};

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * The states with no way out, DERIVED from the table rather than listed by hand.
 *
 * Callers ask "is this case still live?" — an inbound customer call-back, a
 * retention sweep, the console's open-feed. A hand-maintained second list would
 * drift the first time a transition is added, and the drift is silent: a closed
 * case treated as live answers a customer who has no open alert.
 */
export const TERMINAL_CASE_STATES: readonly CaseState[] = CASE_STATES.filter(
  (s) => (TRANSITIONS[s] ?? []).length === 0,
);

export class IllegalTransitionError extends Error {
  constructor(
    public from: string,
    public to: string,
  ) {
    super(`Illegal case transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/** The single writer for case state. Throws on an illegal transition. */
export async function transitionCase(
  caseRef: string,
  to: string,
  meta?: Record<string, unknown>,
): Promise<{ id: string; state: string }> {
  const row = await db.case.findUnique({ where: { caseRef } });
  if (!row) throw new Error(`Case not found: ${caseRef}`);
  const from = row.state;
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
  const updated = await db.case.update({
    where: { caseRef },
    data: { state: to, ...(meta ?? {}) },
    select: { id: true, state: true },
  });
  await recordTransition(caseRef, from, to, meta, row.orgId);
  return updated;
}

/**
 * Every case-state transition gets its own audit row, written by the single
 * writer that performs it.
 *
 * The route handlers already write their own narrative rows ("signal_received",
 * "delivery_call"), and those are what a reader reads. This is the other half:
 * a mechanical, complete record of the state machine itself, produced at the
 * only place state can change — so a transition cannot happen without leaving a
 * trace, no matter which caller performed it or what it forgot to log.
 */
/**
 * Severity mapping for case state transitions.
 * Only the states that matter to a human get a notification.
 */
const SEVERITY_FOR_STATE: Record<string, "page" | "urgent" | "info"> = {
  CONFIRMED_FRAUD: "page",
  FREEZE_STAGED: "page",
  ESCALATED: "urgent",
  FAILED: "urgent",
  EXHAUSTED: "urgent",
  UNREACHABLE: "urgent",
  REJECTED: "info",
  CLOSED: "info",
};

async function recordTransition(
  caseRef: string,
  from: string,
  to: string,
  meta: Record<string, unknown> | undefined,
  orgId: string | null,
): Promise<void> {
  const { append } = await import("@/lib/audit-chain");
  await append(
    {
      callRef: caseRef,
      action: "agent",
      intent: `transition_${from.toLowerCase()}_to_${to.toLowerCase()}`,
      redactedText: `${from} → ${to}`,
      meta: { from, to, ...(meta ?? {}) },
      orgId: orgId ?? undefined,
    },
    { fast: true },
  ).catch((err) => {
    logError("[case-state] transition audit failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Emit an in-app notification for states that require human attention (WP-20)
  const severity = SEVERITY_FOR_STATE[to];
  if (severity) {
    void notify({
      orgId,
      alertType: `case:${to.toLowerCase()}`,
      severity,
      title: `Case ${caseRef}: ${to}`,
      body: `Transitioned from ${from} to ${to}`,
      caseRef,
    }).catch((err) => {
      logError("[case-state] notification failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Emit a realtime event for the console (WP-20)
  void notifyRealtime({
    orgId,
    callRef: caseRef,
    payload: { type: "case_state", caseRef, from, to, meta: meta ?? {} },
  }).catch(() => {});
}

/**
 * Transition + outbox row in ONE transaction (WP-5).
 *
 * This is the only sanctioned way to publish a verdict to the bank: the case
 * state change and the delivery row commit together, so a state can never be
 * reached without its notification, and a notification can never claim a state
 * that did not happen. Illegal transitions still throw before anything writes.
 */
export async function transitionCaseWithOutbox(
  caseRef: string,
  to: string,
  opts: {
    meta?: Record<string, unknown>;
    outbox: BankEventInput & { eventId?: string; occurredAt?: string };
  },
): Promise<{ id: string; state: string; eventId: string }> {
  const row = await db.case.findUnique({ where: { caseRef } });
  if (!row) throw new Error(`Case not found: ${caseRef}`);
  const from = row.state;
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
  return db.$transaction(async (tx) => {
    const updated = await tx.case.update({
      where: { caseRef },
      data: { state: to, ...(opts.meta ?? {}) },
      select: { id: true, state: true },
    });
    const event = await enqueueOutbox(tx, opts.outbox);
    return { ...updated, eventId: event.id };
  });
}

/** Create a case in RECEIVED state. */ export async function createCase(data: {
  caseRef: string;
  orgId?: string | null;
  transactionRef?: string;
  riskScore?: number;
  language?: string;
  phone?: string;
  merchant?: string;
  amountMinor?: number;
  currency?: string;
  consentRecordId?: string;
  conversationId?: string | null;
  /** Last four digits of the card, so the customer can recognise a blind-ping SMS. */
  cardLast4?: string | null;
  /** card_transaction | claim_payout | policy_change | account_takeover */
  signalKind?: string | null;
  /** fact_finding | sensitive_case | b2b | routine | time_critical_fraud (src/lib/call-categories.ts) */
  callCategory?: string | null;
  /**
   * The out-of-band verification token for this case.
   *
   * Passed IN rather than minted here so that the plaintext and the stored hash
   * travel together and the caller can hand the word to the bank integration that
   * renders it in the customer's app. Creating it inside this function would mean
   * the hash is written while the plaintext is discarded — the feature would work
   * and be undeliverable.
   */
  verificationToken?: { plaintext: string; hash: string } | null;
}): Promise<{ id: string; caseRef: string; state: string }> {
  try {
    return await db.case.create({
      data: {
        caseRef: data.caseRef,
        orgId: data.orgId ?? null,
        state: "RECEIVED",
        transactionRef: data.transactionRef ?? null,
        riskScore: data.riskScore ?? null,
        language: data.language ?? "en",
        phone: data.phone ?? null,
        merchant: data.merchant ?? null,
        amountMinor: data.amountMinor ?? null,
        currency: data.currency ?? null,
        consentRecordId: data.consentRecordId ?? null,
        conversationId: data.conversationId ?? null,
        cardLast4: data.cardLast4 ?? null,
        signalKind: data.signalKind ?? null,
        callCategory: data.callCategory ?? null,
        // Write-once, and the migration's trigger refuses any later change to a
        // token that is already set.
        verificationTokenHash: data.verificationToken?.hash ?? null,
        verificationTokenAt: data.verificationToken ? new Date() : null,
      },
      select: { id: true, caseRef: true, state: true },
    });
  } catch (err) {
    // The unique index on (orgId, transactionRef) is the ATOMIC backstop against
    // two signals dialling one transaction. It fires precisely when the policy
    // gate's read-based fast path lost a race — two requests, different
    // Idempotency-Keys, same transaction, both read "no prior case".
    //
    // Without this catch that unique violation escapes as an unhandled 500. That
    // is worse than the double-dial in a specific way: a 500 tells the bank
    // "our fault, retry later", so a client honouring that guidance retries into
    // the same wall, and the body leaks an internal constraint name. Translated
    // here into the same typed refusal the fast path returns, so both paths
    // present one contract.
    const meta = (err as { meta?: { target?: string[] | string } } | null)?.meta;
    const target = Array.isArray(meta?.target) ? meta.target.join(",") : (meta?.target ?? "");
    const message = err instanceof Error ? err.message : "";
    const isUniqueViolation =
      (err as { code?: string } | null)?.code === "P2002" &&
      // Match on the constraint name in the MESSAGE as well as meta.target.
      // Prisma 7 does not reliably populate meta.target for a violation raised
      // by a named index, so keying on target alone made this catch silently
      // never fire -- which is the worst possible failure mode for a guard that
      // exists to convert a 500 into a typed refusal.
      (target.includes("transactionRef") || message.includes("transactionRef"));
    if (!isUniqueViolation) throw err;

    const refused = new Error(`transaction ${data.transactionRef} already has a case`) as Error & {
      status: number;
      code: string;
    };
    refused.status = 409;
    refused.code = "transaction_repeat";
    throw refused;
  }
}

/**
 * Look up a case by caseRef, scoped to one organisation.
 *
 * `orgId` is REQUIRED. This used to take only the ref and return whatever row
 * carried it, which meant any caller holding another tenant's caseRef got that
 * tenant's case. The console routes each pre-checked the org and returned 404
 * before calling this — so the leak was covered at every call site, which is
 * exactly the arrangement that fails the moment a fourth call site appears.
 * The predicate now lives here, once.
 *
 * A null org means the shared namespace: rows with `orgId IS NULL` (seeded demo
 * data) plus the literal `"default"`. Prisma's `in` rejects null members, hence
 * the OR rather than `in: [null, "default"]`.
 */
export async function caseByRef(caseRef: string, orgId: string | null | undefined) {
  return db.case.findFirst({
    where: { caseRef, ...(orgId ? { orgId } : { OR: [{ orgId: null }, { orgId: "default" }] }) },
  });
}

/**
 * Look up a case by conversation_id — the join key for the post-call webhook.
 *
 * Org-scoped, with the same predicate shape as `caseByRef`, `verifyChain` and
 * `acknowledge`. A null/absent `orgId` means the DEFAULT org namespace, never
 * "any org" — which is the point: the tenant is part of the lookup, so a
 * conversation id belonging to another tenant resolves to nothing.
 *
 * Why this could not be scoped before: neither caller had a tenant to scope
 * by. `guardToolCall` now does, because `authorizeToolCall` resolves the org
 * from the presented per-tenant credential, so a leaked tool secret reaches
 * exactly one tenant. The ElevenLabs webhook still authenticates on the shared
 * platform secret and passes `null`, which confines it to the default
 * namespace — a real boundary, and the residual shared-secret risk for inbound
 * provider events is recorded in docs/GAP-REGISTER.md.
 */
export async function caseByConversation(conversationId: string, orgId: string | null | undefined) {
  return db.case.findFirst({
    where: {
      conversationId,
      ...(orgId ? { orgId } : { OR: [{ orgId: null }, { orgId: "default" }] }),
    },
  });
}
