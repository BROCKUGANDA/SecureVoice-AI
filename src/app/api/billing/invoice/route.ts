import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOrgWithCapability } from "@/lib/route-helpers";
import { moneyTwoFactorBlocker, twoFactorDenialBody } from "@/lib/auth/two-factor-gate";
import { resolvePaymentProvider } from "@/lib/payments/gateway";
import { consume as consumeRateLimit, rateLimitHeaders, rateLimitId } from "@/lib/ratelimit";
import { logInfo, logWarn } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * POST /api/billing/invoice — raise a manual invoice for negotiated terms.
 *
 * The enterprise counterpart to `/api/billing/checkout`. Checkout collects a
 * card immediately against a catalogued price; this raises a document for a
 * bank that needs a VAT/GST number, a PO, a bank transfer, or a price negotiated
 * per customer.
 *
 * ## Authorisation: `billing:write`, which only an Owner holds
 *
 * Raising an invoice commits the organisation to paying money on a schedule,
 * without the customer approving it at the moment it is raised. That is why the
 * capability is Owner-only rather than sitting with Admin: an Admin manages
 * analysts, not the bank's money.
 *
 * It deliberately does NOT require a step-up. That is a judgement call worth
 * stating, because `commit_freeze` sits in PRIVILEGED_ACTIONS and invoicing looks
 * superficially like freezing. The difference is reversibility: a freeze is
 * immediate, visible and reversible; an invoice is a document the customer
 * receives and can dispute through their own accounts payable, which is a much
 * slower and more public correction. The spec's privileged-action list is a
 * closed set pinned by tests/auth/stepup.test.ts, and adding a sixth entry is a
 * product decision rather than an implementation detail — so the route gates on
 * the Owner capability instead, and this comment records why.
 *
 * ## What it deliberately does NOT do
 *
 * It credits NOTHING. `InvoiceResult.settledUnits` is typed as the literal `0`,
 * so an unpaid invoice cannot grant prepaid units — that would be an unbounded
 * credit line extended on our own say-so. Units arrive via the normal settle
 * path, on `transaction.paid` or on dual-control operator confirmation of a
 * bank transfer.
 *
 * ## The amount is operator-chosen, and that is the point
 *
 * `items[].amountMinor` is a negotiated figure, not a catalog lookup, so this
 * route cannot validate it against a price list — there is none. What it CAN do
 * is refuse the shapes that are never legitimate: zero, negative, non-integer,
 * or absurdly large. Every integer check happens here AND again in the adapter,
 * because this is the boundary where money enters the system.
 */

const INVOICE_LIMIT = Number(process.env.BILLING_INVOICE_LIMIT) || 20;

const Body = z.object({
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(240),
        amountMinor: z.number().int().positive().max(100_000_000),
        quantity: z.number().int().positive().max(10_000).optional(),
      }),
    )
    .min(1)
    .max(50),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  dueInDays: z.number().int().min(0).max(365).optional(),
  /** Buyer's VAT/GST number. Drives reverse-charge treatment at the gateway. */
  taxId: z.string().trim().min(3).max(64).optional(),
  customerEmail: z.string().email().max(254).optional(),
  customerName: z.string().trim().max(160).optional(),
  /**
   * The buyer's registered billing details, transcribed from the contract.
   *
   * Paddle is Merchant of Record and taxes where the BUYER is, so this is the
   * bank's address, not ours: a UK procurement office on a UAE-headquartered
   * bank is a UK VAT document. Nothing here is defaulted from the deployment,
   * and a country is required whenever the block is present — a half-entered
   * address would silently change the tax on a legal document.
   *
   * `purchaseOrderNumber` is the bank's own paperwork reference; it is carried
   * verbatim so their accounts payable can match the invoice to the approval it
   * came from.
   */
  billing: z
    .object({
      country: z.string().regex(/^[A-Za-z]{2}$/),
      postalCode: z.string().trim().max(16).optional(),
      purchaseOrderNumber: z.string().trim().max(64).optional(),
    })
    .optional(),
  note: z.string().trim().max(500).optional(),
});

