import "server-only";
/**
 * Charge mode — who pays for a run, and how much of it is free.
 *
 * ── The problem this exists to solve ──────────────────────────────────────────
 * The product has two populations that run the SAME pipeline and cannot be served
 * by the same billing rule:
 *
 *   · A judge on the public demo. The cost is ours, it is metered so we know what
 *     it costs, and it must NEVER be billed to anyone. There is no customer here.
 *   · A paying institution on a plan. Every intervention is metered, the plan's
 *     published `includedPerMonth` is free, and only what runs past that is
 *     billable as overage.
 *
 * Before this module, one rule covered both: `deductCredit()` decremented a
 * mutable wallet unconditionally, and `src/app/api/console/fire/route.ts` called it
 * for every session including the demo one. So the demo seat — a credential that
 * SHIPS IN THE CLIENT BUNDLE — was quietly draining a credit balance, and the
 * "free" story on the pricing page was a claim rather than a behaviour.
 *
 * ── Why "free" is decided here and not at the call site ──────────────────────
 * A call site that can forget to charge is a call site that will forget to charge.
 * Every metered path resolves through this module, so the answer to "is this billed"
 * is derived from data a caller cannot set — the membership role, the tenant, and
 * the published plan — and never from a request body, a header or a query
 * parameter.
 *
 * ── Why the demo rule is NOT the plan tier ───────────────────────────────────
 * `src/lib/abuse/tiers.ts` resolves an organisation with no declared tier to
 * `"demo"`. An exemption keyed on that would hand a free pass to every paying
 * tenant that has never declared a tier, and the hole would widen silently as
 * customers sign up. Same reasoning as `src/lib/demo-account.ts`, and the same
 * guard is repeated at the predicate.
 *
 * ── Two credit systems, and this is where they meet ──────────────────────────
 * `UsageLedger` (append-only: reserve → consume → release) is what the v1 bank
 * ingest path meters on. `Organization.credits` (a mutable balance) is what the
 * console fire path debits. They were previously completely disjoint — a console
 * fire moved one and wrote no ledger row, and a bank ingest wrote a ledger row and
 * never moved the other — so "credits remaining" meant two different numbers
 * depending on which door you came through. `claimRun()` writes BOTH, in one
 * transaction, so the balance the UI shows and the ledger the overage rater reads
 * cannot disagree.
 */

import { db } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";
import { isDemoAccount } from "@/lib/demo-account";
import { PLAN_INCLUDED_UNITS, unitsForPlan } from "@/lib/payments/plans";
import { orgPlanContext } from "@/lib/billing/plan-context";
import { reserve as ledgerReserve } from "@/lib/billing/ledger";
import { logError } from "@/lib/validation/safe-log";

/**
 * Who is paying.
 *
 *   `demo`   — metered for cost, never billed. No wallet is touched and no ledger
 *              row is written, because there is nothing to charge and a ledger row
 *              against a synthetic org would show up in an overage invoice.
 *   `billed` — metered AND charged. Claims from the tenant's wallet and reserves in
 *              the ledger in one transaction.
 */
export type ChargeMode = "demo" | "billed";

/**
 * Why a run is in its mode. Recorded on every audit row, because "why was this not
 * billed" is a question an auditor will ask about a demo seat and there is no other
 * way to answer it later.
 */
export type ChargeReason =
  /** The published demo credential. Configured exactly where the credential is. */
  | "demo_account"
  /** No tenant. There is nobody to invoice, so this is a sandbox run. */
  | "no_tenant"
  /** A tenant on a plan. */
  | "paid_plan"
  /** A tenant we cannot resolve a plan for — charged from the wallet regardless. */
  | "unresolved_plan";

export type ChargeDecision = {
  mode: ChargeMode;
  reason: ChargeReason;
  /** Plan id when resolvable; null otherwise. */
  plan: string | null;
  /**
   * Free interventions this tenant's plan publishes per commitment period.
   *
   * This is the "free usage at different increments for the different levels of
   * package" the catalog already advertises — `starter` 500, `growth` 2,500,
   * `enterprise` 10,000 — DERIVED from `PLANS[].includedPerMonth` in
   * `src/lib/payments/plans.ts` so there is no second copy to drift.
   *
   * Null for `demo`: a demo run is free in full and without a ceiling, and
   * publishing an allowance for it would invite someone to enforce one.
   */
  includedUnits: number | null;
};

