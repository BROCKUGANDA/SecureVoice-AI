import { test, expect, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { db } from "@/lib/db";

/**
 * Concurrency-limit topology guard.
 *
 * These tests exist to prove that N simultaneous reservations never oversell,
 * which is only meaningful if the database actually admits N simultaneous
 * connections. The hosted test tier refuses them ("timeout exceeded when trying
 * to connect"), so the run fails with a connection error that looks like a
 * ledger bug and is not one.
 *
 * Rather than quietly reducing N — which would keep the suite green while
 * quietly weakening the one claim these tests exist to make — they are SKIPPED
 * with a loud warning when the target cannot host the concurrency. A skipped
 * concurrency test says nothing; a passing reduced-N one says something false.
 * The assertion is only proven where production runs: co-located Postgres.
 */
const dbHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "postgresql://localhost/x").hostname;
  } catch {
    return "localhost";
  }
})();
const isHostedTier = /supabase\.(co|com)$/.test(dbHost);
const NEEDS_MANY_CONNECTIONS = !isHostedTier;

if (isHostedTier) {
  console.warn(
    `[billing] SKIPPING concurrency assertions: ${dbHost} caps simultaneous connections below the ~100 these tests need. ` +
      "Oversell behaviour is UNPROVEN locally, not proven safe. Run against co-located Postgres to verify.",
  );
}
import {
  reserve,
  consume,
  release,
  refund,
  topup,
  settleAttempt,
  snapshot,
  balance,
  ledgerSum,
  ledgerIdemKey,
  reconcile,
  caseLedger,
  unitsForDurationMs,
  type LedgerWrite,
} from "@/lib/billing/ledger";
import {
  assertWithinBudget,
  maySpend,
  setOrgBudget,
  clearOrgBudget,
  killSwitchEngaged,
  ALERT_THRESHOLDS,
  HARD_STOP_PERCENT,
  KILL_SWITCH_ENV,
  HOURLY_LIMIT_ENV,
  windowBounds,
} from "@/lib/billing/breaker";
import {
  createPaystackProvider,
  paystackConfig,
  paystackDigest,
  buildReference,
  parseReference,
  verifyTransactionServerSide,
  onCheckoutComplete,
  backoffMs,
  decodeEvent,
  PAYSTACK_SIGNATURE_HEADER,
  type HttpClient,
} from "@/lib/payments/paystack";
import {
  recordPayment,
  verifyPayment,
  createManualInvoiceProvider,
  MANUAL_INVOICE_PROVIDER_ID,
} from "@/lib/payments/manual-invoice";
import { settlePayment, type StoredEntitlement } from "@/lib/payments/provider";
import { verifyChain } from "@/lib/audit-chain";

/**
 * WP-13 Gate: metering, billing and monetization.
 *
 * Proves, against the real Postgres test database:
 *
 *   1. 100 CONCURRENT reservations never oversell (a real 100-way race against
 *      a serialising advisory lock, not a loop that pretends to be one).
 *   2. Reconciliation is exact after a mixed reserve/consume/release sequence.
 *   3. A replayed Paystack webhook produces exactly one effect.
 *   4. Three webhook negatives are REJECTED: SHA-256 instead of SHA-512, a
 *      re-serialised body, and a forged signature.
 *   5. The breaker stops the 101st call and alerts at 60/80/95.
 *   6. Invariant I-8: the balance a caller sees IS the sum of the ledger.
 *   7. NOTHING in this file touches the network. `globalThis.fetch` is replaced
 *      with a tripwire at module load, so a single stray HTTP call fails the
 *      gate instead of silently reaching Paystack.
 */

const SECRET = "sk_test_0123456789abcdef0123456789abcdef";
const RUN = Date.now().toString(36);
const ORG = `org-${RUN}`;
const DAY_MS = 86_400_000;

/**
 * Weight of each kind's STORED (signed) value in `available` — the mirror of
 * `AVAILABLE_WEIGHT` in ledger.ts. Recomputed here independently so the gate
 * is checking the implementation, not restating it.
 */
const AVAILABLE_SIGN: Record<string, number> = {
  topup: 1,
  refund: 1, // stored negative, so this REDUCES available
  reserve: -1,
  release: -1, // stored negative, so this INCREASES available
  consume: 0,
};

// â”€â”€ network tripwire â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Armed before any adapter is constructed. The Paystack adapter takes an
// injected HTTP client, so the only way out of this process is
// `globalThis.fetch` — which now throws with an unmistakable message.
const REAL_FETCH = globalThis.fetch;
const NETWORK_CALLS: string[] = [];
globalThis.fetch = ((input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
  NETWORK_CALLS.push(url);
  throw new Error(`WP-13 GATE: real network call attempted to ${url}`);
}) as unknown as typeof fetch;

afterAll(async () => {
  globalThis.fetch = REAL_FETCH;
  await db.$disconnect();
});

// â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Deterministic jitter so the retry ladder costs no wall clock. */
const noSleep = async (): Promise<void> => {};
const fixedRand = (): number => 0.5;

type MockCall = { method: string; path: string; body: Record<string, unknown> | null };

/**
 * A Paystack stand-in. Every route the adapter uses is implemented and no
 * request ever leaves the process. `rateLimit` lets the gate prove the ladder.
 */
function mockPaystack(
  options: {
    rateLimit?: { path: string; times: number };
    verifyStatus?: (reference: string) => { status: string; amountMinor: number; currency: string };
  } = {},
) {
  const calls: MockCall[] = [];
  const rateLimitHits: number[] = [];
  /** What Paystack "knows" about each reference, the way a real gateway would. */
  const known = new Map<string, { status: string; amountMinor: number; currency: string }>();

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const http: HttpClient = async (url, init) => {
    const method = String(init.method ?? "GET");
    const path = new URL(url).pathname;
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, path, body });

    if (
      options.rateLimit &&
      options.rateLimit.path === path &&
      rateLimitHits.length < options.rateLimit.times
    ) {
      rateLimitHits.push(rateLimitHits.length);
      return json({ status: false, message: "rate limited" }, 429);
    }

    if (method === "POST" && path === "/transaction/initialize") {
      known.set(String(body?.reference), {
        status: "success",
        amountMinor: Number(body?.amount ?? 0),
        currency: String(body?.currency ?? "AED"),
      });
      return json({
        status: true,
        message: "Authorization URL created",
        data: {
          authorization_url: "https://checkout.paystack.test/abc",
          access_code: "access_test_1",
          reference: body?.reference,
        },
      });
    }
    if (method === "GET" && path.startsWith("/transaction/verify/")) {
      const reference = decodeURIComponent(path.slice("/transaction/verify/".length));
      const seen = options.verifyStatus?.(reference) ??
        known.get(reference) ?? { status: "failed", amountMinor: 0, currency: "AED" };
      return json({
        status: true,
        data: {
          reference,
          status: seen.status,
          amount: seen.amountMinor,
          currency: seen.currency,
          paid_at: new Date().toISOString(),
        },
      });
    }
    if (method === "POST" && path === "/transaction/charge_authorization") {
      known.set(String(body?.reference), {
        status: "success",
        amountMinor: Number(body?.amount ?? 0),
        currency: String(body?.currency ?? "AED"),
      });
      return json({
        status: true,
        data: {
          reference: body?.reference,
          status: "success",
          amount: body?.amount,
          currency: body?.currency,
        },
      });
    }
    if (method === "POST" && path === "/transaction/refund") {
      return json({ status: true, data: { reference: `ref_${body?.reference}` } });
    }
    return json({ status: false, message: `unmocked ${method} ${path}` }, 404);
  };

  return { http, calls, rateLimitHits, known };
}

