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
import { NextRequest } from "next/server";
import type { POST as PilotPost } from "@/app/api/pilot/route";

const MARK = `pilot-${Date.now().toString(36)}`;
const NOTIFY_TO = `pilot-notify-${MARK}@nowhere.test`;

let POST: typeof PilotPost;

beforeAll(async () => {
  // The route reads PILOT_NOTIFY_EMAIL at call time, not import time, so setting it
  // here is enough — but it must be set before the handler runs.
  //
  // The handler now AWAITS its own queue insert and does no provider call, so
  // nothing here depends on a send succeeding: the row this file asserts IS the
  // notification, and delivery is the drain worker's job. APP_BASE_URL stays set
  // because the template renders its links from it whenever anything does send.
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.PILOT_NOTIFY_EMAIL = NOTIFY_TO;
  const mod = await import("@/app/api/pilot/route");
  POST = mod.POST;
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
      new NextRequest("http://localhost/api/pilot", {
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
        new NextRequest("http://localhost/api/pilot", {
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

  /**
   * The regression this pins: an unset variable used to mean NO email. The
   * enquiry was stored, the response was 200, the console listed it, and no mail
   * was ever sent — a lead is the one thing on this site with no second channel,
   * so "nobody configured the mailbox" has to mean the public support mailbox
   * rather than nobody.
   *
   * Found in production on 2026-10-14: PILOT_NOTIFY_EMAIL was absent from the
   * box's .env, so every pilot lead to date was a row and a lie.
   */
  test("an unset PILOT_NOTIFY_EMAIL falls back to the public support mailbox", async () => {
    // The expected address is read from the same module the route imports, so
    // this asserts the CONTRACT (falls back to the published support mailbox)
    // rather than hard-coding an address that a deployment may legitimately
    // override with NEXT_PUBLIC_SUPPORT_EMAIL.
    const { SUPPORT_EMAIL } = await import("@/lib/public-config");

    const previous = process.env.PILOT_NOTIFY_EMAIL;
    process.env.PILOT_NOTIFY_EMAIL = "";
    try {
      const mark = `${MARK}-fallback`;
      const res = await POST(
        new NextRequest("http://localhost/api/pilot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Ada Fallback",
            email: "ada-fallback@example.test",
            institution: `${mark} Mutual`,
          }),
        }),
      );
      expect(res.status).toBe(200);

      const { db } = await import("@/lib/db");
      // The control: the notification actually exists. Asserting only the 200
      // would pass against the old skip-the-email behaviour, which is exactly
      // what this file exists to catch.
      //
      // Scoped by this submission's own mark rather than "the newest row to that
      // mailbox". The test above sends to the same fallback address, and two rows
      // written in the same millisecond make a `createdAt: "desc"` pick arbitrary
      // — which is how this read green locally and red in CI on a fresh database.
      // A missing notification is still a null row, so the gate keeps its teeth.
      const row = await db.emailOutbox.findFirst({
        where: { toEmail: SUPPORT_EMAIL, kind: "pilot_request", subject: { contains: mark } },
      });
      expect(row).not.toBeNull();
      expect(row?.subject).toContain(mark);
    } finally {
      if (previous === undefined) delete process.env.PILOT_NOTIFY_EMAIL;
      else process.env.PILOT_NOTIFY_EMAIL = previous;
    }
  });
});
