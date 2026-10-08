/**
 * THE ORPHAN WEBHOOK — a signed customer reply must not be able to land and be
 * dropped on the floor.
 *
 * Two URLs receive inbound SMS: /api/sms/inbound (the one in the operator's
 * webhook catalogue) and /api/twilio/sms-webhook. The second was added later,
 * verified Twilio's signature, LOGGED the reply and answered "accepted" — a
 * handler that pretends to have handled it. The incident it produces is silent
 * and total: an operator who configures the URL the route's own GET advertises
 * gets 200 OK in the Twilio console, zero errors in any log, and a fraud alert
 * that never closes. The customer texts NO, a human never queues, and the bank
 * is told nobody answered.
 *
 * So the properties asserted here are:
 *
 *   1. DELEGATION, NOT IMITATION. The reply goes to `handleSmsReply` — the one
 *      parser in the codebase — with the body EXACTLY as Twilio sent it. Any
 *      trimming, lower-casing or keyword list in this route would be a second
 *      parser, and two parsers diverge the day one is patched: a reply that
 *      resolves on one URL and is "unclear" on the other is unobservable from
 *      outside.
 *   2. ONE PARSER, ENFORCED STRUCTURALLY. The route may not contain reply
 *      vocabulary of its own, nor the placeholder comment that documented the
 *      gap instead of closing it.
 *   3. FAIL CLOSED, UNCHANGED. Not `true` from the signature check — including
 *      `null` for "no token configured" — is a 403 that reads nothing. This edit
 *      must not have traded a log-only route for a permissive real one, which
 *      is the classic way a stub fix becomes a case-integrity bug: unsigned,
 *      anyone could POST `Body=YES` and close a stranger's alert.
 *   4. THE ANSWER IS THE HANDLER'S TwiML. `reply: null` (a STOP) sends no
 *      message; a real reply is XML-escaped; a handler fault answers the safe
 *      sentence at 200 rather than 5xx, because Twilio retries a 5xx into the
 *      same fault while the customer's answer is lost.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

type SigVerdict = true | false | null;

const sig: {
  verdict: SigVerdict;
  calls: { url: string; params: Record<string, string>; header: string | null }[];
} = {
  verdict: true,
  calls: [],
};
const replies: {
  input: { from: string; body: string };
  result: { reply: string | null; outcome: string };
}[] = [];
const strikes: { key: string; weight: number }[] = [];
const errors: unknown[] = [];

let nextReply: { reply: string | null; outcome: string } = {
  reply: "Thank you.",
  outcome: "resolved_no",
};
let handlerThrows: Error | null = null;
let rateLimitOk = true;
let ipBlocked = false;

mock.module("@/lib/twilio", () => ({
  verifyTwilioSignature: (url: string, params: Record<string, string>, header: string | null) => {
    sig.calls.push({ url, params, header });
    return sig.verdict;
  },
  twilioSignedUrl: (req: { url: string }) => req.url,
  isE164: (v: unknown) => typeof v === "string" && /^\+\d{6,}$/.test(v),
  sendInterventionSms: async () => ({ ok: true, sid: "SM1" }),
  isTwilioConfigured: () => true,
}));

mock.module("@/lib/sms-verdict", () => ({
  handleSmsReply: async (input: { from: string; body: string }) => {
    if (handlerThrows) throw handlerThrows;
    replies.push({ input, result: nextReply });
    return nextReply;
  },
  sweepExpiredSmsCases: async () => 0,
}));

mock.module("@/lib/ratelimit", () => ({
  consume: () => ({ ok: rateLimitOk }),
  rateLimitId: (_req: unknown, kind: string) => `test-${kind}`,
}));

mock.module("@/lib/abuse/bad-actor", () => ({
  checkBadActor: () => (ipBlocked ? { action: "block" } : { action: "allow", strikes: 0 }),
  recordStrike: (key: string, weight: number) => {
    strikes.push({ key, weight });
    return { action: "allow", strikes: weight };
  },
}));

mock.module("@/lib/validation/safe-log", () => ({
  logInfo: () => {},
  logError: (message: string, meta?: unknown) => {
    errors.push({ message, meta });
  },
}));

const ROUTE_SOURCE = readFileSync(
  join(import.meta.dir, "..", "..", "src", "app", "api", "twilio", "sms-webhook", "route.ts"),
  "utf8",
);

const URL = "https://securevoice.example.com/api/twilio/sms-webhook";
const PHONE = "+971501234567";

function post(params: Record<string, string>, signature: string | null = "valid-sig") {
  return new NextRequest(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(signature ? { "x-twilio-signature": signature } : {}),
    },
    body: new URLSearchParams(params).toString(),
  });
}

/** POST the route and read the TwiML back. */
async function send(params: Record<string, string>, signature?: string | null) {
  const { POST } = await import("@/app/api/twilio/sms-webhook/route");
  const res = await POST(post(params, signature === undefined ? "valid-sig" : signature));
  return { status: res.status, body: await res.text(), type: res.headers.get("content-type") };
}

