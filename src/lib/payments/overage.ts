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
 * ## The rate: a configured rate wins, an unset rate uses the published default
 *
 * `OVERAGE_RATE_MINOR_PER_UNIT` (integer minor units — fils/cents, never a
 * decimal) is the operator's knob. Two distinct states, deliberately separated:
 *
 *   · **unset / empty** → the PUBLISHED default (`DEFAULT_OVERAGE_RATE_MINOR_PER_UNIT`,
 *     15 minor units = $0.15) applies. The rate is a commercial commitment we
 *     have already made on the pricing page, so a missing env var must not stop
 *     a legitimate invoice — it bills at the published price.
 *   · **set but not a positive integer** → REFUSE with `rate_not_configured`.
 *     A typo'd rate (`"0.15"` in an integer field, `"abc"`, `"0"`, `"-5"`) is
 *     the dangerous case: silently defaulting would hide a misconfiguration, and
 *     silently billing a fractional rate would corrupt the integer arithmetic.
 *     Refusing is visible immediately and costs one env var to fix.
 *
 * $0.15/unit against the ~$0.05 blended Twilio + ElevenLabs + model cost of one
 * intervention is a 66% gross margin on overage — see docs/UNIT-ECONOMICS.md.
 *
 * ## Why the included allowance is per-plan, not one global number
 *
 * "Their monthly limit" is a property of the plan the bank bought, not of the
 * deployment: Starter includes 500 interventions, Growth 2,500, Enterprise
 * 10,000. The allowance is therefore resolved from the org's active Paddle
 * subscription (`PaddleSubscription.priceId` → the `PADDLE_PRICES` key → plan),
 * and `INCLUDED_UNITS_PER_PERIOD` is only the fallback for an org with no
 * subscription row (a demo org, or a period before billing was wired).
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
import { resolvePaymentProvider } from "@/lib/payments/gateway";
import { logError } from "@/lib/validation/safe-log";

/** Usage kinds that count TOWARDS a billable total. */
const CONSUMING_KINDS = ["consume"] as const;
/** Usage kinds that give units back. */
const RETURNING_KINDS = ["release", "refund"] as const;

/**
 * The published overage rate, in integer minor units (fils/cents) per
 * intervention. $0.15 = 15 minor units. Applied when
 * `OVERAGE_RATE_MINOR_PER_UNIT` is unset or empty; a malformed value REFUSES
 * instead of silently defaulting (see the header).
 */
export const DEFAULT_OVERAGE_RATE_MINOR_PER_UNIT = 15;

/**
 * Included interventions per commitment period, by pricing plan.
 *
 * Keys are the plan ids in `src/views/Pricing.tsx`; the numbers must match the
 * `included` field there, because that is the figure the customer read on the
 * pricing page before buying.
 */
export const PLAN_INCLUDED_UNITS: Readonly<Record<string, number>> = Object.freeze({
  starter: 500,
  growth: 2500,
  enterprise: 10000,
});

/** The `PADDLE_PRICES` key prefix (`usd_<cents>`) → plan id. */
const PRICE_KEY_TO_PLAN: Readonly<Record<string, string>> = Object.freeze({
  usd_9900: "starter",
  usd_49900: "growth",
  usd_200000: "enterprise",
});

type RateResolution =
  { ok: true; rateMinorPerUnit: number; configured: boolean } | { ok: false; detail: string };

/**
 * Resolves the effective per-unit rate.
 *
 * Unset → the published default (`configured: false`, so a console can label it
 * "default rate"). Set-but-invalid → refusal, never a silent fallback.
 */
function resolveRateMinorPerUnit(): RateResolution {
  const raw = process.env.OVERAGE_RATE_MINOR_PER_UNIT;
  if (raw === undefined || raw.trim() === "") {
    return {
      ok: true,
      rateMinorPerUnit: DEFAULT_OVERAGE_RATE_MINOR_PER_UNIT,
      configured: false,
    };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return {
      ok: false,
      detail: `OVERAGE_RATE_MINOR_PER_UNIT must be a positive integer number of minor units (got ${JSON.stringify(raw)}); leave it unset to use the default of ${DEFAULT_OVERAGE_RATE_MINOR_PER_UNIT}`,
    };
  }
  return { ok: true, rateMinorPerUnit: n, configured: true };
}

function billingCurrency(): string {
  return (process.env.BILLING_CURRENCY ?? "AED").toUpperCase();
}

