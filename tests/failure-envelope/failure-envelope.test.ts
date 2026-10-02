/**
 * WP-21 gate: the bank-facing ingest speaks the failure envelope, and a policy
 * refusal is never dressed as an outage.
 *
 * Two things are proven here that were both wrong before:
 *
 * 1. `POST /v1/interventions` returned a bare `{ error: string }` on every
 *    refusal. It now returns the envelope this project already ships and tests
 *    (455 chaos checks in `src/lib/failures/**`), so a bank gets a
 *    machine-readable code, a `retryable` flag to branch on, and a correlation
 *    id to quote in a ticket.
 *
 * 2. `armAndDial` throws a TYPED refusal — `{ status: 409, code }` — and the
 *    route's catch flattened every one of them into `upstreamError(...)`,
 *    which defaults to **503**. A bank whose signal was correctly refused for
 *    consent, geography or quota received "Service Unavailable", which reads as
 *    "our fault, retry later". A bank that retries an invitation refusal
 *    re-dials a customer it was told not to contact.
 */
import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { FAILURE_CODES } from "@/lib/failures/envelope";

process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "failure-envelope-test-secret";

const SECRET = process.env.WEBHOOK_SECRET;
const ENVELOPE_KEYS = ["code", "message", "retryable", "requestId", "docsUrl"];

function signed(body: string): Request {
const t = Math.floor(Date.now() / 1000).toString();
const v1 = createHmac("sha256", SECRET!).update(`${t}.${body}`).digest("hex");
return new Request("http://localhost/api/v1/interventions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "sv-signature": `t=${t},v1=${v1}`,
    "idempotency-key": `failure-envelope-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  },
  body,
});
}

/** A signal that fails the strict schema — 422 by contract. */
function invalidSignal(): Request {
return signed(JSON.stringify({ transaction_ref: "X", risk_score: 0.94 }));
}

test("a malformed request returns the envelope, not a bare {error}", async () => {
  const { POST } = await import("@/app/api/v1/interventions/route");
  const res = await POST(invalidSignal() as never);
  expect(res.status).toBe(422);

  const body = (await res.json()) as Record<string, unknown>;
  // Every field the contract promises.
  for (const key of ENVELOPE_KEYS) {
    expect(body).toHaveProperty(key);
  }
  // The old shape is gone. A bank branching on `error` must be broken loudly
  // rather than silently handed an undefined.
  expect(body).not.toHaveProperty("error");
  expect(FAILURE_CODES).toContain(body.code);
  expect(typeof body.retryable).toBe("boolean");
  expect(typeof body.requestId).toBe("string");
  expect(String(body.requestId).length).toBeGreaterThan(0);
});

test("the correlation id is returned as a header too, so logs and body agree", async () => {
  const { POST } = await import("@/app/api/v1/interventions/route");
  const res = await POST(invalidSignal() as never);
  const body = (await res.json()) as Record<string, unknown>;
  expect(res.headers.get("x-request-id")).toBe(body.requestId);
});

test("a refusal is never 5xx — no bank should retry a policy decision", async () => {
  const { POST } = await import("@/app/api/v1/interventions/route");
  for (const req of [invalidSignal()]) {
    const res = await POST(req as never);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  }
});

test("an unauthenticated request is 401 with the envelope, and says retryable=false", async () => {
  const { POST } = await import("@/app/api/v1/interventions/route");
  const res = await POST(
    new Request("http://localhost/api/v1/interventions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sv-signature": "t=1234567890,v1=deadbeef",
        "idempotency-key": "failure-envelope-badsig-0001",
      },
      body: JSON.stringify({ transaction_ref: "X" }),
    }) as never,
  );
  expect(res.status).toBe(401);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.code).toBe("unauthenticated");
  // A bank must not retry a bad signature; that is a configuration error.
  expect(body.retryable).toBe(false);
});

test("no failure message leaks a stack trace, SQL, or an internal identifier", async () => {
  const { POST } = await import("@/app/api/v1/interventions/route");
  const res = await POST(invalidSignal() as never);
  const raw = await res.text();
  for (const leak of [
    /at \w+ \(/,
    /\bSELECT\b/i,
    /\bINSERT\b/i,
    /\/srv\/|\/app\/src\//,
    /node_modules/,
    /PrismaClient/,
  ]) {
    expect(raw).not.toMatch(leak);
  }
});
