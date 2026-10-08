import "server-only";
/**
 * Overage rating and invoicing — the "we exceeded the bundle, here is the bill"
 * half of the pricing model.
 *
 * ## Shape of the model
 *
 * A bank buys a bundle: an included allowance of interventions per commitment
 * period. Usage inside the allowance costs the bundle price and is NOT billed
 * per unit. Usage above it is an **overage**, rated per unit and invoiced after
 * the period closes. This is the shape a bank actually wants, because it makes
 * our cost predictable for them and keeps the common case off the invoice.
 *
 * The units come from `UsageLedger`, which is already append-only and
 * idempotent per `{caseRef}:{attemptNo}:{kind}`. This module only READS it and
 * computes; it never writes usage. Keeping rating and usage-writing in separate
 * modules is deliberate: usage is written on the hot dial path where a bug is a
 * customer-facing error, and rating runs on a schedule where a bug is a wrong
 * number on an invoice.
 *
 * ## Why this does not guess a price
 *
 * A rate is a commercial commitment. `OVERAGE_RATE_MINOR_PER_UNIT` is unset by
 * default, and when it is unset `raiseOverageInvoice` REFUSES with
 * `rate_not_configured` instead of defaulting to zero or to a number from an
 * old document. Billing a bank at an invented rate is a trust failure that
 * surfaces months later as a disputed invoice; refusing is visible immediately
 * and costs one env var to fix. See docs/TODO.md for the rate decision that
 * still needs a human.
 *
 * ## Why the invoice reference is ours, not the bank's
 *
 * `PaymentRecord.reference` is unique and, for manual bank transfers, is the
 * operator-typed bank reference (see manual-invoice.ts). An overage invoice is
 * different: WE issue the invoice, so the identity of the document is ours and
 * must be deterministic — `{org}:{periodStart}:{periodEnd}` — so that re-running
 * the rater on the same period cannot produce two invoices. The bank reference
 * that eventually settles it is still recorded and verified through the normal
 * dual-control path; this module only raises the document.
 *
 * Rounding: rating is done in integer minor units end to end. `Math.round` is
 * applied once, at the point the per-unit rate is multiplied out, so the
 * invoiced total is reproducible from (units, rate) on any machine.
 */

import { db } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";
import { assertMoney, type Money } from "@/lib/payments/provider";
import { logError } from "@/lib/validation/safe-log";

/** Usage kinds that count TOWARDS a billable total. */
const CONSUMING_KINDS = ["consume"] as const;
/** Usage kinds that give units back. */
const RETURNING_KINDS = ["release", "refund"] as const;

/**
 * Minor units charged per overage unit (fils, cents). Unset by default: see the
 * header. Read per call rather than cached so a rate change takes effect on the
 * next period without a redeploy.
 */
