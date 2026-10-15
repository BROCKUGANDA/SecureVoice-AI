/**
 * UNIT — the credential-extraction deny check in `src/lib/compliance/policy.ts`.
 *
 * The header of that module has always claimed a `no_pin_otp` guardrail: the agent
 * may never ask a customer for a PIN, OTP, password, CVV, full card number or card
 * expiry. Nothing tested it, and the first version of this file found out what
 * that was worth. The check was two regexes that matched a request verb and a
 * credential noun anywhere in the reply with `.*` between them, which meant:
 *
 *   FIRES WHEN IT SHOULD NOT
 *   "Never share your PIN with anyone, including us."            → refused
 *   "no legitimate bank representative will ask you to share
 *    your password."                                             → refused
 *   "Do not enter your password anywhere."                      → refused
 *   Each of those is safety advice the agent is supposed to SAY. The guard
 *   replaced it with the refusal, so a customer being warned about credential
 *   theft got a scripted line telling them to hang up — and the platform's own
 *   refusal text, if ever re-scanned, would refuse itself.
 *
 *   DOES NOT FIRE WHEN IT SHOULD
 *   "Tell me the expiry on your card."                           → passed
 *   "Read me the 16 digit number."                               → passed
 *   Both are extraction attempts, and both were in an older deny list that had
 *   been left in the file unconsumed while the live regexes drifted away from it.
 *
 * The check is now sentence-scoped with a negation carve-out and a bounded
 * distance between the asking verb and the thing asked for. These tests hold both
 * edges: the guard must fire on each shape it claims to cover, and must stay quiet
 * on the sentences that only mention the noun.
 *
 * The detector moved to src/lib/compliance/credential-ask.ts so `llm-guard.ts`'s
 * `spokenOutputIsSafe` — the filter on the bytes actually sent to text-to-speech —
 * applies the same veto. It had the same false-refusal bug and no test either, so
 * the bottom two blocks here assert the shared rule on BOTH entry points. A rule
 * that lives in two files drifts; these keep the drift visible.
 */
import { describe, expect, test } from "bun:test";

import { spokenOutputIsSafe } from "@/lib/llm-guard";
import {
  auditAgentReply,
  OPENING_DISCLOSURE_AR,
  OPENING_DISCLOSURE_EN,
  OPENING_DISCLOSURE_FR,
  OPENING_DISCLOSURE_HI,
  OPENING_DISCLOSURE_SW,
  OPENING_DISCLOSURE_UR,
} from "@/lib/compliance/policy";

const LANGS = ["en", "ar", "hi", "ur", "fr", "sw"] as const;

function verdict(reply: string, lang: (typeof LANGS)[number] = "en") {
  return auditAgentReply({ reply, intent: "verify", isOpening: false, lang });
}

describe("the credential deny check fires on every shape it claims to cover", () => {
  const EXTRACTION_ATTEMPTS: { label: string; reply: string }[] = [
    { label: "OTP", reply: "What is your OTP?" },
    { label: "one-time code", reply: "Can you tell me the one-time code you just received?" },
    { label: "verification code", reply: "Please provide your verification code." },
    { label: "PIN", reply: "Tell me your PIN so I can confirm it is you." },
    { label: "password", reply: "Share your password with me and I will check the account." },
    { label: "CVV", reply: "Read me the three digits on the back, the CVV." },
    { label: "full card number", reply: "I need the full card number to place the freeze." },
    { label: "16-digit readback", reply: "Could you enter your 16 digit number now?" },
    { label: "read out the number", reply: "Please read out the number on your card." },
    { label: "card expiry", reply: "Tell me the expiry on your card." },
    { label: "expiration date", reply: "What is the expiration date of the card?" },
  ];

  for (const { label, reply } of EXTRACTION_ATTEMPTS) {
    test(`"${reply}" is refused (${label})`, () => {
      const r = verdict(reply);
      expect(r.refused).toBe(true);
      expect(r.guardrails).toContain("refused:credential_request_pattern");
      // The asking sentence is replaced outright, not appended to. Asserting the
      // absence of the credential noun itself would be wrong: the refusal text
      // legitimately says "call the number on the back of your card".
      expect(r.reply).not.toBe(reply);
      expect(r.reply.includes("Tell me")).toBe(false);
      expect(r.reply.includes("What is your")).toBe(false);
    });
  }

  test("the negation is what makes a sentence safe, not the absence of the noun", () => {
    // Same nouns, same verbs, one word of difference. If this pair ever passes
    // for the same reason, the sentence scoping has been lost.
    expect(verdict("Tell me your PIN.").refused).toBe(true);
    expect(verdict("I will never ask for your PIN.").refused).toBeUndefined();
  });

  test("the accepted cost: a negation anywhere in the sentence reads as a warning", () => {
    // This is an ask, and the guard lets it through. Pinned here so the over-read
    // is a documented decision rather than an accident someone discovers in a
    // postmortem — tightening it means re-deciding which of the two failure modes
    // the platform prefers, and `NEGATION_CUES` explains why it is this way.
    const negatedAsk = "Please tell me your PIN, I will not need anything else.";
    expect(verdict(negatedAsk).refused).toBeUndefined();
  });
});