export async function POST(req: NextRequest) {
  // Owner-only capability. See the header for why this is not a step-up action.
  const authed = await requireOrgWithCapability(req, "billing:write");
  if (!authed.ok) {
    return NextResponse.json(
      { error: "billing_write_required" },
      { status: authed.failure.status ?? 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  // A working second factor, on top of the Owner capability. This is not the
  // step-up the header above declines to require: step-up is a five-minute
  // freshness window on a re-authentication, this is a standing property of the
  // account. An Owner whose password leaks is stopped by capability checks not at
  // all — the leaked cookie IS the Owner.
  const blocker = await moneyTwoFactorBlocker(authed.identity);
  if (blocker) {
    return NextResponse.json(twoFactorDenialBody(blocker), {
      status: blocker.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const rl = await consumeRateLimit(
    "billing-invoice",
    rateLimitId(req, authed.orgId),
    1,
    INVOICE_LIMIT,
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "malformed_json" }, { status: 400 });
  }
  const body = Body.safeParse(parsed);
  if (!body.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: body.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }

  const gateway = resolvePaymentProvider();
  if (!gateway.ok) {
    logWarn("[billing] no gateway bound", { reason: gateway.reason });
    return NextResponse.json({ error: "billing_unavailable" }, { status: 503 });
  }
  const provider = gateway.provider;

  // Feature-detected, not assumed: `createInvoice` is optional on the port so an
  // adapter that cannot express manual-collection billing is honest about it.
  if (typeof provider.createInvoice !== "function") {
    logWarn("[billing] provider cannot invoice", { provider: provider.id });
    return NextResponse.json(
      {
        error: "invoicing_not_supported",
        detail: `${provider.id} cannot raise manual-collection invoices.`,
      },
      { status: 501 },
    );
  }

  // OUR reference. Never accepted from the client: a caller-supplied reference
  // would let a retry be mistaken for a different invoice, and would let one
  // caller collide with another's document.
  const reference = `inv_${authed.orgId}_${Date.now().toString(36)}`;

  const total = body.data.items.reduce((sum, i) => sum + i.amountMinor * (i.quantity ?? 1), 0);
  logInfo("[billing] raising invoice", {
    orgId: authed.orgId,
    items: body.data.items.length,
    totalMinor: total,
    currency: body.data.currency.toUpperCase(),
  });

  const result = await provider.createInvoice({
    orgId: authed.orgId,
    reference,
    items: body.data.items,
    currency: body.data.currency.toUpperCase(),
    ...(body.data.dueInDays === undefined ? {} : { dueInDays: body.data.dueInDays }),
    ...(body.data.taxId ? { taxId: body.data.taxId } : {}),
    ...(body.data.customerEmail
      ? {
          customer: {
            email: body.data.customerEmail,
            ...(body.data.customerName ? { name: body.data.customerName } : {}),
            // Transcribed, not derived: the org's own country is irrelevant to
            // where the buyer owes VAT.
            ...(body.data.billing
              ? {
                  address: {
                    country_code: body.data.billing.country.toUpperCase(),
                    ...(body.data.billing.postalCode
                      ? { postal_code: body.data.billing.postalCode }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(body.data.billing?.purchaseOrderNumber
      ? { purchaseOrderNumber: body.data.billing.purchaseOrderNumber }
      : {}),
    // Marks the amount as negotiated rather than catalogued, so an adapter
    // refuses rather than silently matching it to a neighbouring tier.
    customPricing: true,
    recordedBy: authed.identity.accountId,
  });

  if (!result.ok) {
    logWarn("[billing] invoice refused", { orgId: authed.orgId, reason: result.reason });
    return NextResponse.json({ error: "invoice_failed", detail: result.reason }, { status: 502 });
  }

  return NextResponse.json(
    {
      ok: true,
      reference: result.reference,
      invoiceId: result.invoiceId,
      // Where the buyer settles. Absent on a manual invoice with no checkout
      // yet, so this is optional rather than asserted.
      ...(result.paymentLink ? { paymentLink: result.paymentLink } : {}),
      // Always 0 — an invoice grants no credits until it is paid.
      settledUnits: result.settledUnits,
      note: body.data.note ?? "Invoice raised. No credits are granted until payment is confirmed.",
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
