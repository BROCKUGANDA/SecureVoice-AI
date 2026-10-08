/**
 * The two telecom WEBHOOK routes: /api/twilio/status and
 * /api/twilio/inbound-voice.
 *
 * What is asserted, and why each one is load-bearing:
 *
 *   1. BOTH FAIL CLOSED. These routes write the compliance record and bridge
 *      live calls. An unsigned POST must not move either, and — the part a
 *      permissive route gets wrong — a deployment with no TWILIO_AUTH_TOKEN
 *      refuses too, rather than "logging and carrying on".
 *   2. A callback only ever touches the outbox. Case state belongs to the
 *      conversation plane and the dial worker; if a delivery report could mark a
 *      case verified, "the SMS was delivered" would become "the customer is
 *      legitimate", which is the false transition the single-writer rule exists
 *      to stop.
 *   3. The INBOUND tenant is the number the customer DIALLED. Not the caller's
 *      claim, not the platform default, and never a guess when the lookup fails.
 *   4. The case is looked up INSIDE that tenant. Two tenants can share a handset,
 *      so an unscoped lookup would read Bank B's alert onto Bank A's call — the
 *      cross-talk the outbound isolation gate cannot see.
 *   5. Unmapped provider statuses are accepted quietly. A 5xx makes Twilio
 *      re-send a report we will never understand, forever.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mock } from "bun:test";
import { NextRequest } from "next/server";

const updates: Record<string, unknown>[] = [];
const events: Record<string, unknown>[] = [];
const audits: Record<string, unknown>[] = [];
let orgByNumber: { id: string; name: string; institutionType: string } | null = null;
let orgLookupThrows = false;
let liveCase: { id: string; caseRef: string; state: string; language: string } | null = null;
let transferNumber: string | null = null;

mock.module("@/lib/telecom-outbox", () => ({
  recordTelecomEvent: async (args: Record<string, unknown>) => {
    events.push(args);
    return "te-1";
  },
  updateTelecomEvent: async (args: Record<string, unknown>) => {
    updates.push(args);
    return 1;
  },
  twilioMessageStatusToOurs: (raw: string | null) =>
    raw === "delivered" ? "delivered" : raw === "undelivered" ? "failed" : null,
  twilioCallStatusToOurs: (raw: string | null) =>
    raw === "completed"
      ? "delivered"
      : raw === "busy"
        ? "failed"
        : raw === "ringing"
          ? "queued"
          : null,
}));

mock.module("@/lib/audit-chain", () => ({
  append: async (entry: Record<string, unknown>) => {
    audits.push(entry);
    return { id: "a-1", chainHash: "h" };
  },
}));

mock.module("@/lib/institution", () => ({
  findOrgByVoiceNumber: async () => {
    if (orgLookupThrows) throw new Error("db down");
    return orgByNumber;
  },
  getTransferNumber: async () => transferNumber,
  getTelecomIdentity: async () => ({
    voiceNumber: null,
    smsSenderId: null,
    messagingServiceSid: null,
    elevenPhoneNumberId: null,
  }),
  getInstitutionContext: async () => ({ type: "bank", name: "Stanbic Bank" }),
  getInstitutionType: async () => "bank",
}));

// The case lookup is the scoped read this route exists to prove, so it is the
// one thing stubbed here: `where` is captured and asserted, not executed.
let caseWhere: Record<string, unknown> | null = null;
mock.module("@/lib/db", () => ({
  db: {
    case: {
      findFirst: ({ where }: { where: Record<string, unknown> }) => {
        caseWhere = where;
        return Promise.resolve(liveCase);
      },
    },
  },
}));

mock.module("@/lib/ratelimit", () => ({
  consume: () => ({ ok: true }),
  rateLimitId: (_req: unknown, kind: string) => `test-${kind}`,
}));

mock.module("@/lib/abuse/bad-actor", () => ({
  checkBadActor: () => ({ action: "allow" }),
  recordStrike: () => {},
}));

const PHONE = "+971501234567";
const LINE = "+15005550009";
const TOKEN = "test-auth-token";

function sign(url: string, params: Record<string, string>): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return createHmac("sha1", TOKEN).update(data).digest("base64");
}

function post(url: string, params: Record<string, string>, signature: string | null) {
  const body = new URLSearchParams(params).toString();
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(signature ? { "x-twilio-signature": signature } : {}),
    },
    body,
  });
}

const STATUS_URL = "https://securevoice.example.com/api/twilio/status";
const INBOUND_URL = "https://securevoice.example.com/api/twilio/inbound-voice";

describe("twilio status callback", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    saved.TWILIO_WEBHOOK_BASE_URL = process.env.TWILIO_WEBHOOK_BASE_URL;
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://securevoice.example.com";
    updates.length = 0;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("an unsigned callback writes nothing", async () => {
    const { POST } = await import("@/app/api/twilio/status/route");
    const res = await POST(
      post(STATUS_URL, { MessageSid: "SM1", Status: "delivered", From: LINE }, null),
    );
    expect(res.status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  test("no token configured is a refusal, not a pass", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const { POST } = await import("@/app/api/twilio/status/route");
    const res = await POST(
      post(STATUS_URL, { MessageSid: "SM1", Status: "delivered", From: LINE }, "whatever"),
    );
    expect(res.status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  test("a signed SMS report folds the row and keeps Twilio's own word", async () => {
    const params = { MessageSid: "SM1", Status: "delivered", From: LINE, To: PHONE };
    const { POST } = await import("@/app/api/twilio/status/route");
    const res = await POST(post(STATUS_URL, params, sign(STATUS_URL, params)));
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      providerSid: "SM1",
      status: "delivered",
      fromPhone: LINE,
      detail: { providerStatus: "delivered" },
    });
    // The answer is TwiML-shaped and empty: a status URL that returns real TwiML
    // is read as instructions for a call that has already ended.
    expect(await res.text()).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response/>`);
  });

  test("a call report maps by the CALL vocabulary, not the message one", async () => {
    const params = { CallSid: "CA1", CallStatus: "busy" };
    const { POST } = await import("@/app/api/twilio/status/route");
    const res = await POST(post(STATUS_URL, params, sign(STATUS_URL, params)));
    expect(res.status).toBe(200);
    expect(updates[0]).toMatchObject({ providerSid: "CA1", status: "failed" });
    // `busy` is Twilio's word for it; ours is `failed`. Both are recorded.
    expect((updates[0] as { detail: Record<string, string> }).detail.providerStatus).toBe("busy");
  });

  test("an unmapped status is accepted quietly and writes nothing", async () => {
    const params = { MessageSid: "SM2", Status: "some-new-upstream-word" };
    const { POST } = await import("@/app/api/twilio/status/route");
    const res = await POST(post(STATUS_URL, params, sign(STATUS_URL, params)));
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(0);
  });

  test("a delivery report never touches case state", async () => {
    // The property the header names. Asserted by absence of any import path that
    // could write it: the route module's only case-facing dependency is none.
    const src = await Bun.file("src/app/api/twilio/status/route.ts").text();
    expect(src).not.toContain("transitionCase");
    expect(src).not.toContain("case-state-machine");
  });
});

describe("twilio inbound voice", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    saved.TWILIO_WEBHOOK_BASE_URL = process.env.TWILIO_WEBHOOK_BASE_URL;
    saved.ELEVENLABS_INBOUND_SIP_URI = process.env.ELEVENLABS_INBOUND_SIP_URI;
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://securevoice.example.com";
    delete process.env.ELEVENLABS_INBOUND_SIP_URI;
    updates.length = 0;
    events.length = 0;
    audits.length = 0;
    orgByNumber = { id: "org-a", name: "Stanbic Bank", institutionType: "bank" };
    orgLookupThrows = false;
    liveCase = { id: "case-a", caseRef: "SV-F-ISO1", state: "UNREACHABLE", language: "sw" };
    transferNumber = null;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const inbound = async (params: Record<string, string>, signature: string | null) => {
    const { POST } = await import("@/app/api/twilio/inbound-voice/route");
    return POST(post(INBOUND_URL, params, signature));
  };

  test("unsigned is refused with no bridge", async () => {
    const res = await inbound({ To: LINE, From: PHONE, CallSid: "CA9" }, null);
    expect(res.status).toBe(403);
    expect(events).toHaveLength(0);
  });

  test("the tenant is whoever owns the number that was dialled", async () => {
    const params = { To: LINE, From: PHONE, CallSid: "CA9" };
    const res = await inbound(params, sign(INBOUND_URL, params));
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      orgId: "org-a",
      caseId: "case-a",
      channel: "voice",
      toPhone: LINE,
      fromPhone: PHONE,
      providerSid: "CA9",
    });
    expect(audits[0]).toMatchObject({ orgId: "org-a" });
  });

  test("the case lookup is scoped to the tenant, not just the handset", async () => {
    // Two tenants can share a number (a joint account holder, a recycled line).
    // An unscoped `where: { phone }` would pull Bank B's live alert onto Bank A's
    // call and read it out to them — the outbound isolation gate cannot see this.
    const params = { To: LINE, From: PHONE, CallSid: "CA9" };
    await inbound(params, sign(INBOUND_URL, params));
    expect(caseWhere).toMatchObject({ orgId: "org-a", phone: PHONE });
    expect(Object.keys(caseWhere ?? {})).toContain("state");
  });

  test("a number nobody owns is answered as nobody's", async () => {
    orgByNumber = null;
    const params = { To: "+15005550099", From: PHONE, CallSid: "CA9" };
    const res = await inbound(params, sign(INBOUND_URL, params));
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("Say");
    // No tenant means no outbox row and no case — and the audit row says so.
    expect(events).toHaveLength(0);
    expect(audits[0]).toMatchObject({ intent: "inbound_callback_unassigned_number" });
    expect(audits[0]!.orgId).toBeUndefined();
  });

  test("a tenant lookup that faults answers nothing about any tenant", async () => {
    orgLookupThrows = true;
    const params = { To: LINE, From: PHONE, CallSid: "CA9" };
    const res = await inbound(params, sign(INBOUND_URL, params));
    expect(res.status).toBe(200);
    const xml = await res.text();
    // The generic acknowledgement, in English, naming no institution: we do not
    // know whose line this is, and guessing is the cross-talk bug.
    expect(xml).not.toContain("Stanbic");
    expect(events).toHaveLength(0);
  });

  test("the customer's language is spoken back to them", async () => {
    const params = { To: LINE, From: PHONE, CallSid: "CA9" };
    const res = await inbound(params, sign(INBOUND_URL, params));
    const xml = await res.text();
    expect(xml).toContain('language="sw-KE"');
  });

  test("a human line is dialled from the tenant's number", async () => {
    transferNumber = "+15005550088";
    const params = { To: LINE, From: PHONE, CallSid: "CA9" };
    const xml = await (await inbound(params, sign(INBOUND_URL, params))).text();
    expect(xml).toContain("<Dial");
    expect(xml).toContain('callerId="' + LINE + '"');
    expect(xml).toContain("+15005550088");
  });

  test("the specialist being the line the customer dialled is a loop, not a bridge", async () => {
    transferNumber = LINE;
    const params = { To: LINE, From: PHONE, CallSid: "CA9" };
    const xml = await (await inbound(params, sign(INBOUND_URL, params))).text();
    expect(xml).not.toContain("<Dial");
    expect(xml).toContain("Say");
  });

  test("an agent SIP bridge keeps the customer's number as caller ID", async () => {
    process.env.ELEVENLABS_INBOUND_SIP_URI = "sip:agent@sip.elevenlabs.io";
    const params = { To: LINE, From: PHONE, CallSid: "CA9" };
    const xml = await (await inbound(params, sign(INBOUND_URL, params))).text();
    expect(xml).toContain("<Sip>sip:agent@sip.elevenlabs.io</Sip>");
    expect(xml).toContain(`callerId="${PHONE}"`);
  });

  test("a number that is not E.164 hangs up instead of being interpolated", async () => {
    const params = { To: LINE, From: "<script>1</script>", CallSid: "CA9" };
    const res = await inbound(params, sign(INBOUND_URL, params));
    const xml = await res.text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("script");
    expect(events).toHaveLength(0);
  });

  test("no live case is recorded against no case", async () => {
    liveCase = null;
    const params = { To: LINE, From: PHONE, CallSid: "CA9" };
    await inbound(params, sign(INBOUND_URL, params));
    expect(events[0]).toMatchObject({ orgId: "org-a", caseId: null });
    expect(audits[0]).toMatchObject({ intent: "inbound_callback_no_open_case" });
  });
});
