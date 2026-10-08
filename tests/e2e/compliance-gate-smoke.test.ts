import { expect, test } from "bun:test";

process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-secret";
process.env.TWILIO_DRY_RUN = "true";

test("compliance gate rejects routine outside calling hours", async () => {
  const { runComplianceGate } = await import("@/lib/compliance/gate");

  // Pick a deterministic time outside default business hours: 01:00 UTC.
  const outsideBusinessHours = new Date(Date.UTC(2026, 0, 1, 1, 0, 0)).getTime();

  const result = await runComplianceGate({
    callCategory: "routine",
    phone: "+14843040208",
    caseRef: "SMOKE-ROUTINE",
    callerId: "smoke",
    orgId: null,
    transactionRef: "tx-routine",
    redactedText: "[REDACTED_PHONE] tx-routine",
    atMs: outsideBusinessHours,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe("outside_calling_hours");
  }
});

test("compliance gate allows time_critical_fraud outside calling hours", async () => {
  const { runComplianceGate } = await import("@/lib/compliance/gate");

  const result = await runComplianceGate({
    callCategory: "time_critical_fraud",
    phone: "+14843040208",
    caseRef: "SMOKE-FRAUD",
    callerId: "smoke",
    orgId: null,
    transactionRef: "tx-fraud",
    redactedText: "[REDACTED_PHONE] tx-fraud",
  });

  expect(result.ok).toBe(true);
});
