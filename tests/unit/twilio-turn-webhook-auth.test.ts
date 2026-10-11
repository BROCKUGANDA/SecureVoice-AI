import { describe, expect, test } from "bun:test";
/**
 * `POST /api/twilio/turn` authenticates its caller, or refuses.
 *
 * This route receives the words a customer spoke during a live fraud call. Before
 * it failed closed, a deployment with `TWILIO_AUTH_TOKEN` unset accepted any
 * `SpeechResult` from anyone — the forged turn was then written to the
 * hash-chained audit log as something the customer said, and spent real LLM
 * budget. `verifyTwilioSignature()` returns `null` for exactly that
 * misconfiguration, and `null` is not "verified".
 *
 * The three sibling Twilio webhooks (`/status`, `/sms-webhook`,
 * `/inbound-voice`) already refused on anything other than `true`; this suite is
 * what keeps them from drifting apart again.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

const TOKEN = "unit-test-twilio-auth-token";
const TURN_URL = "https://turn.test/api/twilio/turn";

/** Twilio's scheme: HMAC-SHA1 over the URL plus the params sorted by name. */
function sign(params: Record<string, string>, token = TOKEN): string {
  const data =
    TURN_URL +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return createHmac("sha1", token).update(data).digest("base64");
}

async function call(params: Record<string, string>, signature: string | null) {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    host: "turn.test",
    "x-forwarded-proto": "https",
  };
  if (signature !== null) headers["x-twilio-signature"] = signature;
  const { POST } = await import("@/app/api/twilio/turn/route");
  const res = (await POST(
    new NextRequest(new Request(TURN_URL, { method: "POST", body, headers })),
  )) as Response;
  return { status: res.status, text: await res.text() };
}

/**
 * A turn with no recognised words answers with a re-ask and never reaches the
 * case table — the one branch that proves authentication was passed without
 * depending on a database.
 */
const NO_SPEECH = { CallSid: "CA_unit_turn", SpeechResult: "" };

const withToken = (fn: () => Promise<void>) => async () => {
  const prior = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  try {
    await fn();
  } finally {
    if (prior === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = prior;
  }
};

describe("twilio turn webhook authentication", () => {
  // The misconfiguration case, which used to be the open door.
  test(
    "refuses when TWILIO_AUTH_TOKEN is unset — an unverifiable signature is not an authenticated one",
    withToken(async () => {
      delete process.env.TWILIO_AUTH_TOKEN;
      // A signature computed with the right key still cannot be checked.
      const r = await call(NO_SPEECH, sign(NO_SPEECH));
      expect(r.status).toBe(403);
      expect(r.text).toContain("<Hangup/>");
    }),
  );

  test(
    "refuses a request with no signature header",
    withToken(async () => {
      const r = await call(NO_SPEECH, null);
      expect(r.status).toBe(403);
      expect(r.text).toContain("<Hangup/>");
    }),
  );

  test(
    "refuses a signature computed with the wrong key",
    withToken(async () => {
      const r = await call(NO_SPEECH, sign(NO_SPEECH, "not-the-account-token"));
      expect(r.status).toBe(403);
    }),
  );

  test(
    "refuses a signature valid for a different body",
    withToken(async () => {
      const forged = { ...NO_SPEECH, SpeechResult: "confirmed fraud" };
      const r = await call(forged, sign(NO_SPEECH));
      expect(r.status).toBe(403);
    }),
  );

  // The other direction: the check must not be a blanket refusal, or every real
  // caller would hang up and the gate would pass for the wrong reason.
  test(
    "accepts a correctly signed turn",
    withToken(async () => {
      const r = await call(NO_SPEECH, sign(NO_SPEECH));
      expect(r.status).toBe(200);
      expect(r.text).toContain("<Gather");
    }),
  );
});
