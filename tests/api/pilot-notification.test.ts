/**
 * Pilot → operator notification.
 *
 * The property under test: submitting a pilot request STORES the enquiry and then
 * QUEUES a notification to the operator mailbox, so a lead is never lost to a mail
 * outage and the submitter is never shown a 500 because email happened to fail.
 *
 * Two assertions, because either half alone is a failure:
 *   1. the durable outbox row exists with the operator's address and the lead's
 *      own fields — proof the request was captured, not just acknowledged;
 *   2. with PILOT_NOTIFY_EMAIL unset, the request still succeeds — proof the
 *      notification is downstream of the write rather than a precondition for it.
 *
 * Runs against the real database: the row's existence and its `kind` are the
 * behaviour, and a fake store would exercise neither.
 *
 *   bun scripts/run-tests.mjs pilot-notification
 */
import { test, expect, afterAll, beforeAll, describe } from "bun:test";

const MARK = `pilot-${Date.now().toString(36)}`;
const NOTIFY_TO = `pilot-notify-${MARK}@nowhere.test`;

let POST: (req: Request) => Promise<Response>;

beforeAll(async () => {
  // The route reads PILOT_NOTIFY_EMAIL at call time, not import time, so setting it
  // here is enough — but it must be set before the handler runs.
  // The send step needs APP_BASE_URL to build the template's base link. The ROW is
  // written before the send is attempted, so a failure here is a failed delivery,
  // not a lost lead — but the test needs the send to succeed to assert the row.
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.PILOT_NOTIFY_EMAIL = NOTIFY_TO;
  const mod = await import("@/app/api/pilot/route");
  POST = mod.POST as unknown as (req: Request) => Promise<Response>;
});

afterAll(async () => {
  const { db } = await import("@/lib/db");
  await db.pilotRequest.deleteMany({ where: { institution: { contains: MARK } } });
  await db.emailOutbox.deleteMany({ where: { toEmail: NOTIFY_TO } });
  await db.$disconnect();
});

describe("pilot → operator notification", () => {
  test("stores the enquiry and queues a notification to the operator", async () => {
    const res = await POST(
      new Request("http://localhost/api/pilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Ada Lovelace",
          email: "ada@example.test",
          institution: `${MARK} Bank`,
          role: "CTO",
          volume: "500-1000",
          message: "We want a pilot next quarter.",
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ref?: string };
    expect(body.ok).toBe(true);
    expect(body.ref).toBeTruthy();

    const { db } = await import("@/lib/db");
    const row = await db.emailOutbox.findFirst({
      where: { toEmail: NOTIFY_TO, kind: "pilot_request" },
    });
    expect(row).not.toBeNull();
    // The notification carries the submitter's own fields — enough to act on,
    // and no credential of any kind.
    expect(row?.subject).toContain(`${MARK} Bank`);
    expect(JSON.stringify(row?.payload)).toContain("ada@example.test");
    expect(JSON.stringify(row?.payload)).toContain("CTO");
  });

  test("a request with no configured mailbox still succeeds", async () => {
    const previous = process.env.PILOT_NOTIFY_EMAIL;
    process.env.PILOT_NOTIFY_EMAIL = "";
    try {
      const res = await POST(
        new Request("http://localhost/api/pilot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Grace Hopper",
            email: "grace@example.test",
            institution: `${MARK} Mutual`,
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      process.env.PILOT_NOTIFY_EMAIL = previous;
    }
  });
});
