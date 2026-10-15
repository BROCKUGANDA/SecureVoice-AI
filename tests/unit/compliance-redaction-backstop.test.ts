/**
 * UNIT — rule 4's redaction backstop on the inbound signal
 * (`src/lib/compliance/gate.ts`).
 *
 * The gate has always claimed to verify "the signal payload has been PII-redacted
 * before persistence", and it did, by asking whether text the caller had already
 * run through the redactor still contained the phone number. The production caller
 * redacts before it calls, so the comparison could not come out any way except
 * clean: a control that reports the same answer whatever happened upstream.
 *
 * The backstop now reads the bank's RAW `transaction_ref` and asks whether redaction
 * would change it. It records rather than refuses, because the failure mode being
 * guarded is a producer logging a credential-bearing reference, not a reason to
 * leave a live fraud unaddressed — so the tests below assert both halves of that
 * decision: the observation happens, and the call still goes out.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { runComplianceGate } from "@/lib/compliance/gate";

const RUN = `redbackstop${Date.now().toString(36).slice(-6)}`;
const PHONE = "+971509990011";

async function gate(rawRef: string) {
  return runComplianceGate({
    callCategory: "time_critical_fraud",
    phone: PHONE,
    caseRef: `CASE-${RUN}`,
    callerId: `caller-${RUN}`,
    orgId: null,
    transactionRef: rawRef,
    transactionRefRaw: rawRef,
  });
}

let envBackup: string | undefined;

beforeAll(() => {
  envBackup = process.env.PRAYER_GATE_ENABLED;
  // The fraud category is exempt from the Salah window already; this is belt and
  // braces so a misconfigured gate cannot turn these into network calls.
  process.env.PRAYER_GATE_ENABLED = "false";
});

afterAll(() => {
  if (envBackup === undefined) delete process.env.PRAYER_GATE_ENABLED;
  else process.env.PRAYER_GATE_ENABLED = envBackup;
});

test("a credential-shaped reference is recorded, and the intervention still proceeds", () => {
  // A 16-digit PAN in the reference field. The bank should not send this; the
  // platform should see it and must still place the call.
  return Promise.all(
    ["4111 1111 1111 1111", "4111111111111111", "ref 4111-1111-1111-1111 end", "123-45-6789"].map(
      async (raw) => {
        const r = await gate(raw);
        expect({ raw, ok: r.ok, backstop: r.ok && r.redactionBackstop === true }).toEqual({
          raw,
          ok: true,
          backstop: true,
        });
      },
    ),
  );
});

test("an ordinary reference trips nothing", async () => {
  for (const raw of ["TXN-2026-000918", "9b4c1d2e", "", "INV 4471 / UAE"]) {
    const r = await gate(raw);
    expect({ raw, ok: r.ok, backstop: r.ok ? r.redactionBackstop : "refused" }).toEqual({
      raw,
      ok: true,
      backstop: undefined,
    });
  }
});

test("the old tautology is gone: redacting first is no longer the only thing checked", async () => {
  // This is the shape the previous code received from its own caller — text the
  // route had already run through the redactor. It must still pass, but now because
  // the RAW field was examined too, not because nothing could have failed. (The
  // redacted text deliberately omits the phone: including it would trip the
  // separate mismatch refusal above, which is that check working, not this one.)
  const r = await runComplianceGate({
    callCategory: "time_critical_fraud",
    phone: PHONE,
    caseRef: `CASE-${RUN}-b`,
    callerId: `caller-${RUN}`,
    orgId: null,
    transactionRef: "4111 1111 1111 1111",
    redactedText: "[REDACTED_PAN] (caller on file)",
    transactionRefRaw: "4111 1111 1111 1111",
  });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  expect(r.redactionBackstop).toBe(true);
});

test("a redactor that changes nothing is not treated as a hit", async () => {
  // Guards the comparison itself: if the check became `if (rawRef)` it would fire
  // on every request and the signal would be worthless.
  const clean = await gate("PAYSTACK-CHARGE-8821");
  expect(clean.ok && clean.redactionBackstop).toBe(undefined);
});
