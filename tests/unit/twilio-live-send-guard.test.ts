/**
 * The Twilio live-fire attestation.
 *
 * Added after a latency gate that POSTs twenty fraud signals through
 * `/api/v1/interventions` turned out to send twenty real `Messages` requests to
 * api.twilio.com. Nothing was delivered (Twilio refused each with 21408), but
 * the account was charged the attempt and the test suite had reached a carrier
 * — which no test should be able to do by accident.
 *
 * The bug was not the new call site. It was that `sendInterventionSms` and
 * `placeInterventionCall` would put a request on the wire for anyone who could
 * import them, with credentials as the only precondition. Voice was safe only
 * because `ELEVENLABS_DRY_RUN` happens to sit upstream of it.
 *
 * So the guard is at `twilioPost`, the one choke point both kinds pass through,
 * and it is default-deny: a deployment states `TWILIO_LIVE_SEND=true` to say
 * this account may reach real handsets.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_LIVE_SEND",
] as const;

describe("Twilio live-fire attestation", () => {
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  let requests: { url: string; body: string }[];

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    requests = [];
    // Throwaway credentials, deliberately shaped like the real ones: the guard
    // must not be a "are the keys fake?" check. It is an attestation check.
    process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    process.env.TWILIO_FROM_NUMBER = "+15550000000";
    delete process.env.TWILIO_API_KEY_SID;
    delete process.env.TWILIO_API_KEY_SECRET;
    delete process.env.TWILIO_LIVE_SEND;
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") });
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

  test("an unattested account sends no SMS, and asks for nothing on the wire", async () => {
    const { sendInterventionSms } = await import("@/lib/twilio");
    const res = await sendInterventionSms({
      to: "+971501234567",
      lang: "en",
      caseRef: "SV-F-ABC123",
      kind: "heads_up",
    });

    expect(res.ok).toBe(false);
    expect(requests).toHaveLength(0);
    // The refusal has to be actionable: an operator reading it must know which
    // switch to throw, and that throwing it means real customer messages.
    if (!res.ok) {
      expect(res.error).toContain("TWILIO_LIVE_SEND");
      expect(res.error).toMatch(/real (calls|SMS)/);
    }
  });

  test("an unattested account places no call either", async () => {
    const { placeInterventionCall } = await import("@/lib/twilio");
    const res = await placeInterventionCall({
      to: "+971501234567",
      lang: "en",
      amount: "AED 2,500",
      merchant: "Electronics World",
    });

    expect(res.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  // The mutation proof. Without this pair the tests above would also pass if
  // `twilioPost` were deleted, or if the guard refused unconditionally — a
  // default-deny gate that never opens is indistinguishable from a broken one.
  test("attesting opens the gate: the SMS and the call both reach the carrier", async () => {
    process.env.TWILIO_LIVE_SEND = "true";
    const { placeInterventionCall, sendInterventionSms } = await import("@/lib/twilio");

    const sms = await sendInterventionSms({
      to: "+971501234567",
      lang: "en",
      caseRef: "SV-F-ABC123",
      kind: "heads_up",
    });
    expect(sms.ok).toBe(true);

    const call = await placeInterventionCall({
      to: "+971501234567",
      lang: "en",
      amount: "AED 2,500",
      merchant: "Electronics World",
    });
    expect(call.ok).toBe(true);

    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toContain("/Messages.json");
    expect(requests[1]!.url).toContain("/Calls.json");
  });

  test("the attestation is read per request, so it cannot leak between tests", async () => {
    process.env.TWILIO_LIVE_SEND = "true";
    const { sendInterventionSms } = await import("@/lib/twilio");

    await expect(
      sendInterventionSms({
        to: "+971501234567",
        lang: "en",
        caseRef: "SV-F-ONE",
        kind: "heads_up",
      }),
    ).resolves.toMatchObject({ ok: true });

    delete process.env.TWILIO_LIVE_SEND;
    await expect(
      sendInterventionSms({
        to: "+971501234567",
        lang: "en",
        caseRef: "SV-F-TWO",
        kind: "heads_up",
      }),
    ).resolves.toMatchObject({ ok: false });

    // One send on the wire, not two: the second was refused before the request.
    expect(requests).toHaveLength(1);
  });

  test("a malformed attestation is not a yes", async () => {
    // Only the exact string opens the gate. `1`/`true`-with-space/`TRUE` are the
    // shapes an operator reaches for when a send silently does nothing, and each
    // one must fail closed rather than be interpreted charitably.
    for (const value of ["1", "TRUE", "true ", " yes", "on"]) {
      process.env.TWILIO_LIVE_SEND = value;
      const { sendInterventionSms } = await import("@/lib/twilio");
      const res = await sendInterventionSms({
        to: "+971501234567",
        lang: "en",
        caseRef: `SV-F-${value.trim() || "empty"}`,
        kind: "heads_up",
      });
      expect(res.ok, `TWILIO_LIVE_SEND=${JSON.stringify(value)} must not open the gate`).toBe(
        false,
      );
    }
    expect(requests).toHaveLength(0);
  });

  test("an invalid destination is refused before the attestation is consulted", async () => {
    // Ordering matters for the audit trail: a bad number must report as a bad
    // number whichever way the account is configured, otherwise a deployment
    // that has not attested yet learns the wrong reason for a real defect.
    process.env.TWILIO_LIVE_SEND = "true";
    const { sendInterventionSms } = await import("@/lib/twilio");
    const res = await sendInterventionSms({
      to: "not-a-phone",
      lang: "en",
      caseRef: "SV-F-BAD",
      kind: "heads_up",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(422);
    expect(requests).toHaveLength(0);
  });
});
