/**
 * Deaf / hard-of-hearing ingest flag → SMS-only flow, no voice dial.
 *
 * When a bank flags `hearing_impaired: true` on the risk signal, the platform
 * must skip voice ENTIRELY: no dial job is enqueued, the case goes straight to
 * the blind-ping SMS flow, and the audit chain records the true reason instead
 * of a fabricated voice failure.
 *
 *   bun test tests/e2e/hearing-impaired-sms-only.test.ts
 *
 * Needs the same harness as tests/e2e/dial.test.ts: a test database, dry-run
 * telephony, and the abuse-gate fixture (test numbers, geo allowlist, credits).
 */
import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { db } from "@/lib/db";

process.env.ELEVENLABS_DRY_RUN = "true";
process.env.ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID ?? "agent_test";
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-secret";

const SECRET = process.env.WEBHOOK_SECRET;

async function fixture() {
  const { setOrgTestNumbers } = await import("@/lib/abuse/tiers");
  setOrgTestNumbers("unscoped", ["+971500000901", "+971500000902", "+971500000903"]);
  const { setOrgGeoPolicy } = await import("@/lib/abuse/geo");
  setOrgGeoPolicy("unscoped", { allowlist: ["AE"] });
  const { setAbuseConfig } = await import("@/lib/abuse/config");
  setAbuseConfig({
    velocity: { burstRateMax: 100, newPrefixBurst: 100, afterHoursWarn: 100, afterHoursPause: 100 },
  });
  const { topup } = await import("@/lib/billing/ledger");
  await topup({
    orgId: "unscoped",
    units: 100,
    eventId: `hi-topup-${Date.now()}`,
    reason: "gate fixture",
  });
}

function signBody(body: string): string {
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac("sha256", SECRET!).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function makeRequest(body: Record<string, unknown>, idempotencyKey: string): Request {
  const raw = JSON.stringify(body);
  return new Request("http://localhost/api/v1/interventions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sv-signature": signBody(raw),
      "idempotency-key": idempotencyKey,
    },
    body: raw,
  });
}

function baseSignal(transactionRef: string, phone: string): Record<string, unknown> {
  return {
    transaction_ref: transactionRef,
    risk_score: 0.94,
    language: "en",
    phone,
    currency: "AED",
    amount: 250000,
    merchant: "Electronics World",
    consent_record_id: "CONSENT-HI-001",
  };
}

test("hearing_impaired: true skips voice entirely and goes SMS-only", async () => {
  await fixture();
  const { POST } = await import("@/app/api/v1/interventions/route");
  const ref = `HI-SMS-${Date.now()}`;
  const res = await POST(
    makeRequest({ ...baseSignal(ref, "+971500000901"), hearing_impaired: true }, `hi-${ref}`),
  );
  expect(res.status).toBe(202);
  const data = (await res.json()) as {
    status: string;
    caseRef: string;
    smsOnly?: { reason: string; sent: boolean };
  };
  expect(data.status).toBe("sms_only");
  expect(data.smsOnly?.reason).toBe("hearing_impaired");
  // Dry-run still runs the whole state path: stamped, not sent.
  expect(data.smsOnly?.sent).toBe(true);

  // The case exists and is UNREACHABLE — never DIALING.
  const row = await db.case.findFirst({
    where: { caseRef: data.caseRef },
    select: { state: true },
  });
  expect(row?.state).toBe("UNREACHABLE");

  // No dial job was enqueued for this case. Voice was never attempted.
  const jobs = (await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "dial_job" WHERE "case_ref" = $1`,
    data.caseRef,
  )) as { n: number }[];
  expect(jobs[0]?.n).toBe(0);

  // The chain tells the truth: received, screened, sms_only — no voice failure.
  const trail = await db.auditLog.findMany({
    where: { callRef: data.caseRef },
    select: { intent: true },
  });
  const intents = trail.map((r) => r.intent);
  expect(intents).toContain("hearing_impaired_sms_only");
  expect(intents.join(" ")).not.toContain("dial");
});

test("hearing_impaired as a string is rejected, not coerced", async () => {
  await fixture();
  const { POST } = await import("@/app/api/v1/interventions/route");
  const ref = `HI-STR-${Date.now()}`;
  const res = await POST(
    makeRequest({ ...baseSignal(ref, "+971500000902"), hearing_impaired: "yes" }, `hi-str-${ref}`),
  );
  // Strict schema: a string where a boolean belongs is a 422, the same as any
  // other mistyped field. Coercing "yes" to true would let a producer's typo
  // silently suppress a voice call on a fraud case.
  expect(res.status).toBe(422);
});

test("absent flag keeps the voice path — sms_only is opt-in, not default", async () => {
  await fixture();
  const { POST } = await import("@/app/api/v1/interventions/route");
  const ref = `HI-ABS-${Date.now()}`;
  const res = await POST(makeRequest(baseSignal(ref, "+971500000903"), `hi-abs-${ref}`));
  expect(res.status).toBe(202);
  const data = (await res.json()) as { status: string; caseRef: string };
  expect(data.status).not.toBe("sms_only");
  expect(typeof data.caseRef).toBe("string");
});
