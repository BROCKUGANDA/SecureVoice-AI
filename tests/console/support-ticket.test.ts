/**
 * GATE — POST /api/support/ticket records an operator's problem report and
 * delivers it over the existing Resend path.
 *
 * The user asked for exactly this shape: "a POST /api/support/ticket over your
 * existing Resend path with PII scrubbing applied to the free-text field, plus
 * a link from the Command Center — and it inherits the redaction guarantee
 * rather than inventing a support_tickets table."
 *
 * What is asserted here, and why each can actually FAIL:
 *
 *   1. The message is SCRUBBED BEFORE IT IS PERSISTED. The EmailOutbox row is
 *      the durable artifact and the thing a retry re-renders from — if the raw
 *      text landed there, a PAN or an SSN would sit in the database and go out
 *      again on every retry. The assertion is on the ROW, not the response, so
 *      it holds regardless of what the handler claims.
 *   2. orgId comes from the SESSION, never the body. A body-supplied orgId is
 *      ignored; the durable row carries the profile's org. A route that read
 *      the body for its tenant would let any signed-in user file a ticket
 *      attributed to someone else's organisation.
 *   3. The row goes to the published support mailbox with kind support_ticket —
 *      proof the EXISTING Resend/outbox path is used and not a parallel one.
 *   4. Unauthenticated → 401, invalid payloads → 422/400, and with mail unarmed
 *      the route answers 503 rather than promising a delivery that cannot
 *      happen.
 *   5. The rate limit is per operator and actually bites on the 11th request.
 *
 * Environment: a real remote Postgres (DATABASE_URL). The session is MOCKED at
 * the `getProfile` seam — the same discipline tests/console/setup.test.ts and
 * tests/console/fire.test.ts document — and the provider is mocked at
 * `@/lib/email/resend`, because no test may dial Resend.
 *
 *   bun test tests/console/support-ticket.test.ts
 */
