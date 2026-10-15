/**
 * E2E — the telephony breaker in the dial worker is real, not decorative.
 *
 * THE DEFECT THIS EXISTS TO PREVENT. `DEPENDENCIES` in
 * src/lib/failures/breaker.ts has declared "telephony" — with a fallback
 * ("telephony down → queue and alert") — since the module was written, and no
 * process ever created the instance. A declared dependency whose failure
 * counter nobody increments can never open: a dead carrier would be asked
 * again, once per queued job, forever, and anyone counting `DEPENDENCIES`
 * would have believed dispatch stops when it does not.
 *
 * WHAT IS ASSERTED. The wiring, not the state machine (the machine is pinned
 * by tests/unit/circuit-breaker.test.ts):
 *   1. five consecutive carrier refusals open the breaker;
 *   2. the next job is deferred with the fallback's Retry-After and the
 *      carrier is NOT contacted again — the refused provider is not asked to
 *      refuse a sixth time;
 *   3. a probe after the cooldown (modelled by the test seam) dials again.
 *
 *   bun test tests/e2e/dial-telephony-breaker.test.ts
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.ELEVENLABS_DRY_RUN = "true";
process.env.WEBHOOK_SECRET ??= "test-secret";

/** Controllable carrier stub: counts attempts, fails on demand. */
const carrier = { attempts: 0, failing: true };

mock.module("@/lib/elevenlabs/outbound-call", () => ({
  firstMessageForLanguage: (lang: string) => `recorded AI security call in ${lang}`,
  placeOutboundCall: async (_params: { toNumber: string }) => {
    carrier.attempts += 1;
    if (carrier.failing) {
      throw new Error("carrier refused (status 503): upstream unavailable");
    }
    return {
      conversationId: "conv_stub_1",
      callSid: "CA_stub_1",
      dryRun: false,
      phoneNumberId: null,
    };
  },
}));

const { handle, _resetDialTelephonyBreakerForTest, dialTelephonyBreakerState } =
  await import("@/worker/dial");
const { createCase, transitionCase } = await import("@/lib/case-state-machine");

const REAL_NUMBER = "+971501234567";

function newCaseRef(): string {
  return `SV-B-${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

function jobFor(caseRef: string) {
  return {
    id: `job_${randomUUID()}`,
    case_ref: caseRef,
    case_id: caseRef,
    attempt_no: 1,
    state: "PENDING",
    payload: JSON.stringify({
      to: "[REDACTED]",
      language: "en",
      merchant: "Electronics World",
      amount: 250000,
      currency: "AED",
      transaction_ref: `TXN-${caseRef}`,
    }),
  } as never;
}

/** A duffel-ready screened case the worker will actually try to dial. */
async function screenedCase(): Promise<string> {
  const caseRef = newCaseRef();
  await createCase({
    caseRef,
    phone: REAL_NUMBER,
    amountMinor: 250000,
    currency: "AED",
    merchant: "Electronics World",
    language: "en",
    riskScore: 0.93,
    transactionRef: `TXN-${caseRef}`,
    consentRecordId: `CONSENT-${caseRef}`,
  });
  await transitionCase(caseRef, "SCREENED");
  return caseRef;
}

beforeEach(() => {
  _resetDialTelephonyBreakerForTest();
  carrier.attempts = 0;
  carrier.failing = true;
});

describe("the telephony breaker is wired into the carrier path", () => {
  test("five carrier refusals open it, and the next job never reaches the carrier", async () => {
    // Five attempts, five refusals — each one recorded against the breaker.
    for (let i = 0; i < 5; i++) {
      const outcome = await handle(jobFor(await screenedCase()));
      expect(outcome.ok).toBe(false);
      expect((outcome as { retryable?: boolean }).retryable).toBe(true);
    }
    expect(carrier.attempts).toBe(5);
    expect(dialTelephonyBreakerState().state).toBe("open");

    // The sixth job is deferred: no sixth call to a carrier that is down, and
    // a Retry-After taken from the DECLARED fallback (60 s), not invented here.
    const ref = await screenedCase();
    const deferred = await handle(jobFor(ref));
    expect(deferred.ok).toBe(false);
    expect((deferred as { error?: string }).error).toContain("breaker");
    expect((deferred as { retryable?: boolean }).retryable).toBe(true);
    expect((deferred as { retryAfterMs?: number }).retryAfterMs).toBe(60_000);
    expect(carrier.attempts, "the carrier was asked to fail again").toBe(5);

    // The deferral is audited, not silent: the operator sees why calls stopped.
    // (Appends are fire-and-forget on the worker path, so give them a moment.)
    const { db } = await import("@/lib/db");
    const intents = async () =>
      (await db.auditLog.findMany({ where: { callRef: ref }, select: { intent: true } })).map(
        (r) => r.intent,
      );
    let seen = await intents();
    for (let i = 0; i < 20 && !seen.includes("dial_deferred_carrier_breaker"); i++) {
      await new Promise((r) => setTimeout(r, 50));
      seen = await intents();
    }
    expect(seen).toContain("dial_deferred_carrier_breaker");
  });

  test("after the cooldown the breaker admits a probe, and a healthy carrier closes it", async () => {
    // Open it first.
    for (let i = 0; i < 5; i++) {
      await handle(jobFor(await screenedCase()));
    }
    expect(dialTelephonyBreakerState().state).toBe("open");

    // The carrier recovers. The cooldown is modelled by the test seam rather
    // than by sleeping 60 s — the lifecycle itself is the unit gate's subject.
    carrier.failing = false;
    carrier.attempts = 0;
    _resetDialTelephonyBreakerForTest();

    const outcome = await handle(jobFor(await screenedCase()));
    expect(outcome.ok, `dial refused: ${(outcome as { error?: string }).error}`).toBe(true);
    expect(carrier.attempts).toBe(1);
    expect(dialTelephonyBreakerState().state).toBe("closed");
    expect(dialTelephonyBreakerState().consecutiveFailures).toBe(0);
  });
});