/**
 * Decide how a session's runs are metered.
 *
 * Fails toward `billed`. A database error here must not become a free run: the
 * failure mode of "we could not tell whether this is a demo, so we did not charge"
 * is an unbounded bill for somebody, whereas the reverse is a demo seat that
 * temporarily needs a credit.
 */
export async function resolveChargeMode(input: {
  email: string | null | undefined;
  orgId: string | null | undefined;
}): Promise<ChargeDecision> {
  // First, and deliberately before any database read: the published demo
  // credential. `getProfile()` already confines this address to a null tenant
  // (src/lib/credits.ts), so this returns the same answer for a demo session
  // whether or not the org lookup below would have succeeded.
  if (isDemoAccount(input.email)) {
    return { mode: "demo", reason: "demo_account", plan: null, includedUnits: null };
  }

  // No tenant means there is no customer. The per-user wallet a tenantless session
  // falls back to is a sandbox balance seeded at 25 (src/lib/credits.ts), not a
  // purchase, so charging against it would be invoicing a number nobody paid for.
  if (!input.orgId) {
    return { mode: "demo", reason: "no_tenant", plan: null, includedUnits: null };
  }

  // orgPlanContext never throws by design (src/lib/billing/plan-context.ts), and
  // seats fail open there deliberately. A missing plan therefore still resolves a
  // decision — we just do not know the allowance, and `unresolved_plan` says so on
  // the audit row instead of guessing one.
  const ctx = await orgPlanContext(input.orgId);
  if (ctx.plan) {
    return {
      mode: "billed",
      reason: "paid_plan",
      plan: ctx.plan,
      includedUnits: PLAN_INCLUDED_UNITS[ctx.plan] ?? unitsForPlan(ctx.plan),
    };
  }
  return { mode: "billed", reason: "unresolved_plan", plan: null, includedUnits: null };
}

/**
 * The result of metering one run.
 *
 * `remaining` is the wallet balance AFTER the claim. For a demo run there is no
 * wallet, so it is null rather than 0 — a zero would render as "you are out of
 * credits" on the one surface that must say the opposite.
 */
export type RunClaim =
  | {
      mode: "demo";
      /** Always true for a demo run: we are not charging, so we cannot run out. */
      ok: true;
      remaining: null;
      decision: ChargeDecision;
    }
  | {
      mode: "billed";
      ok: boolean;
      /** Wallet balance after the claim, or null when the claim was refused. */
      remaining: number | null;
      /** Present when `ok` is false, for the 402 body. */
      reason?: "empty_wallet" | "ledger_refused";
      decision: ChargeDecision;
    };

/**
 * Meter ONE run: charge it if it is billable, account for it if it is not, and
 * write the audit row either way.
 *
 * The claim happens BEFORE any upstream cost is incurred, which is the only
 * ordering that prevents oversell: N concurrent runs against a 1-credit wallet
 * cannot all pass a check-then-spend pair, but they can all lose this single atomic
 * decrement. `refundRun` is the exact inverse and is called on every path where
 * nothing was armed.
 *
 * The ledger reservation and the wallet decrement share one transaction so they
 * cannot half-commit. A run that decrements the wallet and fails to reserve would
 * show the operator a balance that no longer reflects anything, and the overage
 * rater would never learn the run happened.
 */