beforeEach(() => {
  sig.verdict = true;
  sig.calls.length = 0;
  replies.length = 0;
  strikes.length = 0;
  errors.length = 0;
  handlerThrows = null;
  rateLimitOk = true;
  ipBlocked = false;
  nextReply = { reply: "Thank you.", outcome: "resolved_no" };
});

describe("delegation: the webhook is a door, not a second brain", () => {
  test("a signed reply reaches THE reply handler and the verdict goes back to the customer", async () => {
    nextReply = { reply: "Thanks — a fraud specialist will review this.", outcome: "resolved_no" };
    const res = await send({ From: PHONE, Body: "not me", MessageSid: "SM1" });

    expect(replies).toHaveLength(1);
    expect(replies[0]!.input).toEqual({ from: PHONE, body: "not me" });
    expect(res.status).toBe(200);
    expect(res.body).toContain("a fraud specialist will review this");
  });

  test("the body is handed over UNNORMALISED — trimming here would be a second parser", async () => {
    // " yes! " resolves only through foldReply(). A route that pre-trimmed or
    // lower-cased would be asserting its own idea of normalisation, and the two
    // entry points would then disagree about what counts as an answer.
    await send({ From: PHONE, Body: "  YES!  " });
    expect(replies[0]!.input.body).toBe("  YES!  ");

    await send({ From: PHONE, Body: "" });
    expect(replies[1]!.input.body).toBe("");

    await send({ From: PHONE, Body: "STOP" });
    expect(replies[2]!.input.body).toBe("STOP");
  });

  test("the whole signed form is handed over, not a filtered copy", async () => {
    await send({ From: PHONE, Body: "no", MessageSid: "SM9", SmsSid: "SM9", AccountSid: "AC1" });
    expect(sig.calls[0]!.params).toMatchObject({
      From: PHONE,
      Body: "no",
      MessageSid: "SM9",
      AccountSid: "AC1",
    });
    expect(replies[0]!.input.from).toBe(PHONE);
  });

  test("the route contains NO reply vocabulary of its own", () => {
    // The structural half of "one parser, not two": the keyword sets that turn
    // text into a verdict live in src/lib/sms-verdict.ts and nowhere else.
    expect(ROUTE_SOURCE).toContain("handleSmsReply");
    for (const word of ["unsubscribe", "stopall", "unstop", "not me", "yes it was me", "nope"]) {
      expect(ROUTE_SOURCE.toLowerCase(), word).not.toContain(word);
    }
    expect(ROUTE_SOURCE).not.toMatch(/new Set\(\[/);
  });

  test("the log-only placeholder is gone, because the route now does the thing", () => {
    // A comment advertising a future implementation is how this route shipped as
    // a 200 OK that resolved nothing.
    expect(ROUTE_SOURCE).not.toMatch(/in a full implementation/i);
    expect(ROUTE_SOURCE).not.toMatch(/for the demo/i);
    // and it is not log-only: the handler's outcome decides the response.
    expect(ROUTE_SOURCE).toContain("return twiml(result.reply)");
  });
});

describe("signature verification stays fail-closed", () => {
  test("an unsigned reply resolves NOTHING", async () => {
    sig.verdict = false;
    const res = await send({ From: PHONE, Body: "NO" }, null);
    expect(res.status).toBe(403);
    expect(replies).toHaveLength(0);
    expect(strikes).toHaveLength(1);
  });

  test("no token to verify with refuses too — a null is not a pass", async () => {
    // The failure-open shape: `if (sig === false) refuse` lets `null`
    // ("TWILIO_AUTH_TOKEN is not configured") through, and then any reachable
    // URL closes any customer's alert.
    sig.verdict = null;
    const res = await send({ From: PHONE, Body: "YES" }, "whatever");
    expect(res.status).toBe(403);
    expect(replies).toHaveLength(0);
    expect(res.body).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response/>`);
  });

  test("verification is over the URL Twilio signed, the whole form and the header", async () => {
    await send({ From: PHONE, Body: "no" }, "sig-abc");
    expect(sig.calls).toHaveLength(1);
    expect(sig.calls[0]!.url).toBe(URL);
    expect(sig.calls[0]!.header).toBe("sig-abc");
  });

  test("a blocked source is refused before the form is read", async () => {
    ipBlocked = true;
    const res = await send({ From: PHONE, Body: "NO" });
    expect(res.status).toBe(403);
    expect(replies).toHaveLength(0);
    expect(sig.calls).toHaveLength(0);
  });

  test("over budget answers empty TwiML and resolves nothing", async () => {
    // Not a 429: Twilio retries a 429 too, and the retry hammering the case
    // lookup is what the budget exists to stop.
    rateLimitOk = false;
    const res = await send({ From: PHONE, Body: "NO" });
    expect(res.status).toBe(200);
    expect(res.body).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response/>`);
    expect(replies).toHaveLength(0);
  });
});

describe("the answer is TwiML the customer's handset can render", () => {
  test("an opt-out sends NO message back", async () => {
    // Silence is the contract: Twilio's own opt-out confirmation is the reply,
    // and a message we add on top re-texts a number that just asked us not to.
    nextReply = { reply: null, outcome: "stop" };
    const res = await send({ From: PHONE, Body: "STOP" });
    expect(res.body).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response/>`);
    expect(res.status).toBe(200);
  });

  test("every reply is answered as a Message in an XML document", async () => {
    nextReply = {
      reply: "Did you mean this card transaction? Reply YES or NO.",
      outcome: "invalid",
    };
    const res = await send({ From: PHONE, Body: "maybe" });
    expect(res.type).toBe("text/xml; charset=utf-8");
    expect(res.body).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>Did you mean this card transaction? Reply YES or NO.</Message></Response>`,
    );
  });

  test("reply copy cannot break out of the TwiML document", async () => {
    nextReply = { reply: `We <cannot> help "&today"`, outcome: "invalid" };
    const res = await send({ From: PHONE, Body: "asdf" });
    expect(res.body).toContain("&lt;cannot&gt;");
    expect(res.body).toContain("&amp;");
    expect(res.body).toContain("&quot;");
    expect(res.body).not.toContain("<cannot>");
  });

  test("a handler fault answers the safe sentence at 200 and leaks nothing", async () => {
    handlerThrows = new Error("PrismaClientKnownRequestError: P2022 `db.DoNotCall` does not exist");
    const res = await send({ From: PHONE, Body: "NO" });
    expect(res.status).toBe(200); // a 5xx would make Twilio retry into the same fault
    expect(res.body).toContain("could not process that");
    expect(res.body).toContain("call the number on your card");
    expect(res.body).not.toContain("Prisma");
    expect(res.body).not.toContain("P2022");
    expect(errors).toHaveLength(1);
  });

  test("a malformed body is refused without touching the handler", async () => {
    const { POST } = await import("@/app/api/twilio/sms-webhook/route");
    const broken = new NextRequest(URL, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=----x" },
      body: "not really a multipart body",
    });
    const res = await POST(broken);
    expect(res.status).toBe(400);
    expect(replies).toHaveLength(0);
  });
});
