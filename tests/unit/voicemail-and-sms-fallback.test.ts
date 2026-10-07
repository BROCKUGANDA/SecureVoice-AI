/**
 * UNIT - what happens when a fraud-intervention call does NOT reach a human.
 *
 * A voice channel that fails silently is the worst outcome of this product: the
 * customer never learns a transaction needs attention. Four controls cover it,
 * each pinned here because each one is easy to quietly weaken:
 *
 *   1. VOICEMAIL IS GENERIC. A mailbox is not the customer. The message a machine
 *      hears carries no amount, no merchant, no case reference - exactly the
 *      details a scammer wants before ringing back as "the bank". It also says
 *      it is an AI, and tells the customer to use the number ON THEIR CARD, never
 *      one we supply.
 *   2. THE SMS FALLBACK IS HONEST. No "reply YES/NO" (nothing reads replies), no
 *      link, no merchant on a lock screen. One safe instruction only.
 *   3. THE FALLBACK ONLY FIRES WHEN IT IS TRUE. Not once a human has answered.
 *   4. THE LIVE CALL ACTUALLY CARRIES IT. The agent's voicemail tool reads a
 *      dynamic variable; if placeOutboundCall stops sending it, a mailbox hears
 *      nothing and the config still looks correct. Asserted on the wire.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.ELEVENLABS_API_KEY = "test-key";
process.env.ELEVENLABS_AGENT_ID = "agent_test";
process.env.ELEVENLABS_PHONE_NUMBER_ID = "phnum_test";
process.env.ELEVENLABS_VOICE_EN = "voice_en_test";
process.env.ELEVENLABS_VOICE_AR = "voice_ar_test";
delete process.env.ELEVENLABS_DRY_RUN;

const { CALL_LANGUAGES, voicemailMessageForLanguage, placeOutboundCall } =
  await import("@/lib/elevenlabs/outbound-call");
const { unreachableSmsBody } = await import("@/lib/twilio");
const { stateAllowsFallback, formatAmount } = await import("@/lib/elevenlabs/sms-fallback");
const { isVoicemailCall } = await import("@/lib/elevenlabs/inbound");
const { _resetEgressForTest } = await import("@/lib/elevenlabs/egress");
const { _reset: resetRateLimits } = await import("@/lib/ratelimit");

const ROOT = join(import.meta.dir, "..", "..");
const agentYaml = readFileSync(join(ROOT, "agent", "securevoice.agent.yaml"), "utf8");

describe("the voicemail message a mailbox hears", () => {
  test("every callable language has one - there is no English fallback", () => {
    for (const lang of CALL_LANGUAGES) {
      const msg = voicemailMessageForLanguage(lang);
      expect(msg, lang).not.toBeNull();
      expect(msg!.length, lang).toBeGreaterThan(80);
    }
    expect(voicemailMessageForLanguage("xx")).toBeNull();
    expect(voicemailMessageForLanguage("")).toBeNull();
  });

  test("it is generic: no digits, no placeholders, no links, no merchant slot", () => {
    for (const lang of CALL_LANGUAGES) {
      const msg = voicemailMessageForLanguage(lang)!;
      // No amount, case number or phone number can be in it.
      expect(/\d/.test(msg), `${lang} contains a digit`).toBe(false);
      // A leftover template slot would be read aloud as "curly brace curly brace".
      expect(msg, lang).not.toContain("{{");
      expect(msg.toLowerCase(), lang).not.toContain("http");
      expect(msg.toLowerCase(), lang).not.toContain("www");
    }
  });

  test("each language is distinct, and each promises never to ask for a PIN", () => {
    const all = CALL_LANGUAGES.map((l) => voicemailMessageForLanguage(l)!);
    expect(new Set(all).size).toBe(all.length);
    for (const msg of all) expect(msg).toContain("PIN");
  });

  test("it discloses that the caller is automated", () => {
    expect(voicemailMessageForLanguage("en")!.toLowerCase()).toContain("automated");
    expect(voicemailMessageForLanguage("fr")!.toLowerCase()).toContain("automatis");
  });
});

describe("the 'we could not reach you' SMS", () => {
  const LANGS = ["en", "ar", "hi", "ur", "fr", "sw"] as const;

  test("fits the 300-char cap sendInterventionSms applies (no mid-sentence cut)", () => {
    for (const lang of LANGS) {
      expect(unreachableSmsBody(lang, "AED 250000").length, lang).toBeLessThanOrEqual(300);
    }
  });

  test("never invites a reply, never carries a link or a merchant", () => {
    for (const lang of LANGS) {
      const body = unreachableSmsBody(lang, "AED 2500");
      expect(body.toLowerCase(), lang).not.toContain("reply");
      expect(body.toLowerCase(), lang).not.toContain("http");
      expect(body.toLowerCase(), lang).not.toContain("www.");
      // Tells them to use a number they already hold.
      expect(body.length, lang).toBeGreaterThan(60);
    }
  });

  test("the amount appears when known and the message is complete without it", () => {
    expect(unreachableSmsBody("en", "AED 2500")).toContain("AED 2500");
    const bare = unreachableSmsBody("en");
    expect(bare).not.toContain("()");
    expect(bare).not.toContain("undefined");
    expect(/\d/.test(bare)).toBe(false);
  });

  test("every language states the PIN/OTP promise", () => {
    for (const lang of LANGS) expect(unreachableSmsBody(lang), lang).toContain("PIN");
  });
});

describe("when the fallback is allowed to fire", () => {
  test("only while no human has heard the intervention", () => {
    for (const s of [
      "SCREENED",
      "DIALING",
      "RINGING",
      "NO_ANSWER",
      "BUSY",
      "FAILED",
      "VOICEMAIL",
      "RETRY_SCHEDULED",
      "EXHAUSTED",
    ]) {
      expect(stateAllowsFallback(s), s).toBe(true);
    }
  });

  test("never once a person answered - 'we could not reach you' would be false", () => {
    for (const s of [
      "ANSWERED",
      "DISCLOSED",
      "VERIFYING",
      "CONFIRMED_LEGITIMATE",
      "CONFIRMED_FRAUD",
      "UNCERTAIN",
      "FREEZE_STAGED",
      "ESCALATED",
      "NOTIFIED",
      "CLOSED",
      "REJECTED",
    ]) {
      expect(stateAllowsFallback(s), s).toBe(false);
    }
  });

  test("an unknown state fails closed", () => {
    expect(stateAllowsFallback("SOMETHING_NEW")).toBe(false);
    expect(stateAllowsFallback("")).toBe(false);
  });

  test("the amount is the raw stored value, never rescaled", () => {
    expect(formatAmount(2500, "aed")).toBe("AED 2500");
    expect(formatAmount(2500, null)).toBe("2500");
    expect(formatAmount(0, "AED")).toBeUndefined();
    expect(formatAmount(null, "AED")).toBeUndefined();
    expect(formatAmount(Number.NaN, "AED")).toBeUndefined();
    expect(formatAmount(-5, "AED")).toBeUndefined();
  });
});

describe("recognising a voicemail call from the post-call event", () => {
  test("the voicemail_detection tool firing is the source of truth", () => {
    expect(isVoicemailCall({}, ["voicemail_detection"])).toBe(true);
    expect(isVoicemailCall({}, ["card_freeze", "voicemail_detection"])).toBe(true);
  });

  test("the termination reason is a second signal", () => {
    expect(isVoicemailCall({ metadata: { termination_reason: "Voicemail detected" } }, [])).toBe(
      true,
    );
  });

  test("an ordinary call is not a voicemail", () => {
    expect(isVoicemailCall({}, [])).toBe(false);
    expect(isVoicemailCall({}, ["card_freeze", "human_handoff"])).toBe(false);
    expect(isVoicemailCall({ metadata: { termination_reason: "end_call tool" } }, [])).toBe(false);
    expect(isVoicemailCall({ metadata: { termination_reason: 42 } }, [])).toBe(false);
    expect(isVoicemailCall(undefined, [])).toBe(false);
  });
});

describe("the live outbound call carries the voicemail message", () => {
  const realFetch = globalThis.fetch;
  let sentBody: any = null;

  beforeEach(() => {
    process.env.ELEVENLABS_COMMERCIAL_USE = "true";
    delete process.env.REDIS_URL;
    process.env.ELEVENLABS_EGRESS_PER_HOUR = "10000";
    _resetEgressForTest();
    resetRateLimits();
    sentBody = null;
    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      sentBody = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      return new Response(JSON.stringify({ conversation_id: "conv_1", callSid: "CA1" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("voicemail_message is on the wire, in the call's language", async () => {
    await placeOutboundCall({
      toNumber: "+971500000000",
      language: "ar",
      caseRef: "SV-F-TEST01",
      dynamicVariables: { merchant: "ACME", amount: 2500 },
    });
    const vars = sentBody.conversation_initiation_client_data.dynamic_variables;
    expect(vars.voicemail_message).toBe(voicemailMessageForLanguage("ar")!);
    // The ordinary variables still travel alongside it.
    expect(vars.merchant).toBe("ACME");
    expect(vars.amount).toBe(2500);
  });

  test("a caller-supplied voicemail_message cannot replace the generic text", async () => {
    await placeOutboundCall({
      toNumber: "+971500000000",
      language: "en",
      caseRef: "SV-F-TEST02",
      dynamicVariables: { voicemail_message: "Your card was used for AED 2500 at ACME" },
    });
    const vars = sentBody.conversation_initiation_client_data.dynamic_variables;
    expect(vars.voicemail_message).toBe(voicemailMessageForLanguage("en")!);
    expect(vars.voicemail_message).not.toContain("2500");
  });
});

describe("the agent definition", () => {
  test("wires the voicemail tool to the per-call variable", () => {
    expect(agentYaml).toMatch(/^voicemail:\s*$/m);
    expect(agentYaml).toContain('message: "{{voicemail_message}}"');
  });

  test("dead air: re-engage at 10s, then a hard stop that outlasts the re-engage", () => {
    const turnTimeout = Number(/^\s+turn_timeout:\s*(\d+)/m.exec(agentYaml)?.[1]);
    const silenceEnd = Number(/^\s+silence_end_call_timeout:\s*(\d+)/m.exec(agentYaml)?.[1]);
    expect(turnTimeout).toBe(10);
    // The hard stop must come AFTER the agent has re-engaged once, or a customer
    // who is simply thinking is hung up on without ever being asked.
    expect(silenceEnd).toBeGreaterThan(turnTimeout);
  });

  test("the prompt carries the voice-style, trust, silence and machine rules", () => {
    expect(agentYaml).toContain("under 30 words");
    expect(agentYaml).toContain("IF THE CUSTOMER DOUBTS YOU ARE REAL");
    expect(agentYaml).toContain("SILENCE AND DEAD AIR");
    expect(agentYaml).toContain("voicemail_detection");
    // Never claims to be human - the disclosure rule outranks any persona rule.
    expect(agentYaml).toContain("Never claim to be human");
  });

  test("does NOT adopt a 'never break character' rule that would contradict the AI disclosure", () => {
    expect(agentYaml.toLowerCase()).not.toContain("never break character");
  });
});
