import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";

process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "test-secret";
const SECRET = process.env.WEBHOOK_SECRET!;

function signed(body: string): string {
  const t = Math.floor(Date.now() / 1000).toString();
  return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
}

function request(body: string): Request {
  return new Request("http://localhost/api/v1/interventions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sv-signature": signed(body),
      "idempotency-key": "signal-org-scope-test-0001",
    },
    body,
  });
}

const base = {
  transaction_ref: "TX-ORG-SCOPE-1",
  risk_score: 0.91,
  language: "en",
  phone: "+971500000123",
  currency: "AED",
  amount: 250000,
  merchant: "Test Merchant",
  consent_record_id: "CONSENT-ORG-SCOPE",
};

describe("HMAC ingest cannot select a tenant", () => {
  it("refuses org_id on the deployment-wide signature path", async () => {
    const { POST } = await import("@/app/api/v1/interventions/route");
    const body = JSON.stringify({ ...base, org_id: "victim-org" });
    const res = await POST(request(body) as never);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { code?: string; message?: string };
    expect(json.code).toBe("unauthenticated");
    expect(json.message ?? "").toContain("tenant-scoped producer key");
  });
});