function configuredRateMinorPerUnit(): number | null {
  const raw = process.env.OVERAGE_RATE_MINOR_PER_UNIT;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function billingCurrency(): string {
  return (process.env.BILLING_CURRENCY ?? "AED").toUpperCase();
}

/** Units included in the bundle before overage applies. */
function includedUnitsPerPeriod(): number {
  const raw = process.env.INCLUDED_UNITS_PER_PERIOD;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export type OverageSummary = {
  orgId: string;
  periodFrom: Date;
  periodTo: Date;
  /** Units consumed in the window, after releases/refunds. Never negative. */
  netUsedUnits: number;
  includedUnits: number;
  /** max(0, netUsed - included). The units actually billed. */
  billableOverageUnits: number;
  amountMinor: number;
  currency: string;
  /** False when no rate is configured; the amounts are then 0 and NOT billable. */
  rateConfigured: boolean;
};

export type SummariseResult =
  { ok: true; summary: OverageSummary } | { ok: false; reason: "invalid_period"; detail?: string };

function assertPeriod(from: Date, to: Date): boolean {
  return (
    from instanceof Date &&
    to instanceof Date &&
    !Number.isNaN(from.getTime()) &&
    !Number.isNaN(to.getTime()) &&
    from.getTime() < to.getTime()
  );
}

/**
 * Ranks a period's usage. Read-only: touches no state, so it is safe to call
 * from a quote screen, a scheduled job, or a test.
 */
export async function summariseOverage(input: {
  orgId: string;
  periodFrom: Date;
  periodTo: Date;
}): Promise<SummariseResult> {
  const { orgId, periodFrom, periodTo } = input;
  if (!orgId || !assertPeriod(periodFrom, periodTo)) {
    return { ok: false, reason: "invalid_period" };
  }

  // One aggregate query rather than N per-case lookups. `units` is signed by
  // `kind` (see the UsageLedger model), so consuming minus returning is the net.
  const rows = await db.usageLedger.groupBy({
    by: ["kind"],
    where: {
      orgId,
      createdAt: { gte: periodFrom, lt: periodTo },
      kind: { in: [...CONSUMING_KINDS, ...RETURNING_KINDS] },
    },
    _sum: { units: true },
  });

  let consumed = 0;
  let returned = 0;
  for (const r of rows) {
    const n = r._sum.units ?? 0;
    if ((CONSUMING_KINDS as readonly string[]).includes(r.kind)) consumed += n;
    if ((RETURNING_KINDS as readonly string[]).includes(r.kind)) returned += n;
  }
  // Clamp at zero. A refund larger than the consume would otherwise produce a
  // negative billable figure, and a negative invoice is a credit note wearing a
  // bill's clothes.
  const netUsedUnits = Math.max(0, consumed - Math.abs(returned));

  const includedUnits = includedUnitsPerPeriod();
  const billableOverageUnits = Math.max(0, netUsedUnits - includedUnits);
  const rate = configuredRateMinorPerUnit();
  const currency = billingCurrency();

  return {
    ok: true,
    summary: {
      orgId,
      periodFrom,
      periodTo,
      netUsedUnits,
      includedUnits,
      billableOverageUnits,
      amountMinor: rate === null ? 0 : Math.round(billableOverageUnits * rate),
      currency,
      rateConfigured: rate !== null,
    },
  };
}

/**
 * The deterministic identity of an overage invoice. Same org + same window must
 * always produce the same reference, because `PaymentRecord.reference` is unique
 * and that uniqueness is what stops a re-run from billing a bank twice for one
 * period.
 */
export function overageInvoiceReference(input: {
  orgId: string;
  periodFrom: Date;
  periodTo: Date;
}): string {
  const d = (x: Date) => x.toISOString().slice(0, 10);
  return `OVG-${input.orgId}-${d(input.periodFrom)}_${d(input.periodTo)}`;
}

export type RaiseOverageResult =
  | { ok: true; reference: string; paymentId: string; duplicate: boolean; amount: Money }
  | {
      ok: false;
      reason: "invalid_period" | "rate_not_configured" | "nothing_to_bill" | "invalid_actor";
      detail?: string;
    };

/**
 * Raises (or re-raises) the overage invoice for a closed period.
 *
 * Idempotent on the deterministic reference, so running it twice — a retried
 * job, an operator clicking again — produces one row, not two bills.
 */
export async function raiseOverageInvoice(input: {
  orgId: string;
  periodFrom: Date;
  periodTo: Date;
  recordedBy: string;
  note?: string;
}): Promise<RaiseOverageResult> {
  const actor = typeof input.recordedBy === "string" ? input.recordedBy.trim().slice(0, 64) : "";
  if (!actor) return { ok: false, reason: "invalid_actor" };

  const summarised = await summariseOverage(input);
  if (!summarised.ok) return { ok: false, reason: "invalid_period" };
  const s = summarised.summary;

  if (!s.rateConfigured) {
    // Deliberately BEFORE the "nothing to bill" check: an operator with no rate
    // configured needs to be told the rate is missing, not told there is
    // nothing owed when in fact nothing could be priced.
    return {
      ok: false,
      reason: "rate_not_configured",
      detail: "set OVERAGE_RATE_MINOR_PER_UNIT before raising an overage invoice",
    };
  }
  if (s.billableOverageUnits === 0 || s.amountMinor === 0) {
    return { ok: false, reason: "nothing_to_bill" };
  }

  const money = assertMoney({ amountMinor: s.amountMinor, currency: s.currency });
  const reference = overageInvoiceReference(input);
  const paymentId = `ovg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

  // ON CONFLICT DO NOTHING + RETURNING is the whole idempotency story: the
  // unique index on "reference" turns a duplicate raise into a no-op detectable
  // from RETURNING's emptiness. Same pattern as manual-invoice.recordPayment.
  const inserted = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "PaymentRecord"
      ("id", "orgId", "provider", "reference", "amountMinor", "currency", "status",
       "entitlementsJson", "createdAt")
    VALUES (${paymentId}, ${input.orgId}, 'manualinvoice', ${reference},
            ${money.amountMinor}, ${money.currency}, 'pending',
            ${JSON.stringify({
              version: 1,
              // An overage is a CHARGE, not a credit: it grants no entitlement.
              // Settling it must not add units to the wallet, and empty
              // entitlements is what stops settlePayment crediting anything.
              entitlements: [],
              recordedBy: actor,
              purpose: "overage",
              note: input.note ?? "",
            })},
            ${new Date()})
    ON CONFLICT ("reference") DO NOTHING
    RETURNING "id"
  `;
  const duplicate = inserted.length === 0;

  await auditAppend(
    {
      callRef: `PAY-${reference}`,
      action: "consent",
      intent: duplicate ? "overage_invoice_duplicate" : "overage_invoice_raised",
      callerId: actor,
      redactedText: `${money.amountMinor} ${money.currency} for ${s.billableOverageUnits} unit(s)`,
      orgId: input.orgId,
      meta: {
        reference,
        amountMinor: money.amountMinor,
        currency: money.currency,
        netUsedUnits: s.netUsedUnits,
        includedUnits: s.includedUnits,
        billableOverageUnits: s.billableOverageUnits,
        duplicate,
      },
    },
    { fast: true },
  ).catch((err: unknown) => {
    // Fire-and-forget, as everywhere else money moves: a failing audit write
    // must not block the invoice, but it must be visible in the logs.
    logError("[overage] invoice audit append failed", { error: err instanceof Error ? err.message : String(err) });
  });

  if (!duplicate) {
    return { ok: true, reference, paymentId: inserted[0]!.id, duplicate: false, amount: money };
  }
  const existing = await db.paymentRecord.findUnique({
    where: { reference },
    select: { id: true },
  });
  return {
    ok: true,
    reference,
    paymentId: existing?.id ?? "",
    duplicate: true,
    amount: money,
  };
}
