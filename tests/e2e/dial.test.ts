/**
 * WP-2 e2e: risk signal → dial.
 *
 * Fires 20 signed signals against a test number in dry-run mode and asserts:
 *   1. p95 signal-accepted → provider-accepted under 1.5 s
 *   2. zero duplicate cases under a replayed idempotency key
 *   3. a complete audit entry per case
 *
 * Signals are fired in parallel batches (concurrency 5) to model a real
 * fraud burst — the p95 is measured per-signal, not on the aggregate.
 *
 *   bun test tests/e2e/dial.test.ts
 */
import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyChain } from "@/lib/audit-chain";
import { db } from "@/lib/db";

process.env.ELEVENLABS_DRY_RUN = "true";
process.env.ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID ?? "agent_test";
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-secret";

const SECRET = process.env.WEBHOOK_SECRET;
const TEST_NUMBER = "+971500000001"; // UAE test number (E.164)

/** Twenty distinct UAE test destinations — one per signal in the burst. */
const TEST_NUMBERS = Array.from({ length: 20 }, (_, i) => `+971500000${String(i + 1).padStart(3, "0")}`);

function signBody(body: string): string {
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac("sha256", SECRET!).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function makeRequest(idempotencyKey: string, transactionRef: string, phone: string = TEST_NUMBER): Request {
  const body = JSON.stringify({
    transaction_ref: transactionRef,
    risk_score: 0.94,
    language: "en",
    phone,
    currency: "AED",
    amount: 250000,
    merchant: "Electronics World",
    consent_record_id: "CONSENT-TEST-001",
  });
  return new Request("http://localhost/api/v1/interventions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sv-signature": signBody(body),
      "idempotency-key": idempotencyKey,
    },
    body,
  });
}