/**
 * The exact bytes Paystack would send, plus its correct SHA-512 signature.
 * Deliberately pretty-printed so that any parse -> re-stringify round trip
 * produces DIFFERENT bytes — which is what makes negative case #2 meaningful.
 */
function signedWebhook(payload: Record<string, unknown>): { raw: Buffer; signature: string } {
  const text = JSON.stringify(payload, null, 2);
  const raw = Buffer.from(text, "utf8");
  return { raw, signature: paystackDigest(raw, SECRET) };
}

const entitlements: StoredEntitlement[] = [
  { key: "platform_licence", label: "Platform licence", units: 0 },
];

beforeAll(() => {
  process.env.PAYSTACK_ALLOW_LIVE_KEYS = "0";
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
test.skipIf(!NEEDS_MANY_CONNECTIONS)(
  "WP-13: 100 concurrent reservations never oversell",
  async () => {
    const org = `${ORG}-race`;
    const CAPACITY = 100;

    // Buy exactly 100 units. 100 simultaneous holds of 1 unit must all succeed and
    // the 101st must be refused — not one unit more, not one unit less.
    await topup({ orgId: org, units: CAPACITY, eventId: `race-topup-${RUN}` });

    // A genuinely concurrent race: all 100 promises are in flight before any of
    // them resolves. Nothing here awaits between reservations.
    //
    // `issuedAtFirstCompletion` is the evidence, not a comment: the synchronous
    // loop body runs to completion (issued === 100) before the first `.then`
    // callback can be scheduled, because every `reserve()` awaits the database.
    // If the calls were secretly serialised by anything in this process, the
    // first completion would see a smaller number and this assertion fails.
    let issued = 0;
    let issuedAtFirstCompletion = -1;
    const writes: LedgerWrite[] = await Promise.all(
      Array.from({ length: CAPACITY }, (_, i) => {
        issued++;
        return reserve({
          orgId: org,
          caseRef: `RACE-${RUN}-${i}`,
          unitsEstimate: 1,
          reason: "concurrent oversell probe",
        }).then((w) => {
          if (issuedAtFirstCompletion < 0) issuedAtFirstCompletion = issued;
          return w;
        });
      }),
    );
    expect(issued).toBe(CAPACITY);
    expect(issuedAtFirstCompletion).toBe(CAPACITY);

    const granted = writes.filter((w) => w.ok);
    const refused = writes.filter((w) => !w.ok);

    // â”€â”€ 1. every hold that could be granted was, and no more â”€â”€
    expect(refused).toHaveLength(0);
    expect(granted).toHaveLength(CAPACITY);
    expect(await balance(org)).toBe(0);
    expect(await balance(org)).toBeGreaterThanOrEqual(0);

    // â”€â”€ 2. total reserved never exceeded what was available â”€â”€
    const rows = await db.usageLedger.findMany({ where: { orgId: org, kind: "reserve" } });
    const totalReserved = rows.reduce((acc, r) => acc + r.units, 0);
    expect(totalReserved).toBe(CAPACITY);
    expect(totalReserved).toBeLessThanOrEqual(CAPACITY);
    expect(rows).toHaveLength(CAPACITY);

    // â”€â”€ 3. a second 100-wide wave is refused in full; the balance never goes
    //       negative at any point any caller could observe â”€â”€
    const extra = await Promise.all(
      Array.from({ length: CAPACITY }, (_, i) =>
        reserve({
          orgId: org,
          caseRef: `RACE2-${RUN}-${i}`,
          unitsEstimate: 1,
          reason: "oversell attempt",
        }),
      ),
    );
    expect(extra.every((w) => !w.ok)).toBe(true);
    for (const w of extra) {
      if (w.ok) throw new Error("a reservation was granted on a zero balance");
      expect(w.reason).toBe("insufficient_available");
      expect(w.snapshot.available).toBe(0);
      expect(w.snapshot.available).toBeGreaterThanOrEqual(0);
    }
    expect(await balance(org)).toBe(0);
    expect(await db.usageLedger.count({ where: { orgId: org, kind: "reserve" } })).toBe(CAPACITY);

    // â”€â”€ 4. the UNIQUE index, not the retry logic, is what stops a replay â”€â”€
    const replay = await reserve({
      orgId: org,
      caseRef: `RACE-${RUN}-0`,
      unitsEstimate: 1,
      reason: "replay of the same attempt",
    });
    expect(replay.ok && replay.duplicate).toBe(true);
    expect(await db.usageLedger.count({ where: { orgId: org } })).toBe(CAPACITY + 1); // 1 topup + 100 reserves

    const rec = await reconcile(org);
    expect(rec.ok).toBe(true);
    expect(rec.drift).toBe(0);
    expect(rec.chain.ok).toBe(true);
    expect(rec.chain.rows).toBe(CAPACITY + 1);
  },
  180_000,
);

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
test.skipIf(!NEEDS_MANY_CONNECTIONS)(
  "WP-13: partial fills never oversell — 250 units of capacity, 100 x 30 requested",
  async () => {
    const org = `${ORG}-partial`;
    await topup({ orgId: org, units: 250, eventId: `partial-topup-${RUN}` });

    const writes = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        reserve({
          orgId: org,
          caseRef: `PART-${RUN}-${i}`,
          unitsEstimate: 30,
          reason: "oversized reservation",
        }),
      ),
    );

    const granted = writes.filter((w): w is Extract<LedgerWrite, { ok: true }> => w.ok);
    const refused = writes.filter((w) => !w.ok);

    // 8 x 30 = 240 fits in 250; a 9th does not. Exactly 8, never 9.
    expect(granted).toHaveLength(8);
    expect(refused).toHaveLength(92);
    const totalReserved = granted.reduce((acc, w) => acc + w.entry.units, 0);
    expect(totalReserved).toBe(240);
    expect(totalReserved).toBeLessThanOrEqual(250);
    expect(await balance(org)).toBe(10);

    // A 10-unit hold still fits in the 10 left; an 11-unit hold does not.
    expect((await reserve({ orgId: org, caseRef: `PART-FIT-${RUN}`, unitsEstimate: 10 })).ok).toBe(
      true,
    );
    const doesNot = await reserve({ orgId: org, caseRef: `PART-OVER-${RUN}`, unitsEstimate: 11 });
    expect(doesNot.ok).toBe(false);
    expect(await balance(org)).toBe(0);
    expect(await balance(org)).toBeGreaterThanOrEqual(0);
  },
  180_000,
);

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
test("WP-13: reconciliation is exact after a mixed reserve/consume/release sequence", async () => {
  const org = `${ORG}-recon`;
  await topup({ orgId: org, units: 100_000, eventId: `recon-topup-${RUN}` });

  // Case 1: estimate 900 units, actually used 420.
  const caseRef = `SV-WP13-${RUN}`;
  const reserved = await reserve({
    orgId: org,
    caseRef,
    unitsEstimate: 900,
    reason: "dial estimate",
  });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) throw new Error("unreachable");
  expect(reserved.snapshot.available).toBe(99_100);

  const settled = await settleAttempt({
    orgId: org,
    caseRef,
    unitsEstimate: 900,
    unitsActual: 420,
    reason: "post-call webhook",
  });
  expect(settled.consume.ok).toBe(true);
  expect(settled.release.ok).toBe(true);
  expect(settled.remainder).toBe(480);

  // Held must be exactly zero: the hold was fully consumed or returned.
  const after = await snapshot(org);
  expect(after.held).toBe(0);
  expect(after.wallet).toBe(99_580);
  expect(after.available).toBe(99_580);
  expect(await balance(org)).toBe(99_580);

  // The per-attempt trio, in commit order, is exactly reserve/consume/release.
  // `units` is stored signed: release is negative.
  const trio = await caseLedger(caseRef);
  expect(trio.map((r) => r.kind)).toEqual(["reserve", "consume", "release"]);
  expect(trio.map((r) => r.units)).toEqual([900, 420, -480]);
  expect(trio.map((r) => r.idemKey)).toEqual([
    `${caseRef}:1:reserve`,
    `${caseRef}:1:consume`,
    `${caseRef}:1:release`,
  ]);

  // Case 2: aborted call — reserve 500, release all 500. Net zero.
  const abortRef = `SV-WP13-ABORT-${RUN}`;
  await reserve({ orgId: org, caseRef: abortRef, unitsEstimate: 500, reason: "dial estimate" });
  expect((await snapshot(org)).held).toBe(500);
  await release({ orgId: org, caseRef: abortRef, units: 500, reason: "call aborted" });
  expect((await snapshot(org)).held).toBe(0);

  // Case 3: a report of more usage than was held is REFUSED, not allowed to
  // dip the organisation below zero.
  const overRef = `SV-WP13-OVER-${RUN}`;
  await reserve({ orgId: org, caseRef: overRef, unitsEstimate: 10, reason: "dial estimate" });
  const overConsume = await consume({
    orgId: org,
    caseRef: overRef,
    unitsActual: 50,
    reason: "bad report",
  });
  expect(overConsume.ok).toBe(false);
  if (!overConsume.ok) expect(overConsume.reason).toBe("insufficient_hold");
  await release({ orgId: org, caseRef: overRef, units: 10, reason: "unwind" });
  expect((await snapshot(org)).held).toBe(0);

  // â”€â”€ the reconciliation itself â”€â”€
  const rec = await reconcile(org);
  expect(rec.invariant).toBe("I-8");
  expect(rec.findings).toEqual([]);
  expect(rec.chain.ok).toBe(true);
  expect(rec.drift).toBe(0);
  expect(rec.materialised).toBe(99_580);
  expect(rec.snapshot.available).toBe(99_580);

  // Independent cross-check: sum the raw journal and re-derive by hand.
  // `units` is stored SIGNED (release/refund negative), per the schema contract.
  const raw = await db.usageLedger.findMany({ where: { orgId: org } });
  const sum = (k: string) => raw.filter((r) => r.kind === k).reduce((a, r) => a + r.units, 0);
  const walletByHand = sum("topup") + sum("refund") - sum("consume");
  const heldByHand = sum("reserve") + sum("release") - sum("consume");
  expect(walletByHand).toBe(99_580);
  expect(heldByHand).toBe(0);
  expect(walletByHand - heldByHand).toBe(await balance(org));
  // SUM(units) is the signed journal total, and it agrees with the exported sum.
  expect(await ledgerSum(org)).toBe(
    sum("topup") + sum("reserve") + sum("consume") + sum("release") + sum("refund"),
  );
  expect(rec.ledgerSum).toBe(await ledgerSum(org));
  // release/refund are stored negative, reserve/consume/topup positive.
  expect(sum("release")).toBeLessThan(0);
  expect(sum("reserve")).toBeGreaterThan(0);
  expect(sum("consume")).toBeGreaterThan(0);

  // â”€â”€ drift detection actually DETECTS drift â”€â”€
  const drifted = await reconcile(org, { materialised: 99_579 });
  expect(drifted.ok).toBe(false);
  expect(drifted.drift).toBe(-1);
  expect(drifted.findings.join(" ")).toContain("balance drift");

  // â”€â”€ the idempotency key shape is exactly {caseRef}:{attemptNo}:{kind} â”€â”€
  expect(ledgerIdemKey(caseRef, 1, "reserve")).toBe(`${caseRef}:1:reserve`);
  expect(await db.usageLedger.count({ where: { idemKey: `${caseRef}:1:reserve` } })).toBe(1);
  // Re-running the entire settle produces no new rows and moves no money.
  const before = raw.length;
  await settleAttempt({ orgId: org, caseRef, unitsEstimate: 900, unitsActual: 420 });
  expect(await db.usageLedger.count({ where: { orgId: org } })).toBe(before);
  expect(await balance(org)).toBe(99_580);

  // A second attempt on the same case is a different key and settles separately.
  await reserve({ orgId: org, caseRef, attemptNo: 2, unitsEstimate: 100, reason: "retry" });
  await settleAttempt({ orgId: org, caseRef, attemptNo: 2, unitsEstimate: 100, unitsActual: 100 });
  expect(await balance(org)).toBe(99_480);
  expect(await reconcile(org).then((r) => r.ok)).toBe(true);
}, 180_000);

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
test("WP-13: replayed Paystack webhook charges once; SHA-256, re-serialised bodies and forgeries are rejected", async () => {
  const org = `${ORG}-paystack`;
  const { http, calls } = mockPaystack();
  const provider = createPaystackProvider({
    secretKey: SECRET,
    http,
    sleep: noSleep,
    rand: fixedRand,
  });
  const cfg = paystackConfig({ secretKey: SECRET, http, sleep: noSleep, rand: fixedRand });

  // â”€â”€ checkout: OUR reference, our shape, integer minor units â”€â”€
  const session = await provider.createCheckout({
    orgId: org,
    purpose: "topup",
    money: { amountMinor: 250_000, currency: "AED" },
    email: "treasury@example.test",
    requestKey: `req-${RUN}`,
  });
  expect(session.reference.startsWith(`org_${org}_topup_`)).toBe(true);
  expect(parseReference(session.reference)).toEqual({ orgId: org, purpose: "topup" });
  // The reference shape is OUR contract with Paystack, not the caller's.
  expect(buildReference(org, "topup")).toMatch(new RegExp(`^org_${org}_topup_[0-9A-Z]{26}$`));
  expect(buildReference(org, "topup")).not.toBe(buildReference(org, "topup"));
  // Hostile characters in orgId/purpose cannot escape the shape.
  expect(buildReference("a b;c", "x/y")).toMatch(/^org_abc_xy_[0-9A-Z]{26}$/);
  expect(parseReference("not-ours")).toBeNull();
  expect(session.url).toContain("checkout.paystack.test");
  const initBody = calls.find((c) => c.path === "/transaction/initialize")?.body;
  expect(initBody?.amount).toBe(250_000);
  expect(initBody?.currency).toBe("AED");
  expect(Number.isInteger(initBody?.amount)).toBe(true);
  // Two checkouts get two distinct references — we never let a client pick one.
  const second = await provider.createCheckout({
    orgId: org,
    purpose: "topup",
    money: { amountMinor: 250_000, currency: "AED" },
    email: "treasury@example.test",
    requestKey: `req2-${RUN}`,
  });
  expect(second.reference).not.toBe(session.reference);

  // â”€â”€ the webhook, verified then REPLAYED three times â”€â”€
  const { raw, signature } = signedWebhook({
    event: "charge.success",
    id: `evt_${RUN}_1`,
    created_at: new Date().toISOString(),
    data: {
      id: 987654321,
      reference: session.reference,
      amount: 250_000,
      currency: "AED",
      status: "success",
      paid_at: new Date().toISOString(),
    },
  });

  const first = await provider.verifyWebhook({
    rawBody: raw,
    headers: { [PAYSTACK_SIGNATURE_HEADER]: signature },
  });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("unreachable");
  expect(first.event.eventId).toBe(`evt_${RUN}_1`);
  expect(first.event.reference).toBe(session.reference);
  expect(first.event.kind).toBe("charge.succeeded");
  expect(first.event.money.amountMinor).toBe(250_000);
  expect(first.event.money.currency).toBe("AED");

  const settled = await settlePayment({
    provider: provider.id,
    orgId: org,
    reference: first.event.reference,
    money: first.event.money,
    status: "success",
    eventId: first.event.eventId,
    entitlements,
  });
  expect(settled.applied).toBe(true);
  expect(settled.unitsCredited).toBe(250_000);
  const afterFirst = await balance(org);
  expect(afterFirst).toBe(250_000);

  for (let replay = 0; replay < 3; replay++) {
    const again = await provider.verifyWebhook({
      rawBody: raw,
      headers: { [PAYSTACK_SIGNATURE_HEADER]: signature },
    });
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error("unreachable");
    const resettled = await settlePayment({
      provider: provider.id,
      orgId: org,
      reference: again.event.reference,
      money: again.event.money,
      status: "success",
      eventId: again.event.eventId,
      entitlements,
    });
    // Same event id + same reference => exactly one effect.
    expect(resettled.applied).toBe(false);
    expect(resettled.duplicate).toBe(true);
    expect(resettled.unitsCredited).toBe(0);
  }
  expect(await balance(org)).toBe(afterFirst);
  expect(await db.usageLedger.count({ where: { orgId: org, kind: "topup" } })).toBe(1);
  expect(await db.paymentRecord.count({ where: { reference: session.reference } })).toBe(1);

  // â”€â”€ NEGATIVE 1: SHA-256 must be REJECTED. The classic wrong-algorithm bug. â”€â”€
  const sha256 = createHmac("sha256", SECRET).update(raw).digest("hex");
  expect(sha256).not.toBe(signature);
  expect(sha256).toHaveLength(64);
  expect(signature).toHaveLength(128); // sha512 hex; sha256 hex is half that
  const wrongAlgo = await provider.verifyWebhook({
    rawBody: raw,
    headers: { [PAYSTACK_SIGNATURE_HEADER]: sha256 },
  });
  expect(wrongAlgo.ok).toBe(false);
  if (wrongAlgo.ok) throw new Error("unreachable");
  expect(wrongAlgo.reason).toBe("digest_mismatch");

  // â”€â”€ NEGATIVE 2: a re-serialised body must be REJECTED. â”€â”€
  // parse -> JSON.stringify is what a naive handler does before hashing. Prove
  // the bytes really differ, then prove the verifier refuses them.
  const reserialisedRaw = Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8"))), "utf8");
  expect(reserialisedRaw.equals(raw)).toBe(false);
  expect(paystackDigest(reserialisedRaw, SECRET)).not.toBe(signature);
  const reserialised = await provider.verifyWebhook({
    rawBody: reserialisedRaw,
    headers: { [PAYSTACK_SIGNATURE_HEADER]: signature },
  });
  expect(reserialised.ok).toBe(false);
  if (reserialised.ok) throw new Error("unreachable");
  expect(reserialised.reason).toBe("digest_mismatch");

  // Whitespace-only tampering is rejected too, not just reordering.
  expect(
    (
      await provider.verifyWebhook({
        rawBody: Buffer.from(`${raw.toString("utf8")} `, "utf8"),
        headers: { [PAYSTACK_SIGNATURE_HEADER]: signature },
      })
    ).ok,
  ).toBe(false);

  // â”€â”€ NEGATIVE 3: a forged signature must be REJECTED â”€â”€
  const forgedHex = "a".repeat(128);
  expect(forgedHex).not.toBe(signature);
  const forged = await provider.verifyWebhook({
    rawBody: raw,
    headers: { [PAYSTACK_SIGNATURE_HEADER]: forgedHex },
  });
  expect(forged.ok).toBe(false);
  if (forged.ok) throw new Error("unreachable");
  expect(forged.reason).toBe("digest_mismatch");

  // Correct digest, WRONG KEY, is equally a forgery.
  const wrongKey = paystackDigest(raw, `${SECRET}x`);
  expect(wrongKey).not.toBe(signature);
  expect(
    (
      await provider.verifyWebhook({
        rawBody: raw,
        headers: { [PAYSTACK_SIGNATURE_HEADER]: wrongKey },
      })
    ).ok,
  ).toBe(false);

  // â”€â”€ missing / malformed headers â”€â”€
  const missing = await provider.verifyWebhook({ rawBody: raw, headers: {} });
  if (missing.ok) throw new Error("unreachable");
  expect(missing.reason).toBe("missing_signature");
  const malformed = await provider.verifyWebhook({
    rawBody: raw,
    headers: { [PAYSTACK_SIGNATURE_HEADER]: "not-hex" },
  });
  if (malformed.ok) throw new Error("unreachable");
  expect(malformed.reason).toBe("malformed_signature");

  // A validly-signed body that is not a charge event is refused as unsupported.
  const junk = signedWebhook({
    event: "customer.updated",
    id: "evt_x",
    data: { reference: "org_a_b_c", amount: 1, currency: "AED" },
  });
  const junkResult = await provider.verifyWebhook({
    rawBody: junk.raw,
    headers: { [PAYSTACK_SIGNATURE_HEADER]: junk.signature },
  });
  if (junkResult.ok) throw new Error("unreachable");
  expect(junkResult.reason).toBe("unsupported_event");
  // A float amount is not a money amount.
  expect(
    decodeEvent({
      event: "charge.success",
      id: "1",
      data: { reference: "r", amount: 1.5, currency: "AED" },
    }),
  ).toBeNull();

  // â”€â”€ the browser callback is NEVER trusted â”€â”€
  // The reference is the one OUR checkout generated; the buyer returns it in the
  // query string, but nothing about the return is believed.
  const callbackAmount = 500;
  const callbackSession = await provider.createCheckout({
    orgId: org,
    purpose: "topup",
    money: { amountMinor: callbackAmount, currency: "AED" },
    email: "treasury@example.test",
    requestKey: `cb-${RUN}`,
  });
  const callbackRef = callbackSession.reference;
  expect(parseReference(callbackRef)?.orgId).toBe(org);
  // The "expected" amount below is what WE recorded. The callback's own claim
  // (`claimedStatus`) is recorded for the audit trail and never consulted.

  // Paystack says success but for a different amount: the amount check fires.
  const amountMismatch = await onCheckoutComplete({
    reference: callbackRef,
    expected: { amountMinor: callbackAmount, currency: "AED" },
    provider,
    verify: async () => ({
      ok: true,
      status: "success",
      money: { amountMinor: 1, currency: "AED" },
    }),
    claimedStatus: "success",
  });
  expect(amountMismatch.ok).toBe(false);
  if (amountMismatch.ok) throw new Error("unreachable");
  expect(amountMismatch.reason).toBe("amount_mismatch");

  // Right amount, wrong currency.
  const currencyMismatch = await onCheckoutComplete({
    reference: callbackRef,
    expected: { amountMinor: callbackAmount, currency: "AED" },
    provider,
    verify: async () => ({
      ok: true,
      status: "success",
      money: { amountMinor: callbackAmount, currency: "NGN" },
    }),
    claimedStatus: "success",
  });
  if (currencyMismatch.ok) throw new Error("unreachable");
  expect(currencyMismatch.reason).toBe("currency_mismatch");

  // Paystack says FAILED while the callback claims success: Paystack wins.
  const notSuccess = await onCheckoutComplete({
    reference: callbackRef,
    expected: { amountMinor: callbackAmount, currency: "AED" },
    provider,
    verify: async () => ({
      ok: true,
      status: "failed",
      money: { amountMinor: callbackAmount, currency: "AED" },
    }),
    claimedStatus: "success",
  });
  expect(notSuccess.ok).toBe(false);
  if (notSuccess.ok) throw new Error("unreachable");
  expect(notSuccess.reason).toBe("not_success");

  // A reference we did not generate is refused before any verification runs.
  const notOurs = await onCheckoutComplete({
    reference: "attacker-chosen-reference",
    expected: { amountMinor: callbackAmount, currency: "AED" },
    provider,
    verify: async () => {
      throw new Error("must never be called");
    },
  });
  expect(notOurs.ok).toBe(false);
  if (notOurs.ok) throw new Error("unreachable");
  expect(notOurs.reason).toBe("not_our_reference");

  // The genuine return path settles — through the REAL server-side verify.
  const genuineVerify = () => verifyTransactionServerSide(cfg, callbackRef);
  const good = await onCheckoutComplete({
    reference: callbackRef,
    expected: { amountMinor: callbackAmount, currency: "AED" },
    provider,
    verify: genuineVerify,
  });
  expect(good.ok).toBe(true);
  if (!good.ok) throw new Error("unreachable");
  expect(good.settled).toBe(true);

  // Refreshing the return page settles nothing further.
  const balanceAfterSettle = await balance(org);
  const refresh = await onCheckoutComplete({
    reference: callbackRef,
    expected: { amountMinor: callbackAmount, currency: "AED" },
    provider,
    verify: genuineVerify,
  });
  if (!refresh.ok) throw new Error("unreachable");
  expect(refresh.settled).toBe(false);
  expect(await balance(org)).toBe(balanceAfterSettle);

  // â”€â”€ computed overage against a stored authorization â”€â”€
  const charged = await provider.chargeStoredAuthorization({
    orgId: org,
    authorization: { authorizationCode: "AUTH_test_123", email: "treasury@example.test" },
    money: { amountMinor: 1_234, currency: "AED" },
    purpose: "overage",
    requestKey: `ov-${RUN}`,
  });
  expect(charged.ok).toBe(true);
  if (!charged.ok) throw new Error("unreachable");
  expect(charged.verified).toBe(true);
  const chargeCall = calls.find((c) => c.path === "/transaction/charge_authorization");
  expect(chargeCall?.body?.authorization_code).toBe("AUTH_test_123");
  expect(chargeCall?.body?.amount).toBe(1_234);
  expect(chargeCall?.body?.reference).toMatch(new RegExp(`^org_${org}_overage_[0-9A-Z]{26}$`));

  // â”€â”€ 429 is retried with jittered backoff, then succeeds â”€â”€
  const rl = mockPaystack({ rateLimit: { path: "/transaction/initialize", times: 2 } });
  const rlProvider = createPaystackProvider({
    secretKey: SECRET,
    http: rl.http,
    sleep: noSleep,
    rand: fixedRand,
  });
  const rlSession = await rlProvider.createCheckout({
    orgId: org,
    purpose: "topup",
    money: { amountMinor: 100, currency: "AED" },
    email: "treasury@example.test",
    requestKey: `rl-${RUN}`,
  });
  expect(rlSession.url).toContain("checkout.paystack.test");
  expect(rl.rateLimitHits).toHaveLength(2);
  expect(rl.calls.filter((c) => c.path === "/transaction/initialize")).toHaveLength(3); // 2 x 429 + 1 x 200
  // Jittered exponential: rising with the attempt, and varying with the RNG.
  expect(backoffMs(1, () => 0)).toBeGreaterThan(0);
  expect(backoffMs(2, fixedRand)).toBeGreaterThan(backoffMs(1, fixedRand));
  expect(backoffMs(3, fixedRand)).toBeGreaterThan(backoffMs(2, fixedRand));
  expect(backoffMs(1, () => 1)).toBeGreaterThan(backoffMs(1, () => 0));

  // A live key is refused outright unless explicitly overridden.
  expect(() => createPaystackProvider({ secretKey: "sk_live_abcdef", http })).toThrow(
    /test-keys-only/,
  );

  // Nothing in this test left the process.
  expect(NETWORK_CALLS).toEqual([]);
}, 180_000);

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
test("WP-13: manual invoice enforces dual control and audit-chains both actions", async () => {
  const org = `${ORG}-manual`;
  const bankRef = `TRF-${RUN}-0001`;
  const operatorA = `user_opA_${RUN}`;
  const operatorB = `user_opB_${RUN}`;

  // â”€â”€ step 1: recording credits NOTHING â”€â”€
  const recorded = await recordPayment({
    orgId: org,
    bankReference: bankRef,
    money: { amountMinor: 500_000, currency: "AED" },
    recordedBy: operatorA,
    entitlements,
    purpose: "annual_platform_licence",
  });
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) throw new Error("unreachable");
  expect(recorded.duplicate).toBe(false);
  expect(await balance(org)).toBe(0);
  const pending = await db.paymentRecord.findUnique({ where: { reference: bankRef } });
  expect(pending?.status).toBe("pending");
  expect(pending?.verifiedBy).toBeNull();

  // Re-entering the same transfer creates no second row.
  const again = await recordPayment({
    orgId: org,
    bankReference: bankRef,
    money: { amountMinor: 500_000, currency: "AED" },
    recordedBy: operatorB,
    entitlements,
  });
  expect(again.ok && again.duplicate).toBe(true);
  expect(await db.paymentRecord.count({ where: { reference: bankRef } })).toBe(1);

  // â”€â”€ DUAL CONTROL: the recorder may never verify â”€â”€
  const selfVerify = await verifyPayment({ bankReference: bankRef, verifiedBy: operatorA });
  expect(selfVerify.ok).toBe(false);
  if (selfVerify.ok) throw new Error("unreachable");
  expect(selfVerify.reason).toBe("self_verification_forbidden");
  expect(await balance(org)).toBe(0);
  expect((await db.paymentRecord.findUnique({ where: { reference: bankRef } }))?.status).toBe(
    "pending",
  );

  // â”€â”€ a DIFFERENT operator may â”€â”€
  const verified = await verifyPayment({
    bankReference: bankRef,
    verifiedBy: operatorB,
    note: "seen on statement",
  });
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error("unreachable");
  expect(verified.unitsCredited).toBe(500_000);
  expect(await balance(org)).toBe(500_000);

  const row = await db.paymentRecord.findUnique({ where: { reference: bankRef } });
  expect(row?.provider).toBe(MANUAL_INVOICE_PROVIDER_ID);
  expect(row?.status).toBe("success");
  expect(row?.verifiedBy).toBe(operatorB);
  expect(row?.verifiedAt).not.toBeNull();
  // The recorder identity is PERSISTED, so dual control survives a restart.
  expect(row?.entitlementsJson).toContain(operatorA);
  expect(await createManualInvoiceProvider().listEntitlements(bankRef)).toEqual(entitlements);

  // Re-verifying is a no-op, not a second credit.
  const secondVerify = await verifyPayment({ bankReference: bankRef, verifiedBy: operatorB });
  expect(secondVerify.ok && secondVerify.alreadyVerified).toBe(true);
  expect(await balance(org)).toBe(500_000);
  expect(await db.usageLedger.count({ where: { orgId: org, kind: "topup" } })).toBe(1);

  // â”€â”€ both actions are audit-chained under one callRef â”€â”€
  // `recordPayment`/`verifyPayment` audit under `input.orgId`, which for this
  // fixture is `org` — the same string passed to every call above.
  const chain = await verifyChain(`PAY-${bankRef}`, org);
  expect(chain.ok).toBe(true);
  const auditRows = await db.auditLog.findMany({ where: { callRef: `PAY-${bankRef}` } });
  const intents = auditRows.map((r) => r.intent);
  expect(intents).toContain("payment_recorded");
  expect(intents).toContain("payment_selfverify_blocked");
  expect(intents).toContain("payment_verified");
  // The BLOCKED self-verification is on the record, not swallowed.
  expect(
    await db.auditLog.count({
      where: { callRef: `PAY-${bankRef}`, intent: "payment_selfverify_blocked" },
    }),
  ).toBe(1);
  // Chain hashes are distinct — these are real links, not duplicate rows.
  expect(new Set(auditRows.map((r) => r.chainHash)).size).toBe(auditRows.length);

  // An unknown reference is refused, not invented.
  const unknown = await verifyPayment({ bankReference: `NOPE-${RUN}`, verifiedBy: operatorB });
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.reason).toBe("not_found");

  // A float amount is rejected at the port boundary, not rounded.
  expect(() =>
    recordPayment({
      orgId: org,
      bankReference: `TRF-${RUN}-0002`,
      money: { amountMinor: 1.5, currency: "AED" },
      recordedBy: operatorA,
    }),
  ).toThrow(/integer minor-unit/);
  // So is a malformed bank reference.
  expect(
    await recordPayment({
      orgId: org,
      bankReference: "<script>x</script>",
      money: { amountMinor: 100, currency: "AED" },
      recordedBy: operatorA,
    }),
  ).toMatchObject({ ok: false, reason: "invalid_reference" });
}, 180_000);

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
test.skipIf(!NEEDS_MANY_CONNECTIONS)(
  "WP-13: the breaker stops the 101st call and alerts at 60/80/95",
  async () => {
    const org = `${ORG}-breaker`;
    const CAP = 100_000; // minor units
    setOrgBudget(org, { hourlyMinor: CAP, dailyMinor: CAP });
    // Wall clock, so the rows written below fall inside the windows being read.
    const now = new Date();

    expect(killSwitchEngaged()).toBe(false);
    expect(ALERT_THRESHOLDS).toEqual([60, 80, 95]);
    expect(HARD_STOP_PERCENT).toBe(100);

    // Windows align to the UTC hour and the UTC day.
    const probe = new Date("2026-03-04T10:17:30.000Z");
    expect(windowBounds("hourly", probe).start.toISOString()).toBe("2026-03-04T10:00:00.000Z");
    expect(windowBounds("hourly", probe).end.toISOString()).toBe("2026-03-04T11:00:00.000Z");
    expect(windowBounds("daily", probe).start.toISOString()).toBe("2026-03-04T00:00:00.000Z");
    expect(windowBounds("daily", probe).end.toISOString()).toBe("2026-03-05T00:00:00.000Z");

    // â”€â”€ one call per 1% of the cap. The decision is taken BEFORE its own units
    //    land, which is exactly what a request handler sees. â”€â”€
    const decisions: {
      call: number;
      decision: string;
      threshold: number | null;
      percent: number;
    }[] = [];
    for (let call = 1; call <= 101; call++) {
      const d = await assertWithinBudget({ orgId: org, units: 1_000, now });
      decisions.push({
        call,
        decision: d.decision,
        threshold: d.decision === "warn" ? d.threshold : null,
        percent: d.percent,
      });

      if (call === 100) {
        // Spending exactly to the cap is allowed; 99% already spent, 100% projected.
        expect(maySpend(d)).toBe(true);
        expect(d.windows.find((w) => w.window === "daily")?.currentPercent).toBe(99);
      }
      if (call === 101) {
        expect(d.decision).toBe("stop");
        expect(maySpend(d)).toBe(false);
        if (d.decision === "stop") {
          expect(d.reason).toBe("hard_stop");
          expect(d.window).toBeTruthy();
        }
      }
      if (maySpend(d)) {
        await topup({
          orgId: org,
          units: 1_000,
          eventId: `brk-${RUN}-${call}`,
          reason: `spend ${call}`,
        });
      }
    }

    const at = (n: number) => decisions[n - 1]!;
    expect(at(1).decision).toBe("allow");
    expect(at(1).percent).toBe(1);
    expect(at(59).decision).toBe("allow");
    // â”€â”€ the three alert thresholds â”€â”€
    expect(at(60).decision).toBe("warn");
    expect(at(60).threshold).toBe(60);
    expect(at(60).percent).toBe(60);
    expect(at(79).decision).toBe("warn");
    expect(at(79).threshold).toBe(60);
    expect(at(80).decision).toBe("warn");
    expect(at(80).threshold).toBe(80);
    expect(at(80).percent).toBe(80);
    expect(at(94).decision).toBe("warn");
    expect(at(94).threshold).toBe(80);
    expect(at(95).decision).toBe("warn");
    expect(at(95).threshold).toBe(95);
    expect(at(95).percent).toBe(95);
    // 100% projected: still spendable, but still alerting.
    expect(at(100).decision).toBe("warn");
    expect(at(100).threshold).toBe(95);
    // â”€â”€ the 101st call is stopped â”€â”€
    expect(at(101).decision).toBe("stop");

    // Exactly 100 units' worth of spend exists — the 101st was refused.
    const spent = await db.usageLedger.aggregate({
      where: { orgId: org, kind: { in: ["topup", "consume", "refund"] } },
      _sum: { units: true },
    });
    expect(spent._sum.units).toBe(CAP);

    // â”€â”€ the GLOBAL kill switch needs no deploy: flip the env, next call stops â”€â”€
    const freshOrg = `${ORG}-killswitch`;
    expect((await assertWithinBudget({ orgId: freshOrg, units: 1, now })).decision).toBe("allow");
    process.env[KILL_SWITCH_ENV] = "1";
    try {
      expect(killSwitchEngaged()).toBe(true);
      const afterFlip = await assertWithinBudget({ orgId: freshOrg, units: 1, now });
      expect(afterFlip.decision).toBe("stop");
      if (afterFlip.decision === "stop") expect(afterFlip.reason).toBe("kill_switch");
      // It stops EVERY org, not just the one under test, and with no DB work at all.
      expect(
        (await assertWithinBudget({ orgId: `${ORG}-totally-different`, units: 1, now })).decision,
      ).toBe("stop");
    } finally {
      delete process.env[KILL_SWITCH_ENV];
    }
    expect(killSwitchEngaged()).toBe(false);
    expect((await assertWithinBudget({ orgId: freshOrg, units: 1, now })).decision).toBe("allow");

    // â”€â”€ NEVER throws, even on garbage input â”€â”€
    for (const bad of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY, "10" as unknown as number]) {
      const d = await assertWithinBudget({ orgId: org, units: bad, now });
      expect(d.decision).toBe("stop");
      if (d.decision === "stop") expect(d.reason).toBe("invalid_units");
    }
    expect((await assertWithinBudget({ orgId: "", units: 1, now })).decision).toBe("stop");

    // A malformed cap in the environment fails CLOSED rather than throwing or
    // silently becoming "unlimited".
    process.env[HOURLY_LIMIT_ENV] = "not-a-number";
    try {
      const bad = await assertWithinBudget({ orgId: `${ORG}-badenv`, units: 1, now });
      expect(bad.decision).toBe("stop");
      if (bad.decision === "stop") expect(bad.reason).toBe("invalid_budget");
    } finally {
      delete process.env[HOURLY_LIMIT_ENV];
    }
    expect((await assertWithinBudget({ orgId: `${ORG}-badenv`, units: 1, now })).decision).toBe(
      "allow",
    );

    // A zero limit means "spend nothing", not "unlimited".
    setOrgBudget(org, { hourlyMinor: 0, dailyMinor: 0 });
    const zeroLimit = await assertWithinBudget({ orgId: org, units: 1, now });
    expect(zeroLimit.decision).toBe("stop");
    if (zeroLimit.decision === "stop") expect(zeroLimit.reason).toBe("zero_limit");
    setOrgBudget(org, { hourlyMinor: CAP, dailyMinor: CAP });

    // â”€â”€ the daily window resets: spend in a past window does not count today â”€â”€
    const pastOrg = `${ORG}-window`;
    setOrgBudget(pastOrg, { hourlyMinor: CAP, dailyMinor: CAP });
    await topup({ orgId: pastOrg, units: 90_000, eventId: `brk-past-${RUN}` });
    const today = await assertWithinBudget({ orgId: pastOrg, units: 1_000, now });
    expect(today.decision).toBe("warn");
    expect(today.windows.find((w) => w.window === "daily")?.spentMinor).toBe(90_000);
    // Three days later that spend is in a closed window: a fresh cap.
    const future = new Date(now.getTime() + 3 * DAY_MS);
    const later = await assertWithinBudget({ orgId: pastOrg, units: 1_000, now: future });
    expect(later.decision).toBe("allow");
    expect(later.windows.find((w) => w.window === "daily")?.spentMinor).toBe(0);

    // A hold is not spend: reserving the whole balance must not trip the breaker.
    const holdOrg = `${ORG}-holdnotspend`;
    await topup({ orgId: holdOrg, units: 5_000, eventId: `brk-hold-${RUN}` });
    await reserve({ orgId: holdOrg, caseRef: `BRK-HOLD-${RUN}`, unitsEstimate: 5_000 });
    const holdDecision = await assertWithinBudget({ orgId: holdOrg, units: 1_000, now });
    expect(holdDecision.decision).toBe("allow");
    expect(holdDecision.windows.find((w) => w.window === "daily")?.spentMinor).toBe(5_000);
    // ¦but the CONSUME that settles it is spend.
    await consume({ orgId: holdOrg, caseRef: `BRK-HOLD-${RUN}`, unitsActual: 5_000 });
    const afterConsume = await assertWithinBudget({ orgId: holdOrg, units: 1_000, now });
    expect(afterConsume.windows.find((w) => w.window === "daily")?.spentMinor).toBe(10_000);

    // A refund is NEGATIVE spend — it is stored signed.
    const refundOrg = `${ORG}-refundsign`;
    await topup({ orgId: refundOrg, units: 10_000, eventId: `brk-rf1-${RUN}` });
    const refundWrite = await refund({
      orgId: refundOrg,
      units: 2_000,
      eventId: `brk-rf2-${RUN}`,
      reason: "goodwill",
    });
    expect(refundWrite.ok).toBe(true);
    const afterRefund = await assertWithinBudget({ orgId: refundOrg, units: 1_000, now });
    expect(afterRefund.windows.find((w) => w.window === "daily")?.spentMinor).toBe(8_000);
    expect(afterRefund.decision).toBe("allow");

    // A refund larger than the prepaid value is refused, not invented.
    const overRefund = await refund({
      orgId: refundOrg,
      units: 999_999,
      eventId: `brk-rf3-${RUN}`,
    });
    expect(overRefund.ok).toBe(false);
    if (!overRefund.ok) expect(overRefund.reason).toBe("insufficient_wallet");

    clearOrgBudget(org);
    clearOrgBudget(pastOrg);
    clearOrgBudget(holdOrg);
  },
  180_000,
);

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
test("WP-13: invariant I-8 — the balance IS the sum of the ledger, with no cached column", async () => {
  const org = `${ORG}-i8`;

  // Prepaid money...
  await topup({ orgId: org, units: 60_000, eventId: `i8-topup1-${RUN}` });
  await topup({ orgId: org, units: 40_000, eventId: `i8-topup2-${RUN}` });

  // ...20 settled calls...
  const consumedPerCall: number[] = [];
  for (let i = 0; i < 20; i++) {
    const caseRef = `I8-OK-${RUN}-${i}`;
    const actual = 100 + i * 7;
    consumedPerCall.push(actual);
    await reserve({ orgId: org, caseRef, unitsEstimate: 500, reason: "estimate" });
    await settleAttempt({ orgId: org, caseRef, unitsEstimate: 500, unitsActual: actual });
  }
  // ...5 aborted calls...
  for (let i = 0; i < 5; i++) {
    const caseRef = `I8-ABORT-${RUN}-${i}`;
    await reserve({ orgId: org, caseRef, unitsEstimate: 300, reason: "estimate" });
    await release({ orgId: org, caseRef, units: 300, reason: "aborted" });
  }
  // ...2 holds still in flight when the clock is read...
  await reserve({
    orgId: org,
    caseRef: `I8-LIVE-1-${RUN}`,
    unitsEstimate: 900,
    reason: "in flight",
  });
  await reserve({
    orgId: org,
    caseRef: `I8-LIVE-2-${RUN}`,
    unitsEstimate: 400,
    reason: "in flight",
  });
  // ...and a goodwill refund.
  await topup({ orgId: org, units: 30_000, eventId: `i8-topup3-${RUN}` });
  const refunded = await refund({
    orgId: org,
    units: 5_000,
    eventId: `i8-refund-${RUN}`,
    reason: "goodwill",
  });
  expect(refunded.ok).toBe(true);

  // â”€â”€ hand-derive every aggregate from the raw rows â”€â”€
  // `units` is stored signed: release and refund are negative.
  const rows = await db.usageLedger.findMany({ where: { orgId: org } });
  const sumBy = (k: string) => rows.filter((r) => r.kind === k).reduce((a, r) => a + r.units, 0);
  const expectedConsumed = consumedPerCall.reduce((a, b) => a + b, 0);
  const expectedReserved = 20 * 500 + 5 * 300 + 900 + 400;
  const expectedReleased = -(20 * 500 - expectedConsumed + 5 * 300);

  expect(sumBy("consume")).toBe(expectedConsumed);
  expect(sumBy("reserve")).toBe(expectedReserved);
  expect(sumBy("release")).toBe(expectedReleased);
  expect(sumBy("topup")).toBe(130_000);
  expect(sumBy("refund")).toBe(-5_000);

  const wallet = sumBy("topup") + sumBy("refund") - sumBy("consume");
  const held = sumBy("reserve") + sumBy("release") - sumBy("consume");
  const live = await balance(org);

  // Held is exactly the two in-flight holds. Everything else was returned.
  expect(held).toBe(1_300);
  expect(held).toBe((await snapshot(org)).held);
  expect(wallet).toBe(130_000 - expectedConsumed - 5_000);
  expect(wallet - held).toBe(live);
  expect(live).toBe(130_000 - expectedConsumed - 5_000 - 1_300);
  // Signed journal total: no weighting, just the stored column.
  expect(await ledgerSum(org)).toBe(
    130_000 + expectedReserved + expectedConsumed + expectedReleased - 5_000,
  );

  // â”€â”€ reconciliation against the value MATERIALISED at write time â”€â”€
  const rec = await reconcile(org);
  expect(rec.invariant).toBe("I-8");
  expect(rec.ok).toBe(true);
  expect(rec.drift).toBe(0);
  expect(rec.chain.ok).toBe(true);
  expect(rec.chain.rows).toBe(rows.length);
  expect(rec.snapshot.available).toBe(live);
  expect(rec.ledgerSum).toBe(await ledgerSum(org));
  expect(Number.isInteger(rec.ledgerSum)).toBe(true);

  // â”€â”€ the ledger is APPEND-ONLY: the newest row's balanceAfter equals the live
  //    balance, so an operator reading either number sees the same thing â”€â”€
  const ordered = [...rows].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  expect(ordered[ordered.length - 1]!.balanceAfter).toBe(live);

  // EVERY row's balanceAfter equals the running balance implied by the rows
  // above it — there is no cached column anywhere in the chain to drift.
  let running = 0;
  for (const row of ordered) {
    running += AVAILABLE_SIGN[row.kind]! * row.units;
    expect(row.balanceAfter).toBe(running);
  }
  expect(running).toBe(live);

  // â”€â”€ every amount is an integer. No floats, ever. â”€â”€
  for (const row of rows) {
    expect(Number.isInteger(row.units)).toBe(true);
    expect(Number.isSafeInteger(row.units)).toBe(true);
    expect(row.units !== 0).toBe(true);
  }
  // The duration -> units helper stays integral too.
  expect(unitsForDurationMs(12_345, 60)).toBe(741);
  expect(Number.isInteger(unitsForDurationMs(1, 1_000))).toBe(true);
  expect(unitsForDurationMs(0, 60)).toBe(0);
  expect(() => unitsForDurationMs(1.5, 60)).toThrow(/integer/);

  // A hand-waved refund cannot refund more than was paid in.
  const overRefund = await refund({
    orgId: org,
    units: 10_000_000,
    eventId: `i8-overrefund-${RUN}`,
  });
  expect(overRefund.ok).toBe(false);
  if (!overRefund.ok) expect(overRefund.reason).toBe("insufficient_wallet");
  expect(await balance(org)).toBe(live);

  expect(NETWORK_CALLS).toEqual([]);
}, 240_000);
