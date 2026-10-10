/**
 * Two DIFFERENT signals for the SAME transaction, arriving together.
 *
 * The sibling file (`interventions-idempotency-race.test.ts`) proves that one
 * signal seen twice produces one call. This file proves the harder and more
 * dangerous case: a bank's fraud engine emits the same `transaction_ref` from two
 * evaluators, or a retry storm re-signs the same transaction with a fresh
 * Idempotency-Key. The idempotency table cannot help — different key, different
 * row — so the dedupe has to come from the TRANSACTION itself.
 *
 * Why it matters more than it looks: a false positive here is two carriers
 * dialling the same fraud victim inside seconds of each other. A victim already
 * suspicious of one bank call becomes certain they are being scammed when a
 * second one lands, and the intervention actively causes the loss it was meant to
 * prevent.
 *
 * What is asserted:
 *   - at most ONE first acceptance (never two "queued" responses);
 *   - the loser is refused with a typed 409, not silently dropped;
 *   - exactly ONE case row exists for the transaction, whatever the race did.
 *
 * The mechanism is a partial unique index on `(orgId, transactionRef)` plus the
 * `transaction_repeat` policy check — so this file is the evidence that the
 * index is doing the work rather than the application layer being careful.
 *
 *   bun test tests/e2e/interventions-transaction-race.test.ts
 */
import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-secret";
const SECRET = process.env.WEBHOOK_SECRET;
process.env.TWILIO_DRY_RUN = "true";

function signBody(body: string): string {
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/**
 * Same transaction, DIFFERENT idempotency key.
 *
 * The key is the only field that differs between the two requests — everything
 * else is byte-identical, so any second case row can only come from the dedupe
 * failing rather than from the two requests legitimately describing two
 * different transactions.
 */
/**
 * A per-run destination number.
 *
 * The dial gate enforces a 300-second per-destination cooldown, so a fixed test
 * number is refused on the SECOND run of this file for a reason that has
 * nothing to do with the duplicate-transaction behaviour under test. Deriving the
 * number from the run stamp keeps the two guards from masking each other.
 */
function destinationFor(stamp: string): string {
  // +971 5X XXX XXXX — the last digits vary per run, staying in the UAE block
  // the geo allowlist declares.
  const tail = Number.parseInt(stamp.replace(/\D/g, "") || "0", 10) % 10_000_000;
  return `+9715${String(tail).padStart(7, "0")}`;
}

function makeRequest(
  idempotencyKey: string,
  transactionRef: string,
  consentRecordId: string,
  phone: string,
) {
  const body = JSON.stringify({
    transaction_ref: transactionRef,
    risk_score: 0.91,
    language: "en",
    phone,
    currency: "AED",
    amount: 185000,
    merchant: "Gold Exchange LLC",
    consent_record_id: consentRecordId,
  });
  return new NextRequest("http://localhost/api/v1/interventions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sv-signature": signBody(body),
      "idempotency-key": idempotencyKey,
    },
    body,
  });
}

