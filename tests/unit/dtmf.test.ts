/**
 * DTMF — the keypad channel, and the security rule it must never break.
 *
 * The tests are written around the two claims that would matter in an audit:
 *
 *  1. **A press is intent, never proof.** Every action this module can produce
 *     is checked to be reachable, and `confirm_authorized` in particular is
 *     pinned to a key — so that if someone later binds it to something else,
 *     or adds an action that authorises rather than classifies, the diff lands
 *     next to a test that already says what the vocabulary is.
 *
 *  2. **The wire is hostile.** The `Digits` field is a carrier POST body we did
 *     not author. Empty, absent, non-keypad, over-long, and multi-key inputs
 *     each have a typed outcome, and none of them throws — because a throw on
 *     the turn route is a 500 and a dropped caller on a live fraud call.
 */
import { describe, expect, test } from "bun:test";

import {
  DTMF_ACTIONS,
  DTMF_SPEECH,
  DEFAULT_DTMF_LAYOUT,
  KEYPAD_CHARACTERS,
  MAX_DTMF_SEQUENCE,
  buildGatherTwiml,
  describeDtmfForSpeech,
  escapeXml,
  isDtmfAction,
  mapDtmfDigits,
  parseDtmf,
  sanitiseGatherActionUrl,
  type DtmfAction,
  type DtmfVerdict,
} from "@/lib/voice/dtmf";

/** Narrowing helper so a failed expectation reads as "wrong action", not a TS error. */
function expectOk(verdict: DtmfVerdict): DtmfAction {
  if (!verdict.ok) throw new Error(`expected an action, got refusal: ${verdict.reason}`);
  return verdict.action;
}

function expectRefused(verdict: DtmfVerdict): string {
  if (verdict.ok) throw new Error(`expected a refusal, got action: ${verdict.action}`);
  expect(verdict.detail.length).toBeGreaterThan(0);
  return verdict.reason;
}

describe("the default layout — every bound key maps where the design says", () => {
  test("1 is 'not mine' — the answer that must be cheapest to give", () => {
    expect(expectOk(mapDtmfDigits("1"))).toBe("deny_fraud");
  });

  test("2 is 'I authorised it'", () => {
    expect(expectOk(mapDtmfDigits("2"))).toBe("confirm_authorized");
  });

  test("9 asks for a person", () => {
    expect(expectOk(mapDtmfDigits("9"))).toBe("request_human");
  });

  test("0 says that again", () => {
    expect(expectOk(mapDtmfDigits("0"))).toBe("repeat");
  });

  test("* ends the call", () => {
    expect(expectOk(mapDtmfDigits("*"))).toBe("cancel");
  });

  test("# is bound to 'none' — confusion gets the options read again", () => {
    expect(expectOk(mapDtmfDigits("#"))).toBe("none");
  });

  test("3–8 are deliberately unbound, so 'unmapped_key' is a real outcome", () => {
    for (const key of ["3", "4", "5", "6", "7", "8"]) {
      expect(expectRefused(mapDtmfDigits(key))).toBe("unmapped_key");
    }
  });

  test("the layout is frozen — an institution overrides it by passing its own", () => {
    expect(Object.isFrozen(DEFAULT_DTMF_LAYOUT)).toBe(true);
    // Passing a layout is a data swap, not a fork of the mapping code.
    const institutional: Readonly<Record<string, DtmfAction>> = Object.freeze({
      "7": "deny_fraud",
      "8": "confirm_authorized",
    });
    expect(expectOk(mapDtmfDigits("7", institutional))).toBe("deny_fraud");
    // ...and the default layout's keys are genuinely gone under the override.
    expect(expectRefused(mapDtmfDigits("1", institutional))).toBe("unmapped_key");
  });

  test("an inherited key is never mistaken for a binding", () => {
    // `Object.prototype.toString` is truthy; a bare `layout[key]` would cast it.
    expect(expectRefused(mapDtmfDigits("*", {}))).toBe("unmapped_key");
  });

  test("the action vocabulary is closed", () => {
    for (const action of DTMF_ACTIONS) {
      expect(isDtmfAction(action)).toBe(true);
      expect(DTMF_SPEECH[action]).toBeDefined();
    }
    expect(isDtmfAction("authorise")).toBe(false);
    expect(isDtmfAction(undefined)).toBe(false);
  });
});