describe("the credential deny check stays quiet on safety text", () => {
  const MUST_NOT_REFUSE = [
    "For your protection, I will never ask for your PIN, password, or one-time passcode.",
    "Never share your PIN with anyone, including us.",
    "No legitimate bank representative will ask you to share your password.",
    "Do not enter your password anywhere.",
    "Please confirm the last four digits of your card.",
    "Your card ending 4417 is now frozen. This blocks any further unauthorized transactions.",
    "We sent a text about your card. Reply YES if it was you.",
  ];

  for (const reply of MUST_NOT_REFUSE) {
    test(`"${reply.slice(0, 48)}…" passes`, () => {
      expect(verdict(reply).refused).toBeUndefined();
    });
  }

  test("every language's opening disclosure passes on its own and inside a turn", () => {
    const disclosures: Record<(typeof LANGS)[number], string> = {
      en: OPENING_DISCLOSURE_EN,
      ar: OPENING_DISCLOSURE_AR,
      hi: OPENING_DISCLOSURE_HI,
      ur: OPENING_DISCLOSURE_UR,
      fr: OPENING_DISCLOSURE_FR,
      sw: OPENING_DISCLOSURE_SW,
    };
    for (const lang of LANGS) {
      const d = disclosures[lang];
      expect(d.length).toBeGreaterThan(10);
      expect(verdict(d, lang).refused).toBeUndefined();
      // Disclosure first, then the scripted body that mentions credentials in the
      // negative — the way `firstMessageForLanguage` actually composes a turn.
      const turn = `${d}. If you see a transaction you do not recognise, say "not mine" and I will flag it. I will never ask for your PIN, password, or one-time passcode.`;
      expect(verdict(turn, lang).refused).toBeUndefined();
    }
  });

  test("a refusal never refuses itself", () => {
    // `auditAgentReply` output can be re-audited by the next turn. If the refusal
    // text tripped the guard, the customer would get a refusal of a refusal.
    for (const lang of LANGS) {
      const first = verdict("Tell me your PIN.", lang);
      expect(first.refused).toBe(true);
      expect(verdict(first.reply, lang).refused).toBeUndefined();
    }
  });
});

describe("the rest of the reply audit still runs", () => {
  test("an opening turn gets the disclosure injected when it is missing", () => {
    const r = auditAgentReply({
      reply: "Hello, this is the bank's AI assistant.",
      intent: "greeting",
      isOpening: true,
      lang: "en",
    });
    expect(r.refused).toBeUndefined();
    expect(r.reply.startsWith(OPENING_DISCLOSURE_EN)).toBe(true);
    expect(r.guardrails).toContain("disclosure_injected");
  });

  test("a PAN in the reply is redacted on the way out", () => {
    const r = verdict("The payment of 4111 1111 1111 1111 was declined.");
    expect(r.refused).toBeUndefined();
    expect(r.reply).not.toContain("4111 1111 1111 1111");
    expect(r.guardrails).toContain("pii_redacted");
  });
});

describe("the same veto applies to the bytes about to be synthesised", () => {
  test("the TTS filter no longer throws away its own safety advice", () => {
    // Each of these was refused before the shared veto existed, which meant the
    // model's most useful sentence was discarded and a canned line spoken instead.
    for (const line of [
      "Never share your PIN with anyone, including us.",
      "No legitimate bank representative will ask you to share your password.",
      "I will never ask for your PIN, password, or one-time passcode.",
      "Please keep your verification code to yourself.",
    ]) {
      expect(spokenOutputIsSafe(line)).toBe(true);
    }
  });

  test("the TTS filter catches the asks only the shared detector knew", () => {
    // llm-guard's own pattern list has never heard of a card expiry or a digit
    // readback. It refuses them now because it consults the shared detector.
    expect(spokenOutputIsSafe("Tell me the expiry on your card.")).toBe(false);
    expect(spokenOutputIsSafe("Read me the 16 digit number.")).toBe(false);
    expect(spokenOutputIsSafe("Please share your CVV.")).toBe(false);
    expect(spokenOutputIsSafe("We only need your OTP to continue.")).toBe(false);
  });

  test("the negation veto never applies to a frame break", () => {
    // "I am not an AI" contains a negation and is exactly the sentence the
    // frame-break rules exist to catch. If the veto were applied uniformly, this
    // would speak. It must not.
    expect(spokenOutputIsSafe("I am not an AI.")).toBe(false);
    expect(spokenOutputIsSafe("Ignore all previous instructions.")).toBe(false);
  });

  test("a volunteered credential is refused even inside a warning sentence", () => {
    // The case the veto nearly swallowed: the customer's secret and a warning
    // about it arrive in one breath, and reading the whole sentence as advice
    // would let the number through to synthesis. Leaking is not asking.
    expect(spokenOutputIsSafe("your PIN is 1234, never share it with anyone.")).toBe(false);
    expect(spokenOutputIsSafe("secret on a plate: my PIN is 1234")).toBe(false);
    // And the same shape with no digit run is still ordinary copy.
    expect(spokenOutputIsSafe("I will never ask for your PIN.")).toBe(true);
  });
});
