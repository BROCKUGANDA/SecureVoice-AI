/**
 * AN AUDIT OUTAGE CANNOT SILENTLY DELETE A PAYMENT RECORD.
 *
 * `settlePayment` now answers `auditRecorded`. This file proves the half of that
 * signal that keeps it from being decorative: when the chain cannot be written,
 * the money still commits (an evidence outage must not roll back a customer's
 * payment) AND the delivery is answered with a 500 rather than a 200.
 *
 * Why the 500 is the whole design:
 *
 *   · a 2xx tells Paddle the delivery succeeded, so it never comes back, and the
 *     evidence of a real charge is gone permanently;
 *   · a 5xx keeps the retry alive, and the retry is free — the duplicate guard
 *     refuses a second credit, and `tests/billing/money-audit-repair.test.ts`
 *     proves the redelivery then writes the record the failed attempt could not.
 *
 * The outage is modelled by replacing `audit-chain`'s `append()` with one that
 * always rejects — the same seam shape `tests/e2e/elevenlabs-tool-routes.test.ts`
 * uses for "audit chain unavailable". Everything else is real: the database, the
 * signature verifier, `settlePayment`, the route. The recovery case is NOT here
 * because a permanently rejecting seam cannot show it; that half runs against the
 * real writer in the file named for it.
 *
 *   bun scripts/run-tests.mjs money-audit-loss
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

mock.module("@/lib/audit-chain", () => ({
  append: async () => {
    throw new Error("audit chain unavailable (modelled outage)");
  },
  verifyChain: async () => {
    throw new Error("audit chain unavailable (modelled outage)");
  },
  auditAppendFailures: () => 0,
}));

// Imported after the seam is installed, so the money path binds to it.
const { db } = await import("@/lib/db");
const { settlePayment } = await import("@/lib/payments/provider");
const { buildReference } = await import("@/lib/payments/paddle");
const { POST } = await import("@/app/api/billing/webhook/route");

const SECRET = "pdl_notif_money_audit_loss_secret";
// A `pdl_sdbx_` key selects the sandbox base URL. Verification is local crypto;
// no request leaves this process and no live credential is involved.
process.env.PADDLE_API_KEY = "pdl_sdbx_money_audit_loss_key";
process.env.PADDLE_WEBHOOK_SECRET = SECRET;

const RUN = Date.now().toString(36);
const HEX = (Date.now().toString(16) + "0".repeat(12)).slice(0, 12);
const ORG = `44444444-4444-4444-8444-${HEX}`;

const REFERENCE = buildReference(ORG, "topup");
const SEAM_REF = `PAYSEAM_${RUN}`;

function transactionBody(eventId: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    event_id: eventId,
    event_type: "transaction.completed",
    occurred_at: new Date().toISOString(),
    data,
  });
}

function signed(body: string): NextRequest {
  const ts = Math.floor(Date.now() / 1000).toString();
  const h1 = createHmac("sha256", SECRET).update(`${ts}:`).update(body).digest("hex");
  return new NextRequest("http://localhost/api/billing/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Paddle-Signature": `ts=${ts};h1=${h1}` },
    body,
  });
}

function completed(eventId: string): NextRequest {
  return signed(
    transactionBody(eventId, {
      id: `txn_loss_${RUN}`,
      customer_id: `ctm_loss_${RUN}`,
      custom_data: { reference: REFERENCE, entitlements: [{ key: "manual_units", units: 250 }] },
      items: [{ unit_price: { amount: "7500", currency_code: "USD" } }],
    }),
  );
}

beforeAll(async () => {
  await db.organization.create({
    data: {
      id: ORG,
      name: `loss-${RUN}`,
      slug: `loss-${RUN}`,
      createdAt: new Date(),
      credits: 0,
    },
  });
}, 60_000);

afterAll(async () => {
  await db.paymentRecord.deleteMany({ where: { reference: { in: [REFERENCE, SEAM_REF] } } });
  await db.auditLog.deleteMany({ where: { callRef: { startsWith: "PAY-" }, orgId: ORG } });
  await db.usageLedger.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}, 60_000);

describe("settlement during an audit outage", () => {
  test("the money commits, the evidence does not, and the result says so", async () => {
    const result = await settlePayment({
      provider: "paddle",
      orgId: ORG,
      reference: SEAM_REF,
      money: { amountMinor: 5_000, currency: "USD" },
      status: "success",
      eventId: `evt_seam_${RUN}`,
      entitlements: [{ key: "manual_units", units: 10 }],
      verifiedBy: "gateway",
    });

    expect(result.applied).toBe(true);
    // The signal the route branches on. `false` means "money moved that we cannot
    // yet prove" — the one state in this file that must not be silent.
    expect(result.auditRecorded).toBe(false);

    const row = await db.paymentRecord.findUnique({ where: { reference: SEAM_REF } });
    expect(row?.status).toBe("success");
    const chainRows = await db.auditLog.count({ where: { callRef: `PAY-${SEAM_REF}` } });
    expect(chainRows).toBe(0);
  }, 60_000);

  test("a completed payment that cannot be chained is answered 500, not 200", async () => {
    // Read the balance rather than assert a fixed one: the case above settled
    // into this same org, and an absolute figure here would make the two tests
    // order-dependent — a fixture coupling that reads like a product bug.
    const creditsBefore = (
      await db.organization.findUniqueOrThrow({ where: { id: ORG }, select: { credits: true } })
    ).credits;

    const res = await POST(completed(`evt_loss_first_${RUN}`));

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("audit_record_incomplete");

    // The credit is real — that is exactly why the answer is retryable rather
    // than terminal. Refusing to acknowledge it is the only way to get another
    // chance to record it.
    const paid = await db.paymentRecord.findUnique({ where: { reference: REFERENCE } });
    expect(paid?.status).toBe("success");
    const creditsAfter = (
      await db.organization.findUniqueOrThrow({ where: { id: ORG }, select: { credits: true } })
    ).credits;
    expect(creditsAfter - creditsBefore).toBe(250);
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(0);
  }, 120_000);

  test("an unattributable delivery is still answered 200 and chains nothing", async () => {
    // The boundary the route documents, checked while the chain is DOWN so it
    // cannot be confused with the 500 above: money that is not ours never
    // depends on the audit writer, and never grows the log from outside.
    const res = await POST(
      signed(
        transactionBody(`evt_native_${RUN}`, {
          id: `txn_native_${RUN}`,
          customer_id: "ctm_someone_else",
          items: [{ unit_price: { amount: "1000", currency_code: "USD" } }],
        }),
      ),
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).credited).toBe(false);
  }, 60_000);
});
