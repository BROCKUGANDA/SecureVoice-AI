/**
 * RULE 5 at the gate — the number pass wired into `prepareSpeech`, asserted
 * at the boundary every voice path passes through.
 *
 * The gate's other guarantees are re-asserted here because the number pass
 * sits BETWEEN them and they must survive it:
 *
 *   · the vishing blocklist still refuses urgency language,
 *   · `redactPII` still recognises a PAN (the number pass must leave
 *     identifier shapes alone so redaction can see them), and
 *   · the hang-up-safe exit is still protected from the word cap.
 */
import { describe, expect, it } from "bun:test";

import { prepareSpeech } from "@/lib/compliance/speech-gate";

describe("speech gate — rule 5 renders numbers as speech", () => {
  it("speaks the amount, never the digits and the code", () => {
    const res = prepareSpeech("The disputed charge is 48,000 AED on your card.");
    expect(res.text).toBe("The disputed charge is forty-eight thousand dirhams on your card.");
    expect(res.text).not.toContain("48,000");
    expect(res.text).not.toContain("AED");
  });

  it("renders a year naturally", () => {
    expect(prepareSpeech("The transaction happened in March 2024.").text).toBe(
      "The transaction happened in March twenty twenty-four.",
    );
  });

  it("renders through the streaming word cap without cutting the amount off", () => {
    const res = prepareSpeech("You moved 48,000 AED to a new account.", { maxWords: 30 });
    expect(res.text).toContain("forty-eight thousand dirhams");
  });
});

describe("speech gate — the number pass does not weaken the other guards", () => {
  it("still redacts a card number sitting next to an amount", () => {
    const res = prepareSpeech("Card 4111 1111 1111 1111 was charged 48,000 AED.");
    expect(res.text).toContain("[REDACTED_PAN]");
    expect(res.text).toContain("forty-eight thousand dirhams");
    expect(res.text).not.toContain("4111");
  });

  it("still redacts a phone number in a sentence with an amount", () => {
    const res = prepareSpeech("Call 050 123 4567 about the 48,000 AED charge.");
    expect(res.text).toContain("[REDACTED_PHONE]");
    expect(res.text).toContain("forty-eight thousand dirhams");
  });

  it("still refuses urgency language that contains a number", () => {
    const res = prepareSpeech("Act now — you have 24 hours to respond.");
    expect(res.vishing.ok).toBe(false);
    expect(res.text).toBe("");
  });

  it("still protects the hang-up-safe exit from the word cap", () => {
    const long =
      "This call is recorded to protect you. I am calling about a transaction of 48,000 AED on your financing card, and I will explain everything carefully. You may hang up now and call your bank's official number from the back of your card. This verification stays valid for thirty minutes.";
    const res = prepareSpeech(long, { maxWords: 30 });
    expect(res.text).toContain("You may hang up now");
    expect(res.text).toContain("thirty minutes");
  });
});
