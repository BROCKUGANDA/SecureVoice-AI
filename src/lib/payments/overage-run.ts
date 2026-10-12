import "server-only";
/**
 * Running the overage bill.
 *
 * `overage.ts` could rate a period and raise an invoice for four months without
 * anything ever calling it — the functions were tested from a test file, and a
 * billing path with no production caller is a billing path that does not exist
 * when a customer's period closes. This module is the caller: it finds the
 * tenants that have a mirrored subscription, rates each one's most recently
 * CLOSED period, and raises the invoice.
 *
 * ## Two switches, because this file creates money-adjacent documents
 *
 *   · `OVERAGE_INVOICING_ENABLED=1` — without it the run MEASURES and reports
 *     `would_bill` for every tenant it would have invoiced, and writes nothing.
 *     A deploy can therefore prove the numbers are right before any of them
 *     reaches a bank's accounts team. This is not a dry-run flag standing in for
 *     the real thing: the same `raiseOverageInvoice()` and
 *     `pushOverageInvoiceToGateway()` calls run when it is set, and
 *     `tests/billing/overage-run.test.ts` exercises both sides.
 *   · the LIVE-KEY guard is NOT re-implemented here. `resolvePaymentProvider()`
 *     builds the adapter, and the adapter refuses a `pdl_live_` key unless
 *     `PADDLE_ALLOW_LIVE_KEYS=1` (src/lib/payments/paddle.ts:355). Duplicating
 *     that test would give two answers to "may this reach production".
 *
 * Invoices are `collection_mode: "manual"` — a Net-30 document, never an
 * automatic charge — because a Merchant of Record holds no card authorization to
 * charge later. See the long note in `overage.ts`.
 *
 * ## Which window, and why it is the same window on every re-run
 *
 * A mirrored `currentPeriodEnd` is always the end of the CURRENT (open) period:
 * Paddle advances it at the renewal. So the period that just CLOSED is
 * `[end - 2 months, end - 1 month)`. Deriving the window from the mirror rather
 * than from "now minus 30 days" is what makes `overageInvoiceReference()` stable
 * — a rolling window would produce a NEW reference on every run and bill the same
 * usage twice, and `PaymentRecord.reference`'s unique index would never catch it
 * because the references really would be different.
 */

import { db } from "@/lib/db";
import { subMonths } from "date-fns";
import { logError, logInfo } from "@/lib/validation/safe-log";
import { resolvePaymentProvider } from "@/lib/payments/gateway";
import {
  overageInvoiceReference,
  pushOverageInvoiceToGateway,
  raiseOverageInvoice,
  summariseOverage,
} from "@/lib/payments/overage";

/** The env switch that lets this run write anything. */
export const INVOICING_ENABLED_ENV = "OVERAGE_INVOICING_ENABLED";

/** The actor recorded on every invoice this raises. Audit, not a person. */
export const OVERAGE_RUN_ACTOR = "system:overage-worker";

export type OverageOutcome =
  /** Rated, invoiced, and pushed to the gateway. */
  | "billed"
  /** Rated as billable, but invoicing is not enabled — nothing was written. */
  | "would_bill"
  /** The invoice for this window already existed (a re-run, or a retried job). */
  | "duplicate"
  /** Rated with nothing beyond the allowance. The normal case. */
  | "nothing_to_bill"
  /** This tenant cannot be rated — no plan, no period end, negotiated volume. */
  | "skipped"
  /** The raise or the push failed. Named in `reason`, never swallowed. */
  | "failed";

export type OverageOrgResult = {
  orgId: string;
  outcome: OverageOutcome;
  plan: string | null;
  billableUnits?: number;
  amountMinor?: number;
  currency?: string;
  rateMinorPerUnit?: number;
  reference?: string;
  invoiceId?: string;
  /** Why, for every non-`billed` outcome. Stable, so a run can be filtered on it. */
  reason?: string;
};

export type OverageRunReport = {
  /** False when `OVERAGE_INVOICING_ENABLED` is unset: measured only, nothing written. */
  invoicingEnabled: boolean;
  /** Set when the whole run refused, before any tenant was looked at. */
  refused?: { reason: string; detail: string };
  results: OverageOrgResult[];
  totals: {
    candidates: number;
    billed: number;
    wouldBill: number;
    duplicates: number;
    nothingToBill: number;
    skipped: number;
    failed: number;
  };
};

/**
 * The closed period for one subscription, derived from the mirrored end date.
 *
 * Null when there is no `currentPeriodEnd` to anchor on. Refusing to invent a
 * window is the whole point: an invoice whose period is a guess cannot be
 * defended when the bank's accounts team asks what dates it covers.
 */
export function closedPeriodFor(
  currentPeriodEnd: Date | null | undefined,
): { from: Date; to: Date } | null {
  if (!currentPeriodEnd) return null;
  const to = subMonths(currentPeriodEnd, 1);
  const from = subMonths(to, 1);
  return to.getTime() > from.getTime() ? { from, to } : null;
}

/** The newest mirrored subscription per org, for orgs that could owe money. */
async function candidateOrgs(only?: string): Promise<
  { orgId: string; priceId: string; status: string; currentPeriodEnd: Date | null }[]
> {
  const rows = await db.paddleSubscription.findMany({
    where: {
      status: { in: ["active", "trialing", "past_due"] },
      ...(only ? { orgId: only } : {}),
    },
    // Newest first, so the de-duplication below keeps the row that reflects the
    // current contract rather than whichever one was inserted first.
    orderBy: { updatedAt: "desc" },
    select: { orgId: true, priceId: true, status: true, currentPeriodEnd: true },
  });
  const seen = new Set<string>();
  const out: typeof rows = [];
  for (const r of rows) {
    if (seen.has(r.orgId)) continue;
    seen.add(r.orgId);
    out.push(r);
  }
  return out;
}