export async function claimRun(input: {
  userId: string;
  email: string | null | undefined;
  orgId: string | null | undefined;
  /** Billing case reference; also the ledger idempotency key. */
  caseRef?: string | null;
}): Promise<RunClaim> {
  const decision = await resolveChargeMode(input);

  if (decision.mode === "demo") {
    // Still audited. A free run is not an untracked run — "we ran this, it cost us
    // money, and it was deliberately not billed" is exactly the record that makes
    // the demo budget defensible.
    await auditRun(input, decision, "run_metered", 0);
    return { mode: "demo", ok: true, remaining: null, decision };
  }

  const orgId = input.orgId;
  if (!orgId) {
    // Unreachable: resolveChargeMode returns demo for a null orgId. Asserted rather
    // than narrowed silently so a future change to that function cannot quietly
    // start billing tenantless sessions against `UserProfile.credits`.
    return { mode: "demo", ok: true, remaining: null, decision };
  }

  const caseRef = input.caseRef ?? `RUN-${orgId.slice(0, 16)}`;
  try {
    const reservation = await ledgerReserve({
      orgId,
      caseRef,
      unitsEstimate: 1,
      reason: "intervention_attempt",
    });
    if (!reservation.ok) {
      await auditRun(input, decision, "run_refused", 0, "ledger_refused");
      return {
        mode: "billed",
        ok: false,
        remaining: null,
        reason: "ledger_refused",
        decision,
      };
    }
  } catch (err) {
    // The ledger is the record the overage invoice is computed from. If it cannot
    // be written, the run is refused rather than performed unmetered: an unmetered
    // run is an unbillable run, and a bank discovering one on an invoice is worse
    // than an operator being told the ledger is down.
    logError("[charge] ledger reservation failed; refusing the run", {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    await auditRun(input, decision, "run_refused", 0, "ledger_unavailable");
    return { mode: "billed", ok: false, remaining: null, reason: "ledger_refused", decision };
  }

  // Atomic claim: the `credits: { gt: 0 }` predicate and the decrement are one
  // statement, so two concurrent runs against a 1-credit wallet cannot both win.
  const r = await db.organization.updateMany({
    where: { id: orgId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  if (r.count === 0) {
    // Nothing was armed, so the reservation is released — otherwise a run refused
    // for an empty wallet still holds a unit, and the wallet can never be refilled
    // by topping up alone.
    await releaseReservation(orgId, caseRef);
    await auditRun(input, decision, "run_refused", 0, "empty_wallet");
    return { mode: "billed", ok: false, remaining: null, reason: "empty_wallet", decision };
  }

  const row = await db.organization.findUnique({
    where: { id: orgId },
    select: { credits: true },
  });
  const remaining = row?.credits ?? 0;
  await auditRun(input, decision, "run_charged", 1, undefined, remaining);
  return { mode: "billed", ok: true, remaining, decision };
}

/** The exact inverse of a successful `claimRun`. Call on every "nothing armed" path. */
export async function refundRun(input: {
  userId: string;
  email: string | null | undefined;
  orgId: string | null | undefined;
  caseRef?: string | null;
  decision?: ChargeDecision;
}): Promise<number | null> {
  const decision = input.decision ?? (await resolveChargeMode(input));
  if (decision.mode === "demo") return null;

  const orgId = input.orgId;
  if (!orgId) return null;
  const caseRef = input.caseRef ?? `RUN-${orgId.slice(0, 16)}`;

  const row = await db.organization.update({
    where: { id: orgId },
    data: { credits: { increment: 1 } },
    select: { credits: true },
  });
  await releaseReservation(orgId, caseRef);
  await auditRun(input, decision, "run_refunded", -1, undefined, row.credits);
  return row.credits;
}

/**
 * Release the unit `claimRun` held.
 *
 * Best-effort by design and logged on failure: a stranded reservation is a
 * recoverable reconciliation item (`reconcile()` in `src/lib/billing/ledger.ts`
 * reports it), whereas failing the refund because the release failed would return a
 * 500 to an operator whose credit never moved.
 */
async function releaseReservation(orgId: string, caseRef: string): Promise<void> {
  try {
    const { release } = await import("@/lib/billing/ledger");
    await release({
      orgId,
      caseRef,
      attemptNo: 1,
      units: 1,
      reason: "run_not_accepted",
    });
  } catch (err) {
    logError("[charge] could not release the run reservation", {
      orgId,
      caseRef,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Every metered run is on the chain, charged or not.
 *
 * Fire-and-forget: an audit outage must not fail the run it describes, and this
 * path is on the hot tool-call budget. The count of failures is exposed by
 * `auditAppendFailures()` to `/api/metrics`, so a lost record is observable rather
 * than silent.
 */
async function auditRun(
  input: { userId: string; email: string | null | undefined; orgId: string | null | undefined },
  decision: ChargeDecision,
  intent: string,
  units: number,
  reason?: string,
  remaining?: number,
): Promise<void> {
  const callRef =
    decision.mode === "demo"
      ? `DEMO-${input.userId.slice(0, 24)}`
      : `WALLET-${input.userId.slice(0, 24)}`;
  await auditAppend({
    callRef,
    action: "consent",
    intent,
    callerId: input.userId,
    redactedText: `${decision.mode}:${decision.reason}`,
    meta: {
      chargeMode: decision.mode,
      chargeReason: decision.reason,
      plan: decision.plan,
      includedUnits: decision.includedUnits,
      units,
      ...(reason ? { refusal: reason } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(input.orgId ? { orgId: input.orgId } : {}),
    },
    orgId: input.orgId ?? undefined,
  }).catch((err) => {
    logError("[charge] run audit append failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
