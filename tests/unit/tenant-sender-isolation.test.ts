/**
 * TENANT SENDER ISOLATION — the telecom identity gate.
 *
 * Why this exists as its own file: "if Bank A's fraud alert goes out with Bank
 * B's phone number or name, you lose your B2B contract immediately." Everything
 * else in the tenancy suite proves that a READ cannot cross tenants. This proves
 * the outbound direction, which no read-scope guard can see: the number that
 * goes ON THE WIRE to a carrier.
 *
 * The properties asserted, each because its opposite is a real incident:
 *
 *   1. A tenant's Messaging Service sends with no `From` at all (Twilio rejects
 *      a request carrying both, and a `From` left in would override the tenant's
 *      own sender pool).
 *   2. A tenant's sender id, then the platform number — in that order, and only
 *      that order. Never another tenant's value.
 *   3. The voice leg uses the tenant's number, not the deployment default.
 *   4. FAIL CLOSED, NOT FALL BACK: when the tenant identity cannot be read, the
 *      send is refused and NOTHING reaches the carrier. This is the mutation
 *      proof for the whole file — a "convenient" fallback to the platform line
 *      would keep every other test here green while breaking the guarantee.
 *   5. A malformed stored number is refused, not dialled.
 *   6. A status callback URL is attached only when one is actually reachable,
 *      so the outbox is never promised a report that cannot arrive.
 *   7. The outbox row carries THIS tenant and THIS case.
 *
 * The carrier is stubbed at `fetch` and the tenant lookup is stubbed at the
 * module, so the assertions are about the request we build — never about a
 * handset. TWILIO_LIVE_SEND is set here deliberately; the live-fire gate is
 * tested in twilio-live-send-guard.test.ts and this file needs the gate open to
 * see what comes out the other side of it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";

type Sent = { url: string; params: URLSearchParams };

const TELECOM = {
  voiceNumber: null as string | null,
  smsSenderId: null as string | null,
  messagingServiceSid: null as string | null,
  elevenPhoneNumberId: null as string | null,
};
let identityThrows = false;
const outbox: Record<string, unknown>[] = [];

mock.module("@/lib/institution", () => ({
  getTelecomIdentity: async () => {
    if (identityThrows) throw new Error("db down");
    return { ...TELECOM };
  },
  getInstitutionContext: async () => ({ type: "bank", name: "Stanbic Bank" }),
  getInstitutionType: async () => "bank",
  getTransferNumber: async () => null,
  findOrgByVoiceNumber: async () => null,
  setInstitutionType: async () => ({ ok: true }),
}));

mock.module("@/lib/telecom-outbox", () => ({
  recordTelecomEvent: async (args: Record<string, unknown>) => {
    outbox.push(args);
    return "te-test-1";
  },
  updateTelecomEvent: async () => 1,
  twilioMessageStatusToOurs: (raw: string | null) => (raw === "delivered" ? "delivered" : null),
  twilioCallStatusToOurs: (raw: string | null) => (raw === "completed" ? "delivered" : null),
}));

const KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_LIVE_SEND",
  "TWILIO_WEBHOOK_BASE_URL",
  "APP_BASE_URL",
];

/** The deployment's own line — the identity a tenant WITHOUT numbers rides on. */
const PLATFORM_NUMBER = "+15005550006";

