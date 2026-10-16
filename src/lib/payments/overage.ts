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
 * ## The rate: one override knob, otherwise the plan's OWN published rate
 *
 * `OVERAGE_RATE_MINOR_PER_UNIT` (integer minor units — fils/cents, never a
 * decimal) is the operator's knob and beats every plan when set. Three states,
 * deliberately separated (implementation in `plans.ts`'s `resolveOverageRate()`):
 *
 *   · **set but not a positive integer** → REFUSE with `rate_not_configured`.
 *     A typo'd rate (`"0.15"` in an integer field, `"abc"`, `"0"`, `"-5"`) is
 *     the dangerous case: silently defaulting would hide a misconfiguration, and
 *     silently billing a fractional rate would corrupt the integer arithmetic.
 *     Refusing is visible immediately and costs one env var to fix.
 *   · **unset, plan known** → the plan's `commercial.ts` `overageCents`. Starter
 *     bills at 15¢ and Growth at 12¢ because that is what `/pricing` says to
 *     each buyer. This used to be one global 15¢ for every plan, which made the
 *     page's Growth figure a promise the rater did not keep.
 *   · **unset, Enterprise** → REFUSE with `rate_not_negotiated`. Enterprise
 *     publishes `overageCents: null` — its volume beyond the bundle is a
 *     negotiated contract. Rating a negotiated deal at the Starter default would
 *     put an invented number on a bank's invoice, and a missing invoice is
 *     recoverable while a wrong one is a dispute.
 *   · **unset, no plan resolvable** → the published default
 *     (`DEFAULT_OVERAGE_RATE_MINOR_PER_UNIT`, 15) so a demo org or a period
 *     before billing was mirrored still produces an invoice.
 *
 * ## What this file deliberately does NOT claim
 *
 * This comment used to read "$0.15/unit against the ~$0.05 blended Twilio +
 * ElevenLabs + model cost of one intervention is a 66% gross margin on overage —
 * see docs/UNIT-ECONOMICS.md". The cited document says the opposite of that: it
 * models a 3-minute intervention at **≈$0.55**, from
 * `cost_per_call = 3 × (carrier_rate + 0.08) + 0.002` with ElevenLabs Agents at
 * $0.08/min (docs/UNIT-ECONOMICS.md:105-116). So 15¢ and 12¢ are both BELOW the
 * modelled cost per unit, and there is no margin figure this file may state.
 *
 * A defensible margin needs two numbers nobody has recorded yet: the measured mean
 * handle time per plan (`Case.durationSeconds` is written by
 * `src/lib/elevenlabs/inbound.ts:270,314` but aggregated nowhere) and the
 * destination carrier rate, which the capacity model also refuses to guess
 * ("EXCLUDED — INPUT REQUIRED", `src/lib/scale/capacity.ts:484-491`). Until both
 * exist the rate stands on what it actually is — a commercial commitment published
 * on `/pricing` and mirrored into `scripts/seed-paddle-catalog.ts` — not on a cost
 * claim, because a comment is not a measurement and this one was cited as if it
 * were.
 *
 * ## Why the plan, the allowance, and the rate all come from one read
 *
 * "Their monthly limit" is a property of the plan the bank bought, not of the
 * deployment. The plan is resolved by `src/lib/billing/plan-context.ts` — the
 * mirrored `PaddleSubscription` status, then `Organization.planTier`, then the
 * deployment default — and the allowance and rate are read off `PLANS[]` for
 * that one answer. There used to be a second subscription query here with a
 * narrower status filter, which is how a rater and a screen start disagreeing
 * about what a tenant bought.
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
import { auditMoney } from "@/lib/payments/audit";
import { assertMoney, type Money } from "@/lib/payments/provider";
import { resolvePaymentProvider } from "@/lib/payments/gateway";
import { logError } from "@/lib/validation/safe-log";
import { orgPlanContext } from "@/lib/billing/plan-context";
import { resolveOverageRate } from "./plans";

/** Usage kinds that count TOWARDS a billable total. */
const CONSUMING_KINDS = ["consume"] as const;
/** Usage kinds that give units back. */
const RETURNING_KINDS = ["release", "refund"] as const;

/**
 * Plan facts — the included volumes, the price-id mapping, the units a payment
 * buys, and the published default rate — now live in `./plans.ts`, which DERIVES
 * them from `PLANS[]` in `src/lib/commercial.ts` instead of restating them.
 *
 * They are re-exported here because this module was their original home and
 * `payments/provider.ts`, `payments/paddle.ts`, `payments/paddle-events.ts` and
 * `tests/billing/spend-wallet.test.ts` import them from it. A re-export is a
 * compatibility seam; a second definition is the drift that made the pricing
 * page and the rater able to disagree about what a bank bought.
 */
export {
  DEFAULT_OVERAGE_RATE_MINOR_PER_UNIT,
  PLAN_INCLUDED_UNITS,
  includedUnitsFromEnv,
  planFromPriceId,
  planFromPriceKey,
  unitsForMintedPayment,
  unitsForPlan,
} from "./plans";

function billingCurrency(): string {
  return (process.env.BILLING_CURRENCY ?? "AED").toUpperCase();
}

/**
 * What this org is on, and what that plan includes.
 *
 * Resolved through `billing/plan-context.ts` — the same read the console's
 * usage bar uses — rather than a second subscription query here with its own
 * status filter. Two readers of one fact is how a bill and a screen start
 * disagreeing about the allowance.
 *
 * Never throws for a reason that matters: `orgPlanContext` swallows its own DB
 * failure and reports the demo plan, and a billing read must not take the
 * rater down.
 */
async function planForOrg(orgId: string): Promise<{ plan: string | null; includedUnits: number }> {
  const ctx = await orgPlanContext(orgId);
  return { plan: ctx.plan, includedUnits: ctx.allowanceUnits };
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
  /** The rate actually applied, in minor units. Reproduces `amountMinor`. */
  rateMinorPerUnit: number;
  /**
   * True when the operator set the rate explicitly. False means the PLAN's
   * published rate is in effect — not that nothing is billable.
   */
  rateConfigured: boolean;
  /** The plan this was rated against, or null when nothing resolved one. */
  plan: string | null;
};

export type SummariseResult =
  | { ok: true; summary: OverageSummary }
  | {
      ok: false;
      reason: "invalid_period" | "rate_invalid" | "rate_not_negotiated";
      detail?: string;
    };

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
 * Net units consumed by one organisation in one window, from the ledger.
 *
 * Extracted from `summariseOverage` so the console's usage bar and the invoice
 * rater run the SAME arithmetic. The alternative — a second query for the
 * display — is how a screen tells a customer they used 2,480 interventions while
 * the invoice that arrives says 2,510.
 *
 * Clamped at zero. A refund larger than the consume would otherwise produce a
 * negative figure, and a negative usage number on an invoice is a credit note
 * wearing a bill's clothes.
 */
export async function netUsageUnits(
  orgId: string,
  periodFrom: Date,
  periodTo: Date,
): Promise<number> {
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
  return Math.max(0, consumed - Math.abs(returned));
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

  const { plan, includedUnits } = await planForOrg(orgId);
  // The rate is resolved from the PLAN, so a Growth tenant is rated at Growth's
  // published 12¢ and not at one global figure the pricing page contradicts.
  const rate = resolveOverageRate(plan);
  if (!rate.ok) return { ok: false, reason: rate.reason, detail: rate.detail };

  const netUsedUnits = await netUsageUnits(orgId, periodFrom, periodTo);

  const billableOverageUnits = Math.max(0, netUsedUnits - includedUnits);
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
      amountMinor: Math.round(billableOverageUnits * rate.rateMinorPerUnit),
      currency,
      rateMinorPerUnit: rate.rateMinorPerUnit,
      rateConfigured: rate.configured,
      plan,
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
  | {
      ok: true;
      reference: string;
      paymentId: string;
      duplicate: boolean;
      amount: Money;
      /** Present only when the raise was pushed to the gateway. */
      invoice?: { invoiceId: string; paymentLink?: string };
    }
  | {
      ok: false;
      reason:
        | "invalid_period"
        | "rate_not_configured"
        | "rate_not_negotiated"
        | "nothing_to_bill"
        | "invalid_actor";
      detail?: string;
    };

export type OverageInvoicePushResult =
  | { ok: true; reference: string; invoiceId: string; paymentLink?: string }
  | { ok: false; reason: string; detail?: string };

/**
 * Raises the overage invoice AT THE GATEWAY — a manual-collection document the
 * bank settles on terms, not an automatic card charge.
 *
 * ## Why manual collection, and why an auto-charge cannot work
 *
 * Paddle is a Merchant of Record: it holds no stored card authorization for a
 * later charge, so `chargeStoredAuthorization` refuses by design (see
 * paddle.ts). A "create a transaction and auto-collect it" call for a bank
 * overage therefore cannot be implemented against Paddle, and pretending
 * otherwise would produce an invoice that silently never collects.
 *
 * What a bank overage actually is: a B2B receivable with a VAT number, a PO and
 * bank-transfer settlement. That is Paddle's `collection_mode: "manual"`, which
 * the port exposes as `createInvoice` (due date, no units credited at issue).
 * The rate is ours, not a catalog lookup, so it is sent as custom pricing with
 * the per-unit amount as the line price and the billable units as the quantity.
 *
 * Refuses rather than silently no-op'ing when no gateway is bound — the same
 * posture `resolvePaymentProvider` takes, because a billing path that quietly
 * does nothing on misconfiguration fails on the day a customer owes money.
 */
export async function pushOverageInvoiceToGateway(input: {
  orgId: string;
  periodFrom: Date;
  periodTo: Date;
  recordedBy: string;
  /** Days until due. A bank overage is normally Net-30. */
  dueInDays?: number;
}): Promise<OverageInvoicePushResult> {
  const gateway = resolvePaymentProvider();
  if (!gateway.ok) return { ok: false, reason: gateway.reason };
  // Invoicing is optional on the port: a provider that cannot express a
  // manual-collection document must REFUSE, not silently skip the billing.
  const createInvoice = gateway.provider.createInvoice?.bind(gateway.provider);
  if (!createInvoice) {
    return {
      ok: false,
      reason: `gateway "${gateway.name}" does not support invoicing`,
    };
  }

  const summarised = await summariseOverage(input);
  if (!summarised.ok) {
    return { ok: false, reason: summarised.reason, detail: summarised.detail };
  }
  const s = summarised.summary;
  if (s.billableOverageUnits === 0 || s.amountMinor === 0) {
    return { ok: false, reason: "nothing_to_bill" };
  }

  const reference = overageInvoiceReference(input);
  const result = await createInvoice({
    orgId: input.orgId,
    reference,
    currency: s.currency,
    dueInDays: input.dueInDays ?? 30,
    // The rate is a commercial decision, not a catalog lookup — send the amount.
    customPricing: true,
    recordedBy: input.recordedBy,
    items: [
      {
        description: `Overage: ${s.billableOverageUnits} intervention(s) beyond the ${s.includedUnits}-unit plan allowance`,
        amountMinor: s.rateMinorPerUnit,
        quantity: s.billableOverageUnits,
      },
    ],
  });

  if (!result.ok) {
    logError("[overage] gateway invoice refused", {
      orgId: input.orgId,
      reference,
      gateway: gateway.name,
      reason: result.reason,
    });
    return { ok: false, reason: result.reason };
  }

  return {
    ok: true,
    reference,
    invoiceId: result.invoiceId,
    ...(result.paymentLink ? { paymentLink: result.paymentLink } : {}),
  };
}

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
  if (!summarised.ok) {
    // A malformed rate is the one refusal that must name its variable: the
    // operator set something, and only they can fix it.
    if (summarised.reason === "rate_invalid") {
      return { ok: false, reason: "rate_not_configured", detail: summarised.detail };
    }
    // A negotiated plan has no posted rate. This is NOT the same refusal — the
    // operator did nothing wrong, and "go set the env var" would invite them to
    // bill a contracted customer at a price neither party agreed.
    if (summarised.reason === "rate_not_negotiated") {
      return { ok: false, reason: "rate_not_negotiated", detail: summarised.detail };
    }
    return { ok: false, reason: "invalid_period" };
  }
  const s = summarised.summary;

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
              // Reproducibility: the rate that produced the amount, so a
              // disputed invoice can be re-derived from (units, rate) alone
              // even after the env var changes.
              rateMinorPerUnit: s.rateMinorPerUnit,
              rateConfigured: s.rateConfigured,
              // Which plan the rate came from, so a disputed invoice can be
              // re-derived even after the tenant changes plan or the catalog is
              // re-priced.
              plan: s.plan,
              includedUnits: s.includedUnits,
              netUsedUnits: s.netUsedUnits,
              billableOverageUnits: s.billableOverageUnits,
              note: input.note ?? "",
            })},
            ${new Date()})
    ON CONFLICT ("reference") DO NOTHING
    RETURNING "id"
  `;
  const duplicate = inserted.length === 0;

  // Through the money path's shared writer: it owns the `PAY-<reference>`
  // ceiling (an overage reference is long enough to be truncated by the chain's
  // own 64-character cap) and it retries before it gives up.
  await auditMoney({
    reference,
    orgId: input.orgId,
    actor,
    intent: duplicate ? "overage_invoice_duplicate" : "overage_invoice_raised",
    detail: `${money.amountMinor} ${money.currency} for ${s.billableOverageUnits} unit(s)`,
    meta: {
      reference,
      amountMinor: money.amountMinor,
      currency: money.currency,
      rateMinorPerUnit: s.rateMinorPerUnit,
      rateConfigured: s.rateConfigured,
      netUsedUnits: s.netUsedUnits,
      includedUnits: s.includedUnits,
      billableOverageUnits: s.billableOverageUnits,
      duplicate,
    },
  });

  if (!duplicate) {
    // Billing reached third-party analytics exactly once: this branch only runs
    // for a genuinely new invoice, never for a retried or duplicate raise, so
    // the `usage_summarised` event is idempotent by construction — the same
    // property the PaymentRecord insert above guarantees for the money.
    try {
      const { usageSummarised } = await import("@/lib/analytics");
      usageSummarised({
        orgId: input.orgId,
        netUsedUnits: s.netUsedUnits,
        includedUnits: s.includedUnits,
        billableOverageUnits: s.billableOverageUnits,
      });
    } catch {
      // Analytics observes; it does not gate. See `src/lib/analytics.ts`.
    }
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
