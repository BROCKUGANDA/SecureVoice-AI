/**
 * E2E — the dial worker must dial the number on the case row, never the
 * redaction placeholder in the job payload.
 *
 * THE DEFECT THIS EXISTS TO PREVENT. Ingest writes the dial payload as
 * `to: redactText(signal.phone)` — correct for an audit/display field, which is
 * what the payload is — and the worker read that same field as its dial
 * instruction. Every real outbound call therefore carried
 * `to_number: "[REDACTED]"` to the telephony provider and could not connect.
 *
 * WHY THE EXISTING GATE MISSED IT. `tests/e2e/dial.test.ts` runs with
 * ELEVENLABS_DRY_RUN=true, and in dry-run `placeOutboundCall` returns a
 * synthetic conversation id without ever looking at the destination. A gate that
 * never inspects the number cannot detect a corrupt number, so "the call was
 * placed" in dry-run is not evidence that "the call could be placed". This file
 * closes that exact hole: it stubs the provider at the seam and asserts the
 * digits that would have gone over the wire.
 *
 *   bun test tests/e2e/dial-worker-destination.test.ts
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.ELEVENLABS_DRY_RUN = "true";
process.env.WEBHOOK_SECRET ??= "test-secret";

/** What the provider would have been asked to dial. */
const captured: { toNumber: string | null } = { toNumber: null };

mock.module("@/lib/elevenlabs/outbound-call", () => ({
  firstMessageForLanguage: (lang: string) => `recorded AI security call in ${lang}`,
  placeOutboundCall: async (params: { toNumber: string }) => {
    captured.toNumber = params.toNumber;
    return { conversationId: "conv_stub_1", callSid: "CA_stub_1", dryRun: false };
  },
}));

const { handle } = await import("@/worker/dial");
const { db } = await import("@/lib/db");
const { createCase, transitionCase } = await import("@/lib/case-state-machine");

const REAL_NUMBER = "+971501234567";

function newCaseRef(): string {
  return `SV-F-${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

/** A job shaped exactly like the one ingest enqueues: `to` is the redacted value. */
function jobFor(caseRef: string, payloadTo: string) {
  return {
    id: `job_${randomUUID()}`,
    case_ref: caseRef,
    case_id: caseRef,
    attempt_no: 1,
    state: "PENDING",
    payload: JSON.stringify({
      to: payloadTo,
      language: "en",
      merchant: "Electronics World",
      amount: 250000,
      currency: "AED",
      transaction_ref: `TXN-${caseRef}`,
    }),
  } as never;
}

beforeEach(() => {
  captured.toNumber = null;
});

describe("the dial worker resolves its destination from the case row", () => {
  test("dials the case's E.164 number even though the payload says [REDACTED]", async () => {
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
    // The worker only dials a screened case; createCase lands in RECEIVED.
    await transitionCase(caseRef, "SCREENED");

    const outcome = await handle(jobFor(caseRef, "[REDACTED]"));

    expect(outcome.ok, `dial refused: ${(outcome as { error?: string }).error}`).toBe(true);
    // The whole point of the file: real digits reach the provider.
    expect(captured.toNumber).toBe(REAL_NUMBER);
    expect(captured.toNumber).toMatch(/^\+[1-9]\d{6,14}$/);
  });

  test("the redacted placeholder can never be dialled even if it is the only value present", async () => {
    // A case row with no phone at all: the payload's "[REDACTED]" must not be
    // treated as a fallback destination.
    const caseRef = newCaseRef();
    await createCase({
      caseRef,
      phone: null as unknown as string,
      amountMinor: 250000,
      currency: "AED",
      language: "en",
      riskScore: 0.9,
      transactionRef: `TXN-${caseRef}`,
      consentRecordId: `CONSENT-${caseRef}`,
    });

    const outcome = await handle(jobFor(caseRef, "[REDACTED]"));

    expect(outcome.ok).toBe(false);
    expect(captured.toNumber, "a redaction placeholder was dialled").toBeNull();
  });

  test("refuses a stored destination that is not a valid E.164 number", async () => {
    const caseRef = newCaseRef();
    await createCase({
      caseRef,
      phone: REAL_NUMBER,
      amountMinor: 250000,
      currency: "AED",
      language: "en",
      riskScore: 0.9,
      transactionRef: `TXN-${caseRef}`,
      consentRecordId: `CONSENT-${caseRef}`,
    });
    // A wrong destination means an unrelated customer receives a fraud call.
    await db.case.update({ where: { caseRef }, data: { phone: "0501234567" } });

    const outcome = await handle(jobFor(caseRef, "0501234567"));

    expect(outcome.ok).toBe(false);
    expect((outcome as { error?: string }).error).toContain("E.164");
    expect(captured.toNumber).toBeNull();
  });

  test("fails closed when the case row does not exist", async () => {
    const outcome = await handle(jobFor("SV-F-ZZZZZZ", "[REDACTED]"));
    expect(outcome.ok).toBe(false);
    expect(captured.toNumber).toBeNull();
  });

  test("does not re-dial a case that already has a conversation", async () => {
    const caseRef = newCaseRef();
    await createCase({
      caseRef,
      phone: REAL_NUMBER,
      amountMinor: 250000,
      currency: "AED",
      language: "en",
      riskScore: 0.9,
      transactionRef: `TXN-${caseRef}`,
      consentRecordId: `CONSENT-${caseRef}`,
    });
    await db.case.update({ where: { caseRef }, data: { conversationId: "conv_already" } });

    const outcome = await handle(jobFor(caseRef, "[REDACTED]"));

    // Recovery path: report success without placing a second call.
    expect(outcome.ok).toBe(true);
    expect(captured.toNumber, "a customer already on the phone was dialled again").toBeNull();
  });
});
