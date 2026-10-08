/**
 * THE SPEECH GATE — what is allowed to leave the building as a customer's voice.
 *
 * The gate enforces in two directions, and both directions have to be provable:
 *
 *   - PII and speakability cleaning runs on EVERY call. There is no tenant,
 *     religion, or product that makes a spoken card number acceptable, so these
 *     tests assert the rewrite happens with no context at all.
 *   - Shariah terminology runs ONLY for a declared Islamic institution. Applied
 *     to a conventional insurer it would tell the customer something false about
 *     their own policy, so the "off by default" case is as important as the "on"
 *     case.
 *
 * The multi-word rules exist because a naive word-map corrupts: replacing
 * "interest" before "interest rate" produces "profit rate rate", which is worse
 * than the breach it was preventing.
 */
import { describe, expect, it } from "bun:test";

import {
  MAX_SPEECH_WORDS,
  applyShariahTerms,
  prepareSpeech,
  toSpokenForm,
  withinWordLimit,
} from "@/lib/compliance/speech-gate";

describe("speech gate — PII is redacted unconditionally", () => {
  it("redacts a card number before it reaches the synthesiser", () => {
    const res = prepareSpeech("The card ending 4111 1111 1111 1111 was used.");
    expect(res.text).toContain("[REDACTED_PAN]");
    expect(res.text).not.toContain("4111111111111111");
    expect(res.redactions).toContain("PAN");
  });

  it("redacts a phone number spoken into the transcript", () => {
    const res = prepareSpeech("Call me on +256 700 123 456 please");
    expect(res.text).toContain("[REDACTED_PHONE]");
    expect(res.redactions).toContain("PHONE");
  });

  it("redacts an SSN-shaped identifier", () => {
    const res = prepareSpeech("My number is 123-45-6789");
    expect(res.text).toContain("[REDACTED_SSN]");
  });

  it("reports nothing redacted when there is nothing to redact", () => {
    const res = prepareSpeech("Did you authorise this charge?");
    expect(res.redactions).toEqual([]);
    expect(res.text).toBe("Did you authorise this charge?");
  });
});

describe("speech gate — speakability", () => {
  it("strips markdown an LLM may answer in", () => {
    expect(toSpokenForm("**Fraud Alert**")).toBe("Fraud Alert");
    expect(toSpokenForm("- freeze card\n- call back")).toBe("freeze card call back");
    expect(toSpokenForm("## Summary")).toBe("Summary");
    expect(toSpokenForm("use `PIN` now")).toBe("use PIN now");
    expect(toSpokenForm("see [our policy](https://x.y/p)")).toBe("see our policy");
  });

  it("strips emoji, including family sequences that are several code points", () => {
    expect(toSpokenForm("thanks 🙂")).toBe("thanks");
    expect(toSpokenForm("team 👨‍👩‍👧 ok")).toBe("team ok");
  });

  it("keeps a long answer inside the spoken word limit", () => {
    const rambling = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const res = withinWordLimit(rambling, MAX_SPEECH_WORDS);
    expect(res.truncated).toBe(true);
    expect(res.text.split(/\s+/).length).toBeLessThanOrEqual(MAX_SPEECH_WORDS);
  });

  it("ends on a clause boundary rather than mid-sentence when it can", () => {
    const text =
      "I have temporarily restricted your card, please contact your branch within two hours, and we will arrange a replacement financing card for you today";
    const res = withinWordLimit(text, 12);
    expect(res.truncated).toBe(true);
    expect(res.text.endsWith(",")).toBe(true);
  });

  it("leaves a short answer untouched", () => {
    const res = withinWordLimit("Was this you?");
    expect(res.truncated).toBe(false);
    expect(res.text).toBe("Was this you?");
  });

  it("truncation is reported through the gate, not hidden", () => {
    const long = Array.from({ length: 45 }, (_, i) => `w${i}`).join(" ");
    expect(prepareSpeech(long, { maxWords: MAX_SPEECH_WORDS }).truncated).toBe(true);
  });

  it("does NOT cap text that has no declared limit", () => {
    // The 30-word rule constrains what a model may improvise mid-call. It is
    // not a constraint on the compliance-approved opening disclosure, which is
    // long on purpose. Capping that by default deleted "we have placed a
    // temporary hold" and "I will never ask for your PIN" off the end of every
    // recorded fraud call — a guardrail destroying the disclosure it guards.
    const uncapped = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    expect(prepareSpeech(uncapped).text.split(/\s+/).length).toBe(60);
  });
});

describe("speech gate — Shariah terminology is opt-in", () => {
  const shariah = { shariahCompliant: true };

  it("does NOT rewrite a conventional institution's own product names", () => {
    const res = prepareSpeech("Your insurance premium is due.");
    expect(res.text).toBe("Your insurance premium is due.");
    expect(res.substitutions).toEqual([]);
  });

  it("rewrites the prohibited terms for an Islamic institution", () => {
    expect(prepareSpeech("Your loan carries interest.", shariah).text).toBe(
      "Your financing carries profit rate.",
    );
    expect(prepareSpeech("Your insurance premium", shariah).text).toBe("Your takaful contribution");
  });

  it("applies the multi-word rule first, never producing 'profit rate rate'", () => {
    const res = prepareSpeech("The interest rate on your facility.", shariah);
    expect(res.text).toBe("The profit rate on your facility.");
    expect(res.text).not.toContain("profit rate rate");
  });

  it("does not match inside unrelated words", () => {
    // "interested" and "April" contain the rule keys; the letter-fenced boundary
    // must keep both intact.
    expect(prepareSpeech("Are you interested in April?", shariah).text).toBe(
      "Are you interested in April?",
    );
  });

  it("preserves sentence-initial capitalisation", () => {
    expect(prepareSpeech("Interest is not payable.", shariah).text).toBe(
      "Profit rate is not payable.",
    );
  });

  it("enforces the same rules in Arabic, the language most of these calls run in", () => {
    const res = prepareSpeech("هذا التأمين فيه فائدة على القرض", { ...shariah, lang: "ar" });
    expect(res.text).toContain("تكافل");
    expect(res.text).toContain("ربح");
    expect(res.text).toContain("تمويل");
    expect(res.text).not.toContain("تأمين");
    expect(res.text).not.toContain("فائدة");
  });

  it("reports which pairs it applied so the audit trail can show enforcement", () => {
    const res = prepareSpeech("Your loan is overdue.", shariah);
    expect(res.substitutions.length).toBeGreaterThan(0);
  });

  it("applyShariahTerms is idempotent — running it twice changes nothing", () => {
    const once = applyShariahTerms("Your insurance premium and interest rate").text;
    expect(applyShariahTerms(once).text).toBe(once);
  });
});

describe("speech gate — input hygiene", () => {
  it("survives empty and whitespace-only input", () => {
    expect(prepareSpeech("").text).toBe("");
    expect(prepareSpeech("   ").text).toBe("");
    expect(prepareSpeech(undefined as unknown as string).text).toBe("");
  });

  it("does not let a redaction marker be re-rewritten by the Shariah pass", () => {
    const res = prepareSpeech("card 4111111111111111 interest", shariahCtx());
    expect(res.text).toContain("[REDACTED_PAN]");
    expect(res.text).toContain("profit rate");
  });

  function shariahCtx() {
    return { shariahCompliant: true };
  }
});