/**
 * Rate and invoice every tenant whose period has closed.
 *
 * Idempotent per tenant per period: `overageInvoiceReference()` is a pure
 * function of (org, window) and `raiseOverageInvoice()` inserts with
 * `ON CONFLICT ("reference") DO NOTHING`, so a retried run reports `duplicate`
 * rather than a second bill.
 */
export async function runOverageBilling(input: { now?: Date; orgId?: string } = {}) {
  const invoicingEnabled = process.env[INVOICING_ENABLED_ENV] === "1";
  const report: OverageRunReport = {
    invoicingEnabled,
    results: [],
    totals: {
      candidates: 0,
      billed: 0,
      wouldBill: 0,
      duplicates: 0,
      nothingToBill: 0,
      skipped: 0,
      failed: 0,
    },
  };
  void input.now;

  // The gateway is checked BEFORE any rating, so a deployment with no billing
  // adapter, or a live key nobody acknowledged, says so once instead of once
  // per tenant. `planTier`-style fail-closed: doing nothing is safe, doing the
  // wrong thing to forty banks is not.
  if (invoicingEnabled) {
    const gateway = resolvePaymentProvider();
    if (!gateway.ok) {
      report.refused = {
        reason: "gateway_unavailable",
        detail: gateway.reason,
      };
      return report;
    }
  }

  const candidates = await candidateOrgs(input.orgId);
  report.totals.candidates = candidates.length;

  for (const sub of candidates) {
    const one = await billOne(sub);
    report.results.push(one);
    switch (one.outcome) {
      case "billed":
        report.totals.billed += 1;
        break;
      case "would_bill":
        report.totals.wouldBill += 1;
        break;
      case "duplicate":
        report.totals.duplicates += 1;
        break;
      case "nothing_to_bill":
        report.totals.nothingToBill += 1;
        break;
      case "skipped":
        report.totals.skipped += 1;
        break;
      case "failed":
        report.totals.failed += 1;
        break;
    }
  }

  logInfo("[overage-run] finished", {
    invoicingEnabled,
    ...report.totals,
  });
  return report;
}

async function billOne(sub: {
  orgId: string;
  priceId: string;
  status: string;
  currentPeriodEnd: Date | null;
}): Promise<OverageOrgResult> {
  const { orgId } = sub;

  const period = closedPeriodFor(sub.currentPeriodEnd);
  if (!period) {
    return { orgId, outcome: "skipped", plan: null, reason: "no_period_end" };
  }

  const summarised = await summariseOverage({ orgId, ...period });
  if (!summarised.ok) {
    // Enterprise's negotiated volume and a malformed rate both land here. They
    // are not failures of this run — they are plans this run must not rate, and
    // the detail says which.
    return {
      orgId,
      outcome: summarised.reason === "invalid_period" ? "failed" : "skipped",
      plan: null,
      reason: summarised.reason,
    };
  }
  const s = summarised.summary;

  if (s.billableOverageUnits === 0 || s.amountMinor === 0) {
    return {
      orgId,
      outcome: "nothing_to_bill",
      plan: s.plan,
      billableUnits: s.billableOverageUnits,
      includedUnitsHint: s.includedUnits,
    } as OverageOrgResult;
  }

  const reference = overageInvoiceReference({ orgId, ...period });

  if (!sub.invoicingEnabled) {
    return {
      orgId,
      outcome: "would_bill",
      plan: s.plan,
      billableUnits: s.billableOverageUnits,
      amountMinor: s.amountMinor,
      currency: s.currency,
      rateMinorPerUnit: s.rateMinorPerUnit,
      reference,
      reason: `${INVOICING_ENABLED_ENV} is not set to 1`,
    };
  }

  const raised = await raiseOverageInvoice({
    orgId,
    ...period,
    recordedBy: OVERAGE_RUN_ACTOR,
    note: `raised by ${OVERAGE_RUN_ACTOR}`,
  });
  if (!raised.ok) {
    return {
      orgId,
      outcome: raised.reason === "nothing_to_bill" ? "nothing_to_bill" : "failed",
      plan: s.plan,
      reference,
      reason: raised.reason,
    };
  }
  if (raised.duplicate) {
    return {
      orgId,
      outcome: "duplicate",
      plan: s.plan,
      amountMinor: raised.amount.amountMinor,
      currency: raised.amount.currency,
      reference: raised.reference,
    };
  }

  const pushed = await pushOverageInvoiceToGateway({
    orgId,
    ...period,
    recordedBy: OVERAGE_RUN_ACTOR,
  });
  if (!pushed.ok) {
    // The receivable EXISTS locally (the PaymentRecord row) and only the gateway
    // document failed. Report it as failed with the gateway's reason so an
    // operator re-runs rather than assuming nothing was owed.
    logError("[overage-run] invoice raised but gateway push failed", {
      orgId,
      reference: raised.reference,
      reason: pushed.reason,
    });
    return {
      orgId,
      outcome: "failed",
      plan: s.plan,
      reference: raised.reference,
      reason: `gateway_push_${pushed.reason}`,
    };
  }

  return {
    orgId,
    outcome: "billed",
    plan: s.plan,
    billableUnits: s.billableOverageUnits,
    amountMinor: raised.amount.amountMinor,
    currency: raised.amount.currency,
    rateMinorPerUnit: s.rateMinorPerUnit,
    reference: raised.reference,
    invoiceId: pushed.invoiceId,
  };
}