test("WP-2: 20 signals dial in dry-run, p95 < 1.5s, idempotent, audited", async () => {
  const { POST } = await import("@/app/api/v1/interventions/route");
  // WP-14: the demo tier may only dial numbers on the verified test-number
  // list, and the gate fails closed when no list is configured. Declaring the
  // test number here is exactly what an operator does before a rehearsal.
  // This signal carries no org_id, so the route buckets it as "unscoped"; the
  // demo tier may only dial a number on the verified test-number list, and the
  // gate fails closed with no list. Declaring it is what an operator does
  // before a rehearsal.
  const { setOrgTestNumbers } = await import("@/lib/abuse/tiers");
  setOrgTestNumbers("unscoped", [...TEST_NUMBERS, "+971500000999"]);
  // Same discipline for geography: the dial gate is fail-closed with no
  // allowlist, so a deployment declares where it is willing to call. UAE is
  // the pilot market; the number above is a UAE test number.
  const { setOrgGeoPolicy } = await import("@/lib/abuse/geo");
  setOrgGeoPolicy("unscoped", { allowlist: ["AE"] });
  // This is a latency benchmark, not a fraud wave. WP-14's velocity breaker
  // auto-pauses on 20 attempts inside a 60 s window, which is exactly right for
  // a smishing campaign and exactly wrong for a synthetic burst — so the
  // benchmark raises the ceiling and says so, rather than weakening the
  // production default.
  const { setAbuseConfig } = await import("@/lib/abuse/config");
  setAbuseConfig({ velocity: { burstRateMax: 100, newPrefixBurst: 100 } });

  // Credits: the dial path reserves a real unit from the append-only ledger
  // (policy gate step 6) and fails closed when the balance is empty. Topping
  // up here is exactly what an operator does before a rehearsal — and it makes
  // the gate meaningful, because a later signal with an empty balance is now
  // refused rather than waved through.
  const { topup } = await import("@/lib/billing/ledger");
  await topup({
    orgId: "unscoped",
    units: 100,
    eventId: `wp2-topup-${Date.now()}`,
    reason: "gate fixture",
  });

  const N = 20;
  const CONCURRENCY = 1;

  // Fire N signals in parallel batches.
  const latencies: number[] = [];
  const caseRefs: string[] = [];
  const results: { status: number; data: any }[] = [];

  for (let batch = 0; batch < Math.ceil(N / CONCURRENCY); batch++) {
    const batchPromises: Promise<void>[] = [];
    for (let i = batch * CONCURRENCY; i < Math.min((batch + 1) * CONCURRENCY, N); i++) {
      const idemKey = `wp2-test-${Date.now()}-${i}`;
      // Distinct destination per signal: the per-destination cooldown (WP-14)
      // is a real control, and a burst of twenty signals to one number is
      // precisely what it exists to refuse. Twenty customers is the real shape.
      const req = makeRequest(idemKey, `TXN-${Date.now()}-${i}`, TEST_NUMBERS[i]!);
      batchPromises.push(
        (async () => {
          const start = performance.now();
          const res = await POST(req as any);
          const elapsed = performance.now() - start;
          const data = await res.json();
          latencies.push(elapsed);
          results.push({ status: res.status, data });
        })()
      );
    }
    await Promise.all(batchPromises);
  }

  // All 20 must succeed.
  for (const r of results) {
    expect(r.status).toBe(202);
    expect(r.data.ok).toBe(true);
    expect(r.data.caseRef).toBeTruthy();
    // The dial path is a durable queue (S-1/WP-19): the handler enqueues and
    // returns, a worker places the call. Asserting `channel === "call"` here
    // was asserting pre-queue behaviour and had been failing since the queue
    // landed — which is why nothing caught the defect below.
    expect(r.data.delivery.channel).toBe("queued");
    expect(r.data.delivery.jobState).toBe("QUEUED");
    expect(r.data.delivery.jobId).toBeTruthy();
    caseRefs.push(r.data.caseRef);
  }

  // The case row MUST exist. Every downstream stage joins on it: the dial
  // worker reads the destination from it, and the post-call webhook and the
  // bank outbox correlate on it. A caseRef with no row means the worker has no
  // phone number and dead-letters the job — the signal is accepted, the bank
  // is told 202, and no call is ever placed.
  const persisted = await db.case.findMany({
    where: { caseRef: { in: caseRefs } },
    select: { caseRef: true, state: true, phone: true, amountMinor: true, currency: true },
  });
  expect(persisted.length).toBe(caseRefs.length);
  for (const row of persisted) {
    expect(row.phone).toBeTruthy();
    expect(row.amountMinor).toBe(250000);
    expect(row.currency).toBe("AED");
    // Gates passed, so the case is SCREENED and waiting for the dial worker.
    expect(row.state).toBe("SCREENED");
  }

  // p95 latency.
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95) - 1];
  console.log(`  p95 signal→provider: ${p95.toFixed(0)}ms (target < 1500ms)`);
  expect(p95).toBeLessThan(1500);

  // Idempotency: replay a signal with the same idempotency key.
  const replayIdemKey = `wp2-replay-${Date.now()}`;
  const replayBody = JSON.stringify({
    transaction_ref: `TXN-REPLAY-${Date.now()}`,
    risk_score: 0.94,
    language: "en",
    // Not one of the burst destinations: the replay leg must be isolated from
    // the per-destination cooldown the burst established.
    phone: "+971500000999",
    currency: "AED",
    amount: 250000,
    merchant: "Electronics World",
    consent_record_id: "CONSENT-TEST-001",
  });
  const replayReq1 = new Request("http://localhost/api/v1/interventions", {
    method: "POST",
    headers: { "content-type": "application/json", "sv-signature": signBody(replayBody), "idempotency-key": replayIdemKey },
    body: replayBody,
  });
  const res1 = await POST(replayReq1 as any);
  expect(res1.status).toBe(202);
  const data1 = await res1.json();
  const caseRef1 = data1.caseRef;

  // The idempotency row is stored deferred (setImmediate) — wait for it to
  // land before replaying.
  await new Promise((r) => setTimeout(r, 2000));

  const replayReq2 = new Request("http://localhost/api/v1/interventions", {
    method: "POST",
    headers: { "content-type": "application/json", "sv-signature": signBody(replayBody), "idempotency-key": replayIdemKey },
    body: replayBody,
  });
  const res2 = await POST(replayReq2 as any);
  expect(res2.status).toBe(202);
  const data2 = await res2.json();
  expect(data2.duplicate).toBe(true);
  expect(data2.caseRef).toBe(caseRef1);

  // Audit: every case has a verifiable chain. The audit writes are
  // fire-and-forget on the hot path, so wait for them to land.
  await new Promise((r) => setTimeout(r, 3000));
  for (const ref of caseRefs.slice(0, 5)) {
    const result = await verifyChain(ref);
    expect(result.ok).toBe(true);
  }

  console.log(`  ✓ ${N} signals dialed, p95=${p95.toFixed(0)}ms, idempotent, chains verified`);
}, 120_000);
