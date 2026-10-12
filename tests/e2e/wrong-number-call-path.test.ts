/**
 * A STRANGER ANSWERS THE FRAUD CALL — the live turn, end to end.
 *
 * `src/lib/voice/wrong-number.ts` shipped 66 unit tests for a detector nothing on
 * the call path ever called. Its own header states why that is not a neutral gap:
 * the opening script has already recited merchant and amount, so every sentence
 * after "that's not my number" is a disclosure of one customer's financial data to
 * whoever picked up, on a recorded line, in a jurisdiction whose PDPL makes that
 * the bank's problem. Detection that runs after the LLM turn is detection that
 * costs the disclosure it exists to prevent — so this suite drives the real
 * `POST /api/twilio/turn` and asserts what the caller HEARD, on the case row, and
 * in the chain.
 *
 * The three properties that make this a safety control rather than a classifier:
 *
 *   1. NOTHING IS DISCLOSED. The refusal line contains no merchant, no amount, no
 *      card digits and no case reference — and the response carries no digits at
 *      all, which is stronger than auditing a field list.
 *   2. NOTHING IS FROZEN. A wrong number is a denial-of-service on the fraud
 *      programme if treated as a fraud signal: anyone could freeze any card by
 *      answering the phone and saying four words. The audit row must carry
 *      `freezeStaged: false`, and the case must never visit FREEZE_STAGED.
 *   3. A LOW-CONFIDENCE IDENTIFY QUESTION IS NOT A WRONG NUMBER. "Who is this?" is
 *      what a real cardholder asks in the first ten seconds; hanging up on it
 *      loses the customer the product exists to serve.
 *
 * Real database, real hash chain, real Twilio signature verification. Only the LLM
 * drafter is replaced — the wrong-number path must never reach it, and the
 * continues-the-call case would otherwise spend a provider request.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

process.env.ELEVENLABS_DRY_RUN = "true";

const drafted: string[] = [];
mock.module("@/lib/llm", () => ({
  draftAgentReply: async (args: { text: string }) => {
    drafted.push(args.text);
    return null;
  },
}));

const { db } = await import("@/lib/db");
const { createCase, transitionCase } = await import("@/lib/case-state-machine");

const TOKEN = "wrong-number-turn-test-token";
const TURN_URL = "https://turn.test/api/twilio/turn";

function sign(params: Record<string, string>): string {
  const data =
    TURN_URL +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return createHmac("sha1", TOKEN).update(data).digest("base64");
}

async function turn(params: Record<string, string>) {
  const body = new URLSearchParams(params);
  const { POST } = await import("@/app/api/twilio/turn/route");
  const res = await POST(
    new NextRequest(
      new Request(TURN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "turn.test",
          "x-forwarded-proto": "https",
          "x-twilio-signature": sign(params),
        },
        body,
      }),
    ),
  );
  return { status: res.status, text: await res.text() };
}

const created: { caseRef: string; callSid: string }[] = [];

async function dialingCase(opts: { callSid: string; language?: string }) {
  const caseRef = `SV-WN-${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  await createCase({
    caseRef,
    orgId: null,
    phone: "+971501234567",
    amountMinor: 250_000,
    currency: "AED",
    merchant: "Electronics World",
    language: opts.language ?? "en",
    riskScore: 0.93,
    transactionRef: `TXN-${caseRef}`,
    consentRecordId: `CONSENT-${caseRef}`,
    cardLast4: "4242",
    signalKind: "card_transaction",
  });
  await transitionCase(caseRef, "SCREENED");
  await transitionCase(caseRef, "DIALING");
  await db.case.update({ where: { caseRef }, data: { callSid: opts.callSid } });
  created.push({ caseRef, callSid: opts.callSid });
  return caseRef;
}

async function stateOf(caseRef: string): Promise<string> {
  const row = await db.case.findUnique({ where: { caseRef }, select: { state: true } });
  return row?.state ?? "";
}

async function auditFor(caseRef: string, intent: string) {
  return db.auditLog.findFirst({ where: { callRef: caseRef, intent } });
}

beforeEach(() => {
  drafted.length = 0;
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
});

afterAll(async () => {
  const refs = created.map((c) => c.caseRef);
  await db.outboxEvent.deleteMany({ where: { caseRef: { in: refs } } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { callRef: { in: refs } } }).catch(() => {});
  await db.case.deleteMany({ where: { caseRef: { in: refs } } }).catch(() => {});
});

const WRONG = "this is not my number";
const WRONG_LINE = "I am sorry, this is the wrong number";

describe("a stranger picks up", () => {
  test("the call ends on the refusal line, with the case closed and nothing frozen", async () => {
    const callSid = `CA_${randomUUID().slice(0, 8)}`;
    const caseRef = await dialingCase({ callSid });

    const res = await turn({ CallSid: callSid, SpeechResult: WRONG, To: "+971800123456" });

    expect(res.status).toBe(200);
    expect(res.text).toContain(WRONG_LINE);
    expect(res.text).toContain("<Hangup/>");
    // The disclosure stops here: no further Gather, so no further questions to
    // answer with the cardholder's details.
    expect(res.text).not.toContain("<Gather");

    // Nothing about the transaction is repeated to whoever answered.
    expect(res.text).not.toContain("Electronics World");
    expect(res.text).not.toContain("2500");
    expect(res.text.replace(/<[^>]+>/g, "")).not.toMatch(/[0-9]/);

    expect(drafted, "a wrong number still spent an LLM round trip").toHaveLength(0);
    // The closure path this route applies runs DIALING → UNREACHABLE → NOTIFIED →
    // CLOSED: the machine has no edge from a dialling case straight to a terminal
    // state, so the states it passes through are the ones this call did actually
    // reach (dialled, answered by a stranger, notified, closed) rather than a
    // forced write the single writer would refuse.
    expect(await stateOf(caseRef)).toBe("CLOSED");

    const audit = await auditFor(caseRef, "wrong_number_detected");
    expect(audit, "the closure was not written to the chain").not.toBeNull();
    const meta = JSON.parse(String(audit?.meta)) as Record<string, unknown>;
    expect(meta.freezeStaged).toBe(false);
    expect(meta.escalated).toBe(false);
    expect(meta.actionable).toBe(true);

    const visited = await db.auditLog.findMany({
      where: { callRef: caseRef, intent: { contains: "freeze" } },
    });
    expect(visited, "a stranger's four words froze a card").toHaveLength(0);
  });

  test("a busy cardholder asking for a call-back is recorded, not closed", async () => {
    const callSid = `CA_${randomUUID().slice(0, 8)}`;
    const caseRef = await dialingCase({ callSid });

    const res = await turn({ CallSid: callSid, SpeechResult: "call me back tomorrow" });

    expect(res.text).toContain("I will not keep you");
    // The scripted line ASKS whether tomorrow suits. Hanging up on the question
    // would be the platform refusing to hear what it invited, so one turn stays
    // open while the case is already recorded as notified.
    expect(res.text).toContain("<Gather");

    expect(await stateOf(caseRef)).toBe("NOTIFIED");
    const audit = await auditFor(caseRef, "callback_requested");
    expect(audit).not.toBeNull();
    const meta = JSON.parse(String(audit?.meta)) as Record<string, unknown>;
    expect(meta.freezeStaged).toBe(false);
    expect(meta.callbackWhen).toBe("tomorrow");
  });

  test("the detection is spoken in the caller's language", async () => {
    const callSid = `CA_${randomUUID().slice(0, 8)}`;
    await dialingCase({ callSid, language: "ar" });

    const res = await turn({
      CallSid: callSid,
      SpeechResult: "هذا ليس رقمي",
      lang: "ar",
    });

    expect(res.text).toContain("هذا رقم غير صحيح");
    expect(res.text).not.toContain(WRONG_LINE);
    expect(res.text).not.toContain("Electronics World");
  });
});

describe("what is NOT a wrong number", () => {
  test("an identity question continues the call and is recorded as inconclusive", async () => {
    const callSid = `CA_${randomUUID().slice(0, 8)}`;
    const caseRef = await dialingCase({ callSid });

    const res = await turn({ CallSid: callSid, SpeechResult: "who is this?" });

    // "Who is this?" is the first thing a real cardholder says. Acting on it would
    // hang up on the customer the call exists for.
    expect(res.text).not.toContain(WRONG_LINE);
    expect(res.text).toContain("<Gather");
    expect(await stateOf(caseRef)).toBe("DIALING");

    const audit = await auditFor(caseRef, "wrong_number_not_conclusive");
    expect(audit).not.toBeNull();
    const meta = JSON.parse(String(audit?.meta)) as Record<string, unknown>;
    expect(meta.actionable).toBe(false);
  });

  test("an ordinary denial is still a fraud denial, not a wrong number", async () => {
    const callSid = `CA_${randomUUID().slice(0, 8)}`;
    await dialingCase({ callSid });

    const res = await turn({ CallSid: callSid, SpeechResult: "that was not me at all" });

    expect(res.text).not.toContain(WRONG_LINE);
    // The speech path carries on: the scripted/LLM reply for `deny_fraud`.
    expect(res.text).toContain("fraud");
  });
});

describe("authentication is unchanged by the new path", () => {
  test("a forged wrong-number turn is refused before anything is closed", async () => {
    const callSid = `CA_${randomUUID().slice(0, 8)}`;
    const caseRef = await dialingCase({ callSid });

    // Signed over `this is not my number`, delivered as something else. Without
    // verification anyone could close any case by POSTing four words to a public
    // URL — the same reason the sibling webhooks fail closed.
    const signed = { CallSid: callSid, SpeechResult: WRONG };
    const forged = { CallSid: callSid, SpeechResult: "wrong number, close this case" };

    const { POST } = await import("@/app/api/twilio/turn/route");
    const res = await POST(
      new NextRequest(
        new Request(TURN_URL, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: "turn.test",
            "x-forwarded-proto": "https",
            "x-twilio-signature": sign(signed),
          },
          body: new URLSearchParams(forged),
        }),
      ),
    );

    expect(res.status).toBe(403);
    expect(await stateOf(caseRef)).toBe("DIALING");
    expect(drafted).toHaveLength(0);
  });
});