/** `INCLUDED_UNITS_PER_PERIOD` — the fallback allowance for an org with no plan. */
function includedUnitsFromEnv(): number {
  const raw = process.env.INCLUDED_UNITS_PER_PERIOD;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Maps a Paddle price id to a plan id, using the same `PADDLE_PRICES` map the
 * checkout uses. Returns null when the id is unknown (a price created in the
 * dashboard but not wired here), which falls through to the env allowance.
 */
export function planFromPriceKey(priceKey: string | null | undefined): string | null {
  if (!priceKey) return null;
  const cents = priceKey.split("_").slice(0, 2).join("_");
  return PRICE_KEY_TO_PLAN[cents] ?? null;
}

export function planFromPriceId(priceId: string | null | undefined): string | null {
  if (!priceId) return null;
  let prices: Record<string, string>;
  try {
    prices = JSON.parse(process.env.PADDLE_PRICES ?? "{}") as Record<string, string>;
  } catch {
    return null;
  }
  for (const [key, id] of Object.entries(prices)) {
    if (id !== priceId) continue;
    return planFromPriceKey(key);
  }
  return null;
}

/**
 * Intervention credits a settled payment buys.
 *
 * Forward direction of `summarise()`: a Starter payment buys its plan's
 * monthly allowance (500), Growth 2500, Enterprise 10000. Unknown plans and
 * orgs with no resolvable plan fall back to `INCLUDED_UNITS_PER_PERIOD`.
 *
 * Money never converts 1:1 into credits — minor currency units and
 * intervention credits are different denominations, and equating them is the
 * #204 bug (a $99 payment booking 9900 "units"). Units are decided at MINT
 * time (checkout / invoice raise) and carried on the payment, never
 * re-derived at webhook time: a first purchase has no subscription row yet,
 * and deriving from live state would credit the wrong allowance after a plan
 * change.
 */
export function unitsForPlan(plan: string | null | undefined): number {
  if (plan && PLAN_INCLUDED_UNITS[plan] !== undefined) return PLAN_INCLUDED_UNITS[plan]!;
  return includedUnitsFromEnv();
}

/**
 * Intervention credits for a payment minted WITHOUT a subscription context —
 * a manual bank-transfer record, a top-up checkout, a payment made before any
 * plan row exists.
 *
 * Units are still decided at mint time, from the amount and (if it names one)
 * the purpose. `purpose` is compared case-insensitively against plan names:
 * a record entered as `purpose: "Starter"` buys the Starter allowance, not
 * `amountMinor` credits. An unknown or absent purpose falls back to
 * `INCLUDED_UNITS_PER_PERIOD` — money never converts 1:1 into credits (#204).
 */
export function unitsForMintedPayment(input: {
  amountMinor: number;
  currency: string;
  purpose?: string;
}): number {
  const purpose = input.purpose?.trim().toLowerCase() ?? "";
  if (purpose !== "") {
    for (const plan of Object.keys(PLAN_INCLUDED_UNITS)) {
      if (purpose === plan) return PLAN_INCLUDED_UNITS[plan]!;
    }
  }
  return includedUnitsFromEnv();
}

/**
 * The included allowance for an org in a period: the plan it is paying for, else
 * the deployment default. Never throws — a billing lookup failure must not take
 * the rater down; it falls back to the env allowance and logs.
 */
async function includedUnitsForOrg(orgId: string): Promise<number> {
  try {
    const sub = await db.paddleSubscription.findFirst({
      where: { orgId, status: { in: ["active", "trialing"] } },
      orderBy: { updatedAt: "desc" },
      select: { priceId: true },
    });
    const plan = planFromPriceId(sub?.priceId);
    if (plan && PLAN_INCLUDED_UNITS[plan] !== undefined) return PLAN_INCLUDED_UNITS[plan]!;
  } catch (err) {
    logError("[overage] plan allowance lookup failed; using env allowance", {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return includedUnitsFromEnv();
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
   * True when the operator set the rate explicitly. False means the published
   * default is in effect — not that nothing is billable.
   */
  rateConfigured: boolean;
};

export type SummariseResult =
  | { ok: true; summary: OverageSummary }
  | { ok: false; reason: "invalid_period" | "rate_invalid"; detail?: string };

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

  const rate = resolveRateMinorPerUnit();
  if (!rate.ok) return { ok: false, reason: "rate_invalid", detail: rate.detail };

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

  const includedUnits = await includedUnitsForOrg(orgId);
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
      reason: "invalid_period" | "rate_not_configured" | "nothing_to_bill" | "invalid_actor";
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
    // operator set something, and only they can fix it. An unset rate no longer
    // lands here — it bills at the published default.
    if (summarised.reason === "rate_invalid") {
      return { ok: false, reason: "rate_not_configured", detail: summarised.detail };
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
        rateMinorPerUnit: s.rateMinorPerUnit,
        rateConfigured: s.rateConfigured,
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
    logError("[overage] invoice audit append failed", {
      error: err instanceof Error ? err.message : String(err),
    });
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