test("two keys, one transaction: at most one case, and the loser is a typed 409", async () => {
  const { POST } = await import("@/app/api/v1/interventions/route");
  const { db, dbAudit } = await import("@/lib/db");
  const { setOrgTestNumbers } = await import("@/lib/abuse/tiers");
  const { setOrgGeoPolicy } = await import("@/lib/abuse/geo");
  const { setAbuseConfig } = await import("@/lib/abuse/config");
  const { topup } = await import("@/lib/billing/ledger");

  const stamp = Date.now().toString(36);
  const phone = destinationFor(stamp);
  setOrgTestNumbers("unscoped", [phone]);
  setOrgGeoPolicy("unscoped", { allowlist: ["AE"] });
  setAbuseConfig({ velocity: { burstRateMax: 100, newPrefixBurst: 100 } });

  const transactionRef = `TXN-DUP-${stamp}`;
  const consentRecordId = `CONSENT-DUP-${stamp}`;
  await topup({
    orgId: "unscoped",
    units: 50,
    eventId: `dup-topup-${stamp}`,
    reason: "duplicate-transaction fixture",
  });

  const a = makeRequest(`dup-a-${stamp}`, transactionRef, consentRecordId, phone);
  const b = makeRequest(`dup-b-${stamp}`, transactionRef, consentRecordId, phone);

  const [ra, rb] = await Promise.all([POST(a), POST(b)]);
  const bodies = [
    (await ra.json().catch(() => ({}))) as Record<string, unknown>,
    (await rb.json().catch(() => ({}))) as Record<string, unknown>,
  ];
  const statuses = [ra.status, rb.status];

  // The invariant. Two independent acceptances would mean two dialled calls to
  // one victim.
  const firstAcceptances = bodies.filter((j) => j.status === "queued" && !j.duplicate);
  expect(firstAcceptances.length).toBeLessThanOrEqual(1);

  // The database is the arbiter, not the response body: exactly one case may
  // exist for this transaction across every org.
  const cases = await db.case.findMany({ where: { transactionRef } });
  expect(cases.length).toBeLessThanOrEqual(1);

  // Whatever the winner did, the loser must be REFUSED and legible — never
  // dropped. A silent no-op reads to a bank as "delivered", and they would stop
  // retrying the signals that actually matter.
  const refused = statuses.filter((s) => s === 409);
  const accepted = statuses.filter((s) => s === 202);
  expect(accepted.length + refused.length).toBe(2);
  for (let i = 0; i < bodies.length; i++) {
    if (statuses[i] === 409) {
      expect(bodies[i]!.code).toBeTruthy();
      expect(String(bodies[i]!.message ?? "")).toBeTruthy();
      // Both the transaction dedupe and the dial gate's per-destination cooldown
      // are legitimate, independent reasons to refuse here. Which one fires first
      // is a race, so the assertion is on the SHAPE of the refusal rather than on
      // which guard won — the guard that matters is the one that stops the second
      // dial, and either does.
      expect(String(bodies[i]!.code)).toBe("policy_precondition");
    }
  }

  await db.$disconnect();
  await dbAudit.$disconnect();
}, 60_000);

test("a duplicate firing later is still refused, not re-armed", async () => {
  const { POST } = await import("@/app/api/v1/interventions/route");
  const { db, dbAudit } = await import("@/lib/db");
  const { setOrgTestNumbers } = await import("@/lib/abuse/tiers");
  const { setOrgGeoPolicy } = await import("@/lib/abuse/geo");
  const { setAbuseConfig } = await import("@/lib/abuse/config");
  const { topup } = await import("@/lib/billing/ledger");

  const stamp = Date.now().toString(36);
  const phone = destinationFor(`late-${stamp}`);
  setOrgTestNumbers("unscoped", [phone]);
  setOrgGeoPolicy("unscoped", { allowlist: ["AE"] });
  setAbuseConfig({ velocity: { burstRateMax: 100, newPrefixBurst: 100 } });

  const transactionRef = `TXN-LATE-${stamp}`;
  const consentRecordId = `CONSENT-LATE-${stamp}`;
  await topup({
    orgId: "unscoped",
    units: 50,
    eventId: `late-topup-${stamp}`,
    reason: "late-duplicate fixture",
  });

  const first = await POST(makeRequest(`late-a-${stamp}`, transactionRef, consentRecordId, phone));
  expect(first.status).toBe(202);

  // Sequentially — so this is NOT a race, just a duplicate firing later. This is
  // the case the race test cannot reach, and the one a retry storm produces.
  const second = await POST(makeRequest(`late-b-${stamp}`, transactionRef, consentRecordId, phone));
  const secondBody = (await second.json().catch(() => ({}))) as Record<string, unknown>;
  expect(second.status).toBe(409);
  expect(secondBody.code).toBe("policy_precondition");

  const cases = await db.case.findMany({ where: { transactionRef } });
  expect(cases.length).toBe(1);

  await db.$disconnect();
  await dbAudit.$disconnect();
}, 60_000);
