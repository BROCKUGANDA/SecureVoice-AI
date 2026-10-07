/**
 * E2E — the wallet gate on the production dial path.
 *
 * WHY THIS FILE EXISTS. `tests/chaos/chaos.test.ts` carries a hand-written
 * snapshot saying `credits_exhausted` is "declaredButNotEmitted", with the note
 * that policy-gate step 6 "is a comment, so runPolicyGate cannot produce those
 * two codes yet". Reading `src/lib/policy-gate.ts:302-329` shows step 6 IS
 * implemented — a balance check and an atomic ledger reserve. So one of the two
 * is wrong, and a snapshot that is maintained by hand rather than measured will
 * always drift that way.
 *
 * This file decides it by driving the real route:
 *
 *   · An organisation with a genuinely zero ledger balance is refused, and the
 *     refusal is a 409 policy refusal — not a 503 that would tell the bank to
 *     retry an unpaid account forever.
 *   · Funding it makes the same call succeed, and reserves exactly one unit.
 *   · Spending the last unit returns it to refused.
 *   · Two concurrent signals against one remaining credit produce exactly one
 *     dial, and the balance never goes negative.
 *
 * Each case uses a fresh `org_id`, because balance is the sum of that org's
 * ledger rows and the suite shares one database — reusing "unscoped" would make
 * the zero-balance premise depend on what an earlier run left behind.
 *
 *   bun test tests/e2e/interventions-credits-gate.test.ts
 */
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";

process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-secret";
process.env.TWILIO_DRY_RUN = "true";
const SECRET = process.env.WEBHOOK_SECRET;

/** Distinct from the other dial suites' numbers so velocity/cooldown cannot collide. */
const GATE_NUMBERS = ["+971500000701", "+971500000702", "+971500000703", "+971500000704"];

function signBody(body: string): string {
  const t = Math.floor(Date.now() / 1000).toString();
  return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
}

function signal(orgId: string, phone: string, transactionRef: string) {
  const body = JSON.stringify({
    org_id: orgId,
    transaction_ref: transactionRef,
    risk_score: 0.93,
    language: "en",
    phone,
    currency: "AED",
    amount: 250000,
    merchant: "Electronics World",
    consent_record_id: `CONSENT-${transactionRef}`,
  });
  return new Request("http://localhost/api/v1/interventions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sv-signature": signBody(body),
      "idempotency-key": `credits-${transactionRef}`,
    },
    body,
  });
}

async function wire(org: string) {
  const { POST } = await import("@/app/api/v1/interventions/route");
  const { db } = await import("@/lib/db");
  const { balance, topup } = await import("@/lib/billing/ledger");
  const { setOrgTestNumbers } = await import("@/lib/abuse/tiers");
  const { setOrgGeoPolicy } = await import("@/lib/abuse/geo");
  const { setAbuseConfig } = await import("@/lib/abuse/config");

  setAbuseConfig({ velocity: { burstRateMax: 100, newPrefixBurst: 100 } });
  // Geo and test-number policy are per-ORGANISATION. Configuring "unscoped"
  // would not reach a signal that carries its own org_id, and the gate refuses
  // the call as `geo_allowlist_unconfigured` rather than dialling blind.
  setOrgTestNumbers(org, GATE_NUMBERS);
  setOrgGeoPolicy(org, { allowlist: ["AE"] });
  return { POST, db, balance, topup };
}