import { afterAll, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import * as realCredits from "@/lib/credits";
import { _reset as resetRateLimits } from "@/lib/ratelimit";
import { SUPPORT_EMAIL } from "@/lib/public-config";

const MARK = `support-${Date.now().toString(36)}`;

const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000042";

const session = { signedIn: true };

mock.module("@/lib/credits", () => ({
  ...realCredits,
  getProfile: async () =>
    session.signedIn
      ? {
          userId: USER_ID,
          email: "operator@example.test",
          name: "Ada Lovelace",
          role: "operator" as const,
          orgId: ORG,
          credits: 500,
        }
      : null,
}));

/**
 * The provider seam. `emailArmed` is mutable so one test can prove the 503 —
 * a deployment without RESEND_API_KEY must refuse, not promise a delivery it
 * cannot make. The send is captured so a test can assert the FIRST attempt
 * also carried the scrubbed text, not just the persisted row.
 */
let emailArmed = true;
let lastSend: { to: string; subject: string; kind: string; props: Record<string, unknown> } | null =
  null;

mock.module("@/lib/email/resend", () => ({
  isEmailConfigured: () => emailArmed,
  sendQueuedEmail: async (input: {
    to: string;
    subject: string;
    kind: string;
    props: Record<string, unknown>;
  }) => {
    lastSend = input;
    return { ok: true as const, id: `test-${MARK}` };
  },
}));

const { POST } = await import("@/app/api/support/ticket/route");

const TIMEOUT_MS = 60_000;

function post(body: unknown) {
  return POST(
    new NextRequest(
      new Request("http://localhost/api/support/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    ),
  );
}

afterAll(async () => {
  await db.emailOutbox.deleteMany({
    where: { kind: "support_ticket", payload: { contains: MARK } },
  });
  await db.$disconnect();
  mock.restore();
});

test(
  "a signed-in report is scrubbed before it is persisted, and carries the session's org",
  async () => {
    const rawMessage =
      `Charge failed in ${MARK}. Card 4111 1111 1111 1111 was charged twice, ` +
      `SSN 123-45-6789 is on file, call back +971501234567.`;

    const res = await post({ message: rawMessage, interventionRef: "CASE-20261012-AB12" });
    expect(res.status).toBe(202);

    const body = (await res.json()) as {
      data: { ref: string; orgId: string | null; delivery: string };
    };
    expect(body.data.ref).toMatch(/^SV-S-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    expect(body.data.delivery).toBe("sent");
    expect(body.data.orgId).toBe(ORG);

    // The durable row IS the record (there is no support_tickets table), so the
    // scrubbing guarantee lives or dies on what this row contains.
    const row = await db.emailOutbox.findFirst({
      where: { kind: "support_ticket", payload: { contains: body.data.ref } },
    });
    expect(row).not.toBeNull();
    expect(row?.toEmail).toBe(SUPPORT_EMAIL);
    expect(row?.orgId).toBe(ORG);
    expect(row?.subject).toContain(body.data.ref);

    const payload = JSON.stringify(row?.payload);
    expect(payload).toContain("[REDACTED_PAN]");
    expect(payload).toContain("[REDACTED_SSN]");
    expect(payload).toContain("[REDACTED_PHONE]");
    // The raw identifiers must appear NOWHERE on the durable path.
    expect(payload).not.toContain("4111");
    expect(payload).not.toContain("123-45-6789");
    expect(payload).not.toContain("971501234567");

    // And the first send attempt carried the same scrubbed text.
    expect(lastSend?.kind).toBe("support_ticket");
    expect(String(lastSend?.props.message)).toContain("[REDACTED_PAN]");
    expect(String(lastSend?.props.interventionRef)).toBe("CASE-20261012-AB12");
    expect(String(lastSend?.props.operatorEmail)).toBe("operator@example.test");
  },
  TIMEOUT_MS,
);

test(
  "an orgId in the body is ignored — the session decides the tenant",
  async () => {
    const res = await post({
      message: `${MARK} please check this, the freeze failed.`,
      orgId: "99999999-0000-4000-8000-000000000999",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { ref: string; orgId: string | null } };
    expect(body.data.orgId).toBe(ORG);

    const row = await db.emailOutbox.findFirst({
      where: { kind: "support_ticket", payload: { contains: body.data.ref } },
    });
    expect(row?.orgId).toBe(ORG);
    expect(JSON.stringify(row?.payload)).not.toContain("99999999-0000-4000-8000-000000000999");
  },
  TIMEOUT_MS,
);

test("a report without an intervention ref still lands", async () => {
  const res = await post({ message: `${MARK} general feedback about the console layout.` });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { data: { ref: string } };
  const row = await db.emailOutbox.findFirst({
    where: { kind: "support_ticket", payload: { contains: body.data.ref } },
  });
  expect(row).not.toBeNull();
  const props = JSON.parse(String(row?.payload)) as { interventionRef: string | null };
  expect(props.interventionRef).toBeNull();
});

test(
  "invalid payloads are refused with machine-readable codes",
  async () => {
    // Too short to be a report.
    const short = await post({ message: "no" });
    expect(short.status).toBe(422);
    expect(((await short.json()) as { code?: string }).code).toBe("semantically_invalid");

    // Missing entirely.
    expect((await post({ interventionRef: "CASE-1" })).status).toBe(422);

    // Free text where an identifier belongs — a pasted phone number is the
    // realistic mistake, and it must be refused, not silently carried.
    const ref = await post({
      message: `${MARK} valid length message here.`,
      interventionRef: "+971 50 123 4567",
    });
    expect(ref.status).toBe(422);

    // Not JSON at all.
    expect((await post("this is not json")).status).toBe(400);
  },
  TIMEOUT_MS,
);

test(
  "mail unarmed: refuse with 503 and write nothing",
  async () => {
    emailArmed = false;
    try {
      const before = await db.emailOutbox.count({ where: { kind: "support_ticket" } });
      const res = await post({ message: `${MARK} this must not be queued anywhere.` });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { message?: string }).message).toContain("not configured");
      const after = await db.emailOutbox.count({ where: { kind: "support_ticket" } });
      expect(after).toBe(before);
    } finally {
      emailArmed = true;
    }
  },
  TIMEOUT_MS,
);

test("a signed-out caller gets 401, and nothing is written", async () => {
  session.signedIn = false;
  try {
    const before = await db.emailOutbox.count({ where: { kind: "support_ticket" } });
    const res = await post({ message: `${MARK} anonymous report attempt.` });
    expect(res.status).toBe(401);
    const after = await db.emailOutbox.count({ where: { kind: "support_ticket" } });
    expect(after).toBe(before);
  } finally {
    session.signedIn = true;
  }
});

test("the rate limit bites on the 11th report in an hour", async () => {
  // A fresh bucket, so this test does not depend on how many requests the
  // tests above happened to spend. Capacity is 10/hour per operator.
  resetRateLimits();

  for (let i = 0; i < 10; i++) {
    const res = await post({ message: `${MARK} burst report number ${i} with content.` });
    if (res.status !== 202) {
      throw new Error(`report ${i} was refused with ${res.status} before the budget ran out`);
    }
  }
  const eleventh = await post({ message: `${MARK} the eleventh report in the same hour.` });
  expect(eleventh.status).toBe(429);
  expect(eleventh.headers.get("Retry-After")).toBeTruthy();
}, 120_000);