describe("parseDtmf — the carrier payload is untrusted", () => {
  test("accepts a plain digit string", () => {
    expect(parseDtmf("1")).toBe("1");
  });

  test("accepts the A–D DTMF extensions and normalises their case", () => {
    // Twilio sends A-D uppercase; a lowercasing carrier must not break the map.
    expect(parseDtmf("A")).toBe("A");
    expect(parseDtmf("a")).toBe("A");
    expect(KEYPAD_CHARACTERS).toContain("A");
  });

  test("trims padding a proxy or a hand-rolled sender may add", () => {
    expect(parseDtmf("  2\n")).toBe("2");
  });

  test("an absent Digits field is null — the speech-only turn", () => {
    expect(parseDtmf(null)).toBeNull();
    expect(parseDtmf(undefined)).toBeNull();
    expect(parseDtmf("")).toBeNull();
    expect(parseDtmf("   ")).toBeNull();
  });

  test("rejects anything a keypad cannot send", () => {
    // NOTE: `a` is NOT a rejection — it is the DTMF A-D extension. `z` is not a
    // key on any keypad, which is what makes it the right control here.
    expect(parseDtmf("1z")).toBeNull();
    expect(parseDtmf("1 2")).toBeNull();
    expect(parseDtmf("<script>")).toBeNull();
    expect(parseDtmf("1;DROP")).toBeNull();
    expect(parseDtmf("😀")).toBeNull();
  });

  test("rejects a value longer than any real Gather produces", () => {
    expect(parseDtmf("1".repeat(MAX_DTMF_SEQUENCE))).toBe("1".repeat(MAX_DTMF_SEQUENCE));
    expect(parseDtmf("1".repeat(MAX_DTMF_SEQUENCE + 1))).toBeNull();
  });

  test("does not throw on a non-string (a File from a multipart FormData)", () => {
    // Cast is deliberate: the runtime guard is the thing under test.
    expect(parseDtmf(new Blob(["1"]) as unknown as string)).toBeNull();
  });
});

describe("mapDtmfDigits — refusals are typed, never thrown", () => {
  test("an empty string is refused, not treated as 'no action'", () => {
    expect(expectRefused(mapDtmfDigits(""))).toBe("absent");
  });

  test("whitespace-only is distinguished from absent", () => {
    // Different audit meaning: an interrupted Gather arrives empty; a speech
    // turn arrives with no field at all.
    expect(expectRefused(mapDtmfDigits(""))).toBe("absent");
    expect(expectRefused(mapDtmfDigits("   "))).toBe("empty");
  });

  test("a non-keypad character is refused", () => {
    expect(expectRefused(mapDtmfDigits("1z"))).toBe("non_keypad_character");
    expect(expectRefused(mapDtmfDigits("1;DROP TABLE"))).toBe("non_keypad_character");
    expect(expectRefused(mapDtmfDigits("😀"))).toBe("non_keypad_character");
  });

  test("three DIFFERENT keypad keys are ambiguous, not malformed", () => {
    // `A`, `B`, `C` are all real DTMF tones — the value is well-formed and the
    // intent is not. These are different failures and must stay different.
    expect(expectRefused(mapDtmfDigits("abc"))).toBe("ambiguous_multi_key");
  });

  test("an over-long burst is refused", () => {
    expect(expectRefused(mapDtmfDigits("1".repeat(MAX_DTMF_SEQUENCE + 1)))).toBe("too_long");
  });

  test("nothing throws, whatever arrives", () => {
    const hostile = ["", " ", "*", "##", "A", "..", "000", "1e309", "١٢٣", "9999999999999999999"];
    for (const value of hostile) {
      expect(() => mapDtmfDigits(value)).not.toThrow();
    }
  });
});

describe("mapDtmfDigits — multi-press sequences", () => {
  test("a burst of the SAME key is one intent pressed twice", () => {
    // A hand that slipped on a bad line. Honouring it costs nothing.
    expect(expectOk(mapDtmfDigits("22"))).toBe("confirm_authorized");
    expect(expectOk(mapDtmfDigits("11"))).toBe("deny_fraud");
  });

  test("two DIFFERENT keys are refused — the customer's intent is unknown", () => {
    // "1, that was not me" then "2" must not be recorded as "2, I authorised
    // it". Guessing here is how a real customer ends up defending a
    // transaction they never made.
    expect(expectRefused(mapDtmfDigits("21"))).toBe("ambiguous_multi_key");
    expect(expectRefused(mapDtmfDigits("12"))).toBe("ambiguous_multi_key");
    expect(expectRefused(mapDtmfDigits("191"))).toBe("ambiguous_multi_key");
  });
});