const run = () => `credits_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

test("an organisation with no credits is refused with 409, and nothing is reserved or dialled", async () => {
  const org = `${run()}_a`;
  const { POST, db, balance } = await wire(org);

  expect(await balance(org)).toBe(0);

  const res = await POST(signal(org, GATE_NUMBERS[0]!, `TXN-${org}-1`));
  const text = await res.text();

  // A refusal, not an outage: 503 would tell the bank to retry an unpaid
  // account indefinitely, and would hide the reason behind "unavailable".
  expect(res.status).toBe(409);
  expect(text).toContain("credits_exhausted");

  // Refused BEFORE spend: no reservation was written, so the balance is still
  // exactly zero rather than -1 or a reserved-then-released pair.
  expect(await balance(org)).toBe(0);
  const reserves = await db.usageLedger.count({ where: { orgId: org, kind: "reserve" } });
  expect(reserves).toBe(0);
  // Nothing was armed: no case row, so no dial job can exist for this org.
  const cases = await db.case.count({ where: { orgId: org } });
  expect(cases).toBe(0);
});

test("funding the wallet lets the same call through, and reserves exactly one unit", async () => {
  const org = `${run()}_b`;
  const { POST, db, balance, topup } = await wire(org);
  await topup({ orgId: org, units: 1, eventId: `topup-${org}`, reason: "gate fixture" });
  expect(await balance(org)).toBe(1);

  const res = await POST(signal(org, GATE_NUMBERS[1]!, `TXN-${org}-1`));
  expect(res.status, `refused: ${await res.clone().text()}`).toBe(202);
  const body = (await res.json()) as { caseRef?: string; status?: string };
  expect(body.caseRef).toBeTruthy();

  // One unit reserved for one attempt — not one per retry, not one per signal.
  const reserves = await db.usageLedger.count({ where: { orgId: org, kind: "reserve" } });
  expect(reserves).toBe(1);
});

test("spending the last credit returns the organisation to refused", async () => {
  const org = `${run()}_c`;
  const { POST, balance, topup } = await wire(org);
  await topup({ orgId: org, units: 1, eventId: `topup-${org}`, reason: "gate fixture" });

  const first = await POST(signal(org, GATE_NUMBERS[2]!, `TXN-${org}-1`));
  expect(first.status, `refused: ${await first.clone().text()}`).toBe(202);
  await first.text();

  const second = await POST(signal(org, GATE_NUMBERS[3]!, `TXN-${org}-2`));
  const text = await second.text();
  expect(second.status).toBe(409);
  expect(text).toContain("credits_exhausted");
  expect(await balance(org)).toBe(0);
});

test("two concurrent signals for one remaining credit dial exactly once and never go negative", async () => {
  const org = `${run()}_d`;
  const { POST, db, balance, topup } = await wire(org);
  await topup({ orgId: org, units: 1, eventId: `topup-${org}`, reason: "gate fixture" });

  // Different transactions from the same org: the idempotency claim cannot be
  // what stops the second one, only the wallet can.
  const [r1, r2] = await Promise.all([
    POST(signal(org, GATE_NUMBERS[0]!, `TXN-${org}-1`)),
    POST(signal(org, GATE_NUMBERS[1]!, `TXN-${org}-2`)),
  ]);
  const [t1, t2] = [await r1.text(), await r2.text()];

  const accepted = [r1, r2].filter((r) => r.status === 202).length;
  const refused = [t1, t2].filter((t) => t.includes("credits_exhausted")).length;
  const after = await balance(org);
  const jobCount = await db.dialJob.count({ where: { orgId: org } });
  const cases = await db.case.count({ where: { orgId: org } });
  console.log(`[credits-race] SEVERITY dial_jobs=${jobCount} cases=${cases} balance=${after}`);
  const rows = await db.usageLedger.findMany({
    where: { orgId: org, kind: "reserve" },
    select: { caseRef: true, units: true },
  });
  console.log(
    `[credits-race] org=${org} accepted=${accepted} refused=${refused} balance=${after} reserves=${JSON.stringify(rows)}`,
  );

  const bodies = [t1, t2].map(
    (t) => JSON.parse(t) as { status?: string; caseRef?: string; duplicate?: boolean },
  );
  console.log(
    `[credits-race] bodies=${bodies.map((b) => `${b.status}/${b.caseRef}/dup=${b.duplicate}`).join(" | ")}`,
  );
  // A 202 is NOT the same event as a dial: an over-capacity signal is accepted
  // and shed to SMS with `status: "degraded_to_async"`, which is a correct 202.
  // What must be unique is the paid call — the one that reserved a credit.
  const reserved = await db.usageLedger.count({ where: { orgId: org, kind: "reserve" } });
  const dialled = bodies.filter((b) => b.status === "queued").length;

  expect(reserved, "one credit bought two paid calls").toBe(1);
  // The invariant: reservations == queued dial jobs. The ledger's refusal is a
  // VALUE and policy-gate step 6 treats it as the decision, so the loser of the
  // race is refused (409) instead of told "queued" for a call nobody paid for.
  // Mutation-proven: discarding the refusal value at the gate makes this test
  // fail with dial_jobs=2 cases=2 against one reserve.
  const jobs = await db.dialJob.count({ where: { orgId: org } });
  expect(jobs, `${jobs} dial jobs queued against ${reserved} reserved credit`).toBe(reserved);
  expect(after, "the wallet overspent under concurrency").toBe(0);
  console.log(
    `[credits-race] verdict reserved=${reserved} dialled=${dialled} statuses=${bodies.map((b) => b.status).join(",")}`,
  );
});
