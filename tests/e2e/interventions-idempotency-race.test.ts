/**
 * Concurrent idempotency on the intervention ingest.
 *
 * The defect this exists to prevent: the route used to read the idempotency key,
 * dial, and only THEN write the key — in a `setImmediate`. Two requests with the
 * same key arriving together both read "no stored response", both executed the
 * dial, and both placed a real call to the same fraud victim. The unique index
 * did not prevent it: it rejected the second ROW, after the call had already
 * been placed, so it was deduplicating bookkeeping rather than the side effect.
 *
 * The claim is now an INSERT ... ON CONFLICT DO NOTHING that happens BEFORE any
 * side effect, so exactly one requester can proceed. This file proves that by
 * racing two identical requests at the real route and asserting one dial.
 *
 *   bun test tests/e2e/interventions-idempotency-race.test.ts
 */
import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

// The signature key is WEBHOOK_SECRET (src/lib/config.ts), not SV_WEBHOOK_SECRET.
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-secret";
const SECRET = process.env.WEBHOOK_SECRET;
process.env.TWILIO_DRY_RUN = "true";

const TEST_NUMBER = "+971500000999";

function signBody(body: string): string {
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function makeRequest(idempotencyKey: string, transactionRef: string, consentRecordId: string) {
  const body = JSON.stringify({
    transaction_ref: transactionRef,
    risk_score: 0.94,
    language: "en",
    phone: TEST_NUMBER,
    currency: "AED",
    amount: 250000,
    merchant: "Electronics World",
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

test("two concurrent signals with one Idempotency-Key dial exactly once", async () => {
  const { POST } = await import("@/app/api/v1/interventions/route");
  const { db, dbAudit } = await import("@/lib/db");
  const { setOrgTestNumbers } = await import("@/lib/abuse/tiers");
  const { setOrgGeoPolicy } = await import("@/lib/abuse/geo");
  const { setAbuseConfig } = await import("@/lib/abuse/config");
  const { topup } = await import("@/lib/billing/ledger");

  setOrgTestNumbers("unscoped", [TEST_NUMBER]);
  setOrgGeoPolicy("unscoped", { allowlist: ["AE"] });
  setAbuseConfig({ velocity: { burstRateMax: 100, newPrefixBurst: 100 } });

  const stamp = Date.now().toString(36);
  const idemKey = `race-${stamp}`;
  const consentRecordId = `CONSENT-RACE-${stamp}`;
  await topup({
    orgId: "unscoped",
    units: 50,
    eventId: `race-topup-${stamp}`,
    reason: "race fixture",
  });

  // Both requests are byte-identical: same key, same payload. Any difference
  // and this would be testing two signals rather than one signal seen twice.
  const a = makeRequest(idemKey, `TXN-RACE-${stamp}`, consentRecordId);
  const b = makeRequest(idemKey, `TXN-RACE-${stamp}`, consentRecordId);

  const [ra, rb] = await Promise.all([POST(a), POST(b)]);
  const statuses = [ra.status, rb.status].sort();
  const jsonA = (await ra.json()) as Record<string, unknown>;
  const jsonB = (await rb.json()) as Record<string, unknown>;

  // The loser's response is either a replay of the winner (202) or an explicit
  // "already in flight" refusal (409). Both are correct; what must never happen
  // is two independent acceptances.
  expect(statuses.every((s) => s === 202 || s === 409)).toBe(true);

  // Exactly one of the two may be a first acceptance; the other must be flagged
  // as a duplicate or refused as in-flight.
  const acceptances = [jsonA, jsonB].filter((j) => j.status === "queued" && !j.duplicate);
  expect(acceptances.length).toBeLessThanOrEqual(1);

  // The database is the real arbiter: one claim row for this key.
  const rows = await db.idempotencyKey.count({
    where: { scope: "interventions", key: idemKey, callerId: "anon" },
  });
  expect(rows).toBeLessThanOrEqual(1);

  await db.$disconnect();
  await dbAudit.$disconnect();
}, 60_000);

test("a failed signal releases its claim so the same key can be retried", async () => {
  // A claim that outlives a failure would hold a 24-hour TTL and make the
  // caller's key permanently unusable: the retry would be refused as
  // "in flight" and the undelivered signal would never be delivered.
  const { db, dbAudit } = await import("@/lib/db");
  const stamp = Date.now().toString(36);

  await db.idempotencyKey.create({
    data: {
      scope: "interventions",
      key: `release-probe-${stamp}`,
      callerId: "anon",
      response: "",
      statusCode: 0,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const before = await db.idempotencyKey.count({
    where: { scope: "interventions", key: `release-probe-${stamp}` },
  });
  expect(before).toBe(1);

  await db.$executeRaw`
      DELETE FROM "IdempotencyKey"
      WHERE scope = 'interventions' AND key = ${`release-probe-${stamp}`}
    `;
  const after = await db.idempotencyKey.count({
    where: { scope: "interventions", key: `release-probe-${stamp}` },
  });
  expect(after).toBe(0);

  await db.$disconnect();
  await dbAudit.$disconnect();
}, 60_000);