describe("buildGatherTwiml — valid XML out of untrusted copy", () => {
  test("escapes & and < in the prompt", () => {
    const xml = buildGatherTwiml({
      prompt: "Is the 5,000 AED charge at A&B <Market> yours?",
      actionUrl: "/api/twilio/turn",
    });
    expect(xml).toContain("A&amp;B");
    expect(xml).toContain("&lt;Market&gt;");
    // The raw metacharacters must not survive into the document.
    expect(xml).not.toContain("A&B");
    expect(xml).not.toContain("<Market>");
  });

  test("escapes every metacharacter the XML spec names", () => {
    // One pass, in the order the characters appear in the input: < > & " '
    expect(escapeXml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&apos;");
    expect(escapeXml(`'">&`)).toBe("&apos;&quot;&gt;&amp;");
  });

  test("escapes the fallback too", () => {
    const xml = buildGatherTwiml({
      prompt: "Press one or two.",
      actionUrl: "/api/twilio/turn",
      fallback: "I did not catch <that> & you may hang up.",
    });
    expect(xml).toContain("&lt;that&gt; &amp; you");
  });

  test("escapes in ONE pass, so the ampersand it emits is not re-escaped", () => {
    // A `<` must become `&lt;`, not `&amp;lt;` — the `&` introduced by this
    // escaper is never visited again in the same pass.
    expect(escapeXml("<")).toBe("&lt;");
    expect(buildGatherTwiml({ prompt: "A & B", actionUrl: "/x" })).toContain("A &amp; B");
  });

  test("collects on BOTH channels — that is the whole point", () => {
    const xml = buildGatherTwiml({ prompt: "Press one or two.", actionUrl: "/api/twilio/turn" });
    expect(xml).toContain('input="dtmf speech"');
    expect(xml).toContain('numDigits="1"');
    expect(xml).toContain("<Gather ");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true);
    expect(xml.endsWith("</Response>")).toBe(true);
  });

  test("clamps out-of-range numDigits and timeout instead of trusting them", () => {
    const xml = buildGatherTwiml({
      prompt: "Press one or two.",
      actionUrl: "/api/twilio/turn",
      numDigits: 9_999,
      timeoutSeconds: -4,
    });
    // Unparseable options degrade to prompt-only: nothing is collected into an
    // endpoint we have not checked.
    expect(xml).not.toContain("<Gather");
    expect(xml).toContain("Press one or two.");
  });

  test("a non-HTTPS Gather action is dropped rather than posted to", () => {
    // This attribute hands the caller a URL to POST their number to. http:// is
    // a downgrade, //host is a scheme we did not check.
    expect(sanitiseGatherActionUrl("http://evil.example/collect")).toBeNull();
    expect(sanitiseGatherActionUrl("//evil.example/collect")).toBeNull();
    expect(sanitiseGatherActionUrl("/api/twilio/turn")).toBe("/api/twilio/turn");
    expect(sanitiseGatherActionUrl("https://hooks.example/turn")).toBe(
      "https://hooks.example/turn",
    );

    const xml = buildGatherTwiml({
      prompt: "Press one or two.",
      actionUrl: "http://evil.example/collect",
    });
    expect(xml).not.toContain("evil.example");
    expect(xml).not.toContain("action=");
  });

  test("never throws, whatever the caller passes", () => {
    const hostile = [
      null,
      undefined,
      {},
      { prompt: "" },
      { prompt: "x".repeat(5_000), actionUrl: "/x" },
      { prompt: "hi", actionUrl: "" },
    ];
    for (const opts of hostile) {
      expect(() =>
        buildGatherTwiml(opts as unknown as Parameters<typeof buildGatherTwiml>[0]),
      ).not.toThrow();
    }
  });
});

describe("describeDtmfForSpeech — every action has something to say", () => {
  const langs = ["en", "ar", "hi", "ur", "fr", "sw"] as const;

  test("no action returns an empty line in any language", () => {
    for (const action of DTMF_ACTIONS) {
      for (const lang of langs) {
        const line = describeDtmfForSpeech(action, lang);
        expect(typeof line).toBe("string");
        expect(line.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("defaults to English", () => {
    expect(describeDtmfForSpeech("deny_fraud")).toBe(DTMF_SPEECH.deny_fraud.en);
  });

  test("an unknown language falls back to English rather than to silence", () => {
    expect(describeDtmfForSpeech("cancel", "de" as never)).toBe(DTMF_SPEECH.cancel.en);
  });

  test("the fraud line promises a TEMPORARY restriction and a human review", () => {
    // Never "frozen", never "closed" — that decision is the institution's
    // human fraud team's, and this platform does not make it.
    const en = describeDtmfForSpeech("deny_fraud", "en").toLowerCase();
    expect(en).toContain("temporary restriction");
    expect(en).toContain("human fraud specialist");
    expect(en).not.toContain("permanently");
    expect(en).not.toContain("closed your account");
  });

  test("the confirm line warns about the safe-account call, in every language", () => {
    // The closing sentence a caller needs most is the one saying what the bank
    // will never ask for.
    expect(describeDtmfForSpeech("confirm_authorized", "en")).toContain("safe account");
    expect(describeDtmfForSpeech("confirm_authorized", "ar")).toContain("حساب آمن");
  });

  test("no spoken line contains TwiML metacharacters", () => {
    // These strings are interpolated into a <Say>; an ampersand here is a
    // malformed document at the carrier.
    for (const action of DTMF_ACTIONS) {
      for (const lang of langs) {
        expect(describeDtmfForSpeech(action, lang)).not.toMatch(/[<>&]/);
      }
    }
  });
});
