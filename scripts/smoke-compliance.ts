import { runComplianceGate } from "../src/lib/compliance/gate";

const caseRef = "SMOKE-" + Date.now();

const routine = await runComplianceGate({
  callCategory: "routine",
  phone: "+14843040208",
  caseRef,
  callerId: "smoke-test",
  orgId: null,
  transactionRef: "tx-routine",
  redactedText: "[REDACTED_PHONE] tx-routine",
});

const fraud = await runComplianceGate({
  callCategory: "time_critical_fraud",
  phone: "+14843040208",
  caseRef: caseRef + "-fraud",
  callerId: "smoke-test",
  orgId: null,
  transactionRef: "tx-fraud",
  redactedText: "[REDACTED_PHONE] tx-fraud",
});

console.log("routine=", JSON.stringify(routine));
console.log("fraud=", JSON.stringify(fraud));