describe("tenant sender isolation", () => {
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  let sent: Sent[];

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    identityThrows = false;
    outbox.length = 0;
    for (const k of Object.keys(TELECOM)) TELECOM[k as keyof typeof TELECOM] = null;

    process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    process.env.TWILIO_FROM_NUMBER = PLATFORM_NUMBER;
    delete process.env.TWILIO_API_KEY_SID;
    delete process.env.TWILIO_API_KEY_SECRET;
    process.env.TWILIO_LIVE_SEND = "true";
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
    process.env.APP_BASE_URL = "http://localhost:3000";

    sent = [];
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      sent.push({
        url: String(input),
        params: new URLSearchParams(String(init?.body ?? "")),
      });
      return new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const sms = (over: Record<string, unknown> = {}) =>
    import("@/lib/twilio").then((m) =>
      m.sendInterventionSms({
        to: "+971501234567",
        lang: "en",
        caseRef: "SV-F-ISO1",
        kind: "unreachable",
        last4: "4242",
        orgId: "org-a",
        caseId: "case-a",
        ...over,
      }),
    );

  const call = (over: Record<string, unknown> = {}) =>
    import("@/lib/twilio").then((m) =>
      m.placeInterventionCall({
        to: "+971501234567",
        lang: "en",
        callRef: "SV-F-ISO1",
        orgId: "org-a",
        caseId: "case-a",
        ...over,
      }),
    );

  test("a tenant Messaging Service sends with NO From", async () => {
    TELECOM.messagingServiceSid = "MG10000000000000000000000000000001";
    TELECOM.smsSenderId = "+15005550009";
    const res = await sms();
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params.get("MessagingServiceSid")).toBe(TELECOM.messagingServiceSid);
    // The mutation proof for the mutual-exclusivity rule: a From here would
    // override the tenant's own sender pool.
    expect(sent[0]!.params.has("From")).toBe(false);
  });

  test("a tenant sender id is the From, and it is not the platform number", async () => {
    TELECOM.smsSenderId = "+15005550009";
    const res = await sms();
    expect(res.ok).toBe(true);
    expect(sent[0]!.params.get("From")).toBe("+15005550009");
    expect(sent[0]!.params.get("From")).not.toBe(PLATFORM_NUMBER);
  });

  test("no tenant identity rides the platform number", async () => {
    const res = await sms();
    expect(res.ok).toBe(true);
    expect(sent[0]!.params.get("From")).toBe(PLATFORM_NUMBER);
  });

  test("the voice leg dials from the tenant's number", async () => {
    TELECOM.voiceNumber = "+15005550009";
    const res = await call();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.from).toBe("+15005550009");
    expect(sent[0]!.params.get("From")).toBe("+15005550009");
  });

  test("a lookup fault refuses the send and reaches NO carrier", async () => {
    // The whole point. The lenient version of this function would return nulls
    // here, the message would send fine, and every delivery log would look
    // healthy while Bank A rang on a number that is not theirs.
    identityThrows = true;
    const s = await sms();
    const c = await call();
    expect(s.ok).toBe(false);
    expect(c.ok).toBe(false);
    if (!s.ok) expect(s.status).toBe(503);
    if (!c.ok) expect(c.status).toBe(503);
    expect(sent).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  test("a malformed tenant number is refused, not dialled", async () => {
    TELECOM.voiceNumber = "500-555-0009";
    const res = await call();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  test("no status callback for an origin Twilio cannot reach", async () => {
    await sms();
    await call();
    // APP_BASE_URL is localhost here: a callback URL the carrier cannot dial
    // would leave every row stuck at `queued` for a message that landed.
    expect(sent[0]!.params.has("StatusCallback")).toBe(false);
    expect(sent[1]!.params.has("StatusCallback")).toBe(false);
  });

  test("a reachable origin attaches the status callback on both channels", async () => {
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://securevoice.example.com";
    await sms();
    await call();
    expect(sent[0]!.params.get("StatusCallback")).toBe(
      "https://securevoice.example.com/api/twilio/status",
    );
    expect(sent[1]!.params.get("StatusCallback")).toBe(
      "https://securevoice.example.com/api/twilio/status",
    );
  });

  test("the outbox row carries this tenant, this case, and the number that went out", async () => {
    TELECOM.smsSenderId = "+15005550009";
    const res = await sms();
    expect(res.ok).toBe(true);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      orgId: "org-a",
      caseId: "case-a",
      channel: "sms",
      toPhone: "+971501234567",
      fromPhone: "+15005550009",
      providerSid: "SM1",
      status: "queued",
    });
  });

  test("a send with no case context writes no outbox row", async () => {
    // Not a gap in the record: a message nobody can attribute answers none of
    // the questions the outbox exists for, and the callers that have no context
    // are the ones that stub the carrier.
    await sms({ orgId: null, caseId: null });
    expect(sent).toHaveLength(1);
    expect(outbox).toHaveLength(0);
  });

  test("heads-up copy names the tenant's institution, not a bank", async () => {
    // The pre-notification promises a verification call. An insurer's message
    // that says "your bank" is the same class of mis-branding as a wrong number.
    const m = await import("@/lib/twilio");
    const bodyOf = (institution: "bank" | "insurer") =>
      m
        .sendInterventionSms({
          to: "+971501234567",
          lang: "en",
          caseRef: "SV-F-ISO2",
          kind: "heads_up",
          institution,
        })
        .then(() => sent.at(-1)!.params.get("Body"));
    expect(await bodyOf("bank")).toContain("your bank");
    expect(await bodyOf("insurer")).toContain("your insurer");
  });
});
