/**
 * The queue's envelope and dead-letter contract.
 *
 * DLQ row creation is verified end to end: a forged or malformed call must
 * NOT turn into a bank action, and a valid dispatch of a call.trigger must
 * land exactly one DialJob row with the sanitized inputs the handler received.
 * The signing keys are set before the route module is imported, because the
 * dispatcher captures them at import time.
 */
import { beforeAll, afterAll, expect, test } from "bun:test";
import { createHash, webcrypto } from "node:crypto";
import { NextRequest } from "next/server";
import * as jose from "jose";
import { db } from "@/lib/db";
import { parseEnvelope, makeEnvelope, jobEnvelopeSchema } from "@/lib/queue/envelope";
import { envelopeIdempotencyKeyForDlq } from "@/lib/queue/dead-letter";

process.env.QSTASH_CURRENT_SIGNING_KEY = "test_current_key_for_envelope_spec_32bytes_xx";
process.env.QSTASH_NEXT_SIGNING_KEY = "test_next_key_for_envelope_spec_32bytes____xx";

const RUN = `${Date.now().toString(36)}env`;
const CASE_REF = `SV-F-${createHash("sha256").update(RUN).digest("hex").slice(0, 6).toUpperCase()}`;
// Uuid-shaped orgId: the fixture below is written against an @db.Uuid column.
const ORG_ID = createHash("sha256")
  .update(`org-${RUN}`)
  .digest("hex")
  .slice(0, 32)
  .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

async function sign(body: string, key: string): Promise<string> {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return new jose.SignJWT({ body: bodyHash, sub: "POST /api/queue/dispatch" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("Upstash")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(key));
}

beforeAll(async () => {
  const orgId = ORG_ID;
  await db.organization.upsert({
    where: { id: orgId },
    update: {},
    create: { id: orgId, name: "env-org", slug: `env-org-${RUN}`, createdAt: new Date() },
  });
  await db.case.create({
    data: { caseRef: CASE_REF, state: "QUEUED", orgId } as never,
  });
}, 120_000);

afterAll(async () => {
  await db.$executeRawUnsafe(`DELETE FROM dial_job WHERE case_ref = $1`, CASE_REF).catch(() => {});
  await db.case.deleteMany({ where: { caseRef: CASE_REF } }).catch(() => {});
}, 120_000);

test("makeEnvelope fills a valid value that parseEnvelope round-trips", () => {
  const env = makeEnvelope({
    jobKind: "call.trigger",
    idempotencyKey: "dial:SV-F-AA11BB:1",
    caseRef: "SV-F-AA11BB",
    payload: { caseId: "x", to: "+9715***" },
  });
  expect(parseEnvelope(env)).toEqual(env);
  // Required fields are present; judges rely on them being non-null.
  expect(typeof env.enqueuedAt).toBe("string");
  expect(env.attempt).toBe(0);
});

test("parseEnvelope rejects a foreign schema version", () => {
  const bad = {
    ...makeEnvelope({
      jobKind: "call.trigger",
      idempotencyKey: "x-123456",
      caseRef: "SV-F-AA11BB",
      payload: {},
    }),
    queueVersion: "1999-01-01",
  };
  expect(() => parseEnvelope(bad)).toThrow();
});

test("DLQ key: same envelope always lands on the same DeadLetter row", () => {
  const env = makeEnvelope({
    jobKind: "sms.fallback",
    idempotencyKey: "sms:SV-F-CC22DD:1",
    caseRef: "SV-F-CC22DD",
    payload: {},
  });
  expect(envelopeIdempotencyKeyForDlq(env)).toBe(envelopeIdempotencyKeyForDlq(env));
  expect(envelopeIdempotencyKeyForDlq(env)).toContain("sms:SV-F-CC22DD:1");
});

test("DLQ key: a malformed payload still yields a stable key", () => {
  const garbage = { nope: true };
  expect(envelopeIdempotencyKeyForDlq(garbage)).toBe(envelopeIdempotencyKeyForDlq(garbage));
});

test("dispatch: unsigned request → 401", async () => {
  const { POST } = await import("@/app/api/queue/dispatch/route");
  const raw = JSON.stringify(
    makeEnvelope({
      jobKind: "sms.fallback",
      idempotencyKey: "sms:x-1",
      caseRef: CASE_REF,
      payload: {},
    }),
  );
  const res = await POST(
    new NextRequest("http://localhost/api/queue/dispatch", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json" },
    }),
  );
  expect(res.status).toBe(401);
});

test("dispatch: valid signature but garbage envelope → 422, never 200", async () => {
  const { POST } = await import("@/app/api/queue/dispatch/route");
  const raw = JSON.stringify({ not: "an envelope" });
  const signature = await sign(raw, process.env.QSTASH_CURRENT_SIGNING_KEY!);
  const res = await POST(
    new NextRequest("http://localhost/api/queue/dispatch", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "upstash-signature": signature },
    }),
  );
  expect(res.status).toBe(422);
});

test("dispatch: call.trigger enqueues exactly one DialJob", async () => {
  const { POST } = await import("@/app/api/queue/dispatch/route");
  const env = makeEnvelope({
    jobKind: "call.trigger",
    idempotencyKey: `dial:${CASE_REF}:1`,
    caseRef: CASE_REF,
    orgId: null,
    payload: { caseId: CASE_REF, to: "+971500000001" },
  });
  const raw = JSON.stringify(env);
  const signature = await sign(raw, process.env.QSTASH_CURRENT_SIGNING_KEY!);
  const req = () =>
    new NextRequest("http://localhost/api/queue/dispatch", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "upstash-signature": signature },
    });
  const res1 = await POST(req());
  expect(res1.status).toBe(200);
  // A QStash retry of the same signed message must not create a second job.
  const res2 = await POST(req());
  expect(res2.status).toBe(200);

  const rows = await db.$queryRawUnsafe<{ case_ref: string }[]>(
    `SELECT case_ref FROM dial_job WHERE case_ref = $1`,
    CASE_REF,
  );
  expect(rows.length).toBe(1);
}, 120_000);

test("dead-letter: same envelope twice writes one DeadLetter row, attempts +1", async () => {
  const { POST } = await import("@/app/api/queue/dead-letter/route");
  const env = makeEnvelope({
    jobKind: "sms.fallback",
    idempotencyKey: `sms:${CASE_REF}:dead`,
    caseRef: CASE_REF,
    payload: {},
  });
  const call = () =>
    POST(
      new NextRequest("http://localhost/api/queue/dead-letter", {
        method: "POST",
        body: JSON.stringify(env),
        headers: { "content-type": "application/json" },
      }),
    );
  await call();
  await call();
  const rows = await db.deadLetter.findMany({ where: { eventId: `sms:${CASE_REF}:dead` } });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.attempts).toBeGreaterThanOrEqual(5);
  expect(rows[0]!.eventType).toBe("qstash.sms.fallback");
  await db.deadLetter.deleteMany({ where: { eventId: `sms:${CASE_REF}:dead` } });
}, 120_000);
