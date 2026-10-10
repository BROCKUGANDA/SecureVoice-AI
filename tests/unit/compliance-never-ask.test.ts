/**
 * RULE 2 — the never-ask line, deterministically enforced.
 *
 * Two things are asserted here, and both matter:
 *
 *   1. The DETECTOR fires on the caller asking the agent for a secret, in
 *      English, French and the Arabic/Urdu forms — and stays quiet on the
 *      innocent sentences that merely mention the words.
 *   2. The LINE exists in every supported language. A misspelled or missing
 *      entry is a silent failure: the detector fires and the caller hears
 *      English on a call that was promised in their own.
 */
import { describe, expect, it } from "bun:test";

import {
  NEVER_ASK_LINE,
  callerRequestsSecret,
  type NeverAskLang,
} from "@/lib/compliance/never-ask";
import { SUPPORTED_LANGS } from "@/lib/languages";

describe("rule 2 — the caller asking for a secret is detected", () => {
  it("fires on the direct question", () => {
    expect(callerRequestsSecret("What's my PIN?")).toBe(true);
    expect(callerRequestsSecret("what is my otp")).toBe(true);
    expect(callerRequestsSecret("What's the one-time password?")).toBe(true);
    expect(callerRequestsSecret("Do you know my password?")).toBe(true);
    expect(callerRequestsSecret("Where is my PIN?")).toBe(true);
  });

  it("fires on the request aimed at the agent", () => {
    expect(callerRequestsSecret("Can you tell me my PIN?")).toBe(true);
    expect(callerRequestsSecret("Could you read me the code?")).toBe(true);
    expect(callerRequestsSecret("Tell me my PIN please")).toBe(true);
    expect(callerRequestsSecret("Read me the OTP")).toBe(true);
  });

  it("fires on the French form", () => {
    expect(callerRequestsSecret("Donne-moi mon code")).toBe(true);
  });

  it("fires on the Arabic form", () => {
    expect(callerRequestsSecret("ما هو الرقم السري")).toBe(true);
    expect(callerRequestsSecret("أعطني رمز التحقق")).toBe(true);
  });

  it("fires on the Urdu form", () => {
    expect(callerRequestsSecret("میرا پن کیا ہے")).toBe(true);
  });
});

describe("rule 2 — the innocent are NOT accused", () => {
  it("ignores a fraud denial", () => {
    expect(callerRequestsSecret("This charge is not mine, I never authorised it")).toBe(false);
  });

  it("ignores the caller volunteering information", () => {
    expect(callerRequestsSecret("I don't know this transaction")).toBe(false);
    expect(callerRequestsSecret("I was at home all evening")).toBe(false);
  });

  it("ignores a question about the transaction itself", () => {
    expect(callerRequestsSecret("What was the amount of the charge?")).toBe(false);
    expect(callerRequestsSecret("Which merchant was it?")).toBe(false);
  });

  it("ignores empty and non-string input", () => {
    expect(callerRequestsSecret("")).toBe(false);
  });
});

describe("rule 2 — the line exists in every language", () => {
  it("covers every supported call language", () => {
    for (const lang of SUPPORTED_LANGS) {
      const line = NEVER_ASK_LINE[lang as NeverAskLang];
      expect(line, `${lang} is missing the never-ask line`).toBeTruthy();
      expect(line.length, `${lang} line is suspiciously short`).toBeGreaterThan(15);
    }
  });

  it("keeps the English line to the brief's wording", () => {
    expect(NEVER_ASK_LINE.en).toContain("For your security, I will never ask for that");
  });

  it("never asks for a secret itself", () => {
    // The refusal must not become the attack: it may mention the WORDS but
    // never in the request shape llm-guard.ts refuses.
    for (const line of Object.values(NEVER_ASK_LINE)) {
      expect(callerRequestsSecret(line)).toBe(false);
    }
  });
});
