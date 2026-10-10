/**
 * RULE 5 — numbers rendered as speech, deterministically.
 *
 * The brief's canonical example: "forty-eight thousand dirhams", never
 * "48,000 AED". These tests assert the rule in both directions, because the
 * pass is only safe if it is BOTH:
 *
 *   - complete on quantities a human wrote to be read aloud (amounts, years,
 *     percentages, ordinals, fractions of a currency), and
 *   - blind to identifier-shaped digit runs, which must survive to be
 *     recognised by `redactPII` downstream. A renderer that words a card
 *     number makes a PAN unredactable — the one outcome worse than a
 *     mispronounced amount.
 */
import { describe, expect, it } from "bun:test";

import { integerToWords, renderNumbersAsSpeech } from "@/lib/compliance/spoken-numbers";
import { redactPII } from "@/lib/compliance/redactor";

describe("rule 5 — the canonical shapes", () => {
  it("renders the brief's example exactly", () => {
    expect(renderNumbersAsSpeech("48,000 AED")).toBe("forty-eight thousand dirhams");
  });

  it("renders an amount in a sentence", () => {
    expect(renderNumbersAsSpeech("The charge was 48,000 AED.")).toBe(
      "The charge was forty-eight thousand dirhams.",
    );
  });

  it("renders the currency word form too", () => {
    expect(renderNumbersAsSpeech("48,000 dirhams")).toBe("forty-eight thousand dirhams");
  });

  it("renders currency-first order", () => {
    expect(renderNumbersAsSpeech("AED 48,000")).toBe("forty-eight thousand dirhams");
  });

  it("renders a symbol currency", () => {
    expect(renderNumbersAsSpeech("$500")).toBe("five hundred dollars");
  });

  it("drops an unknown currency code rather than spelling its letters", () => {
    expect(renderNumbersAsSpeech("48,000 GBP")).toBe("forty-eight thousand");
    // The punctuation belongs to the sentence, not the currency.
    expect(renderNumbersAsSpeech("It was 48,000 GBP.")).toBe("It was forty-eight thousand.");
  });
});

describe("rule 5 — plain quantities", () => {
  it("renders small numbers", () => {
    expect(renderNumbersAsSpeech("Did you authorise this 1 charge?")).toBe(
      "Did you authorise this one charge?",
    );
    expect(renderNumbersAsSpeech("it was 48 dirhams ago")).toBe("it was forty-eight dirhams ago");
  });

  it("renders thousands in full, which scales past 9999", () => {
    expect(renderNumbersAsSpeech("2500")).toBe("two thousand five hundred");
    expect(renderNumbersAsSpeech("1,234,567")).toBe(
      "one million two hundred and thirty-four thousand five hundred and sixty-seven",
    );
  });

  it("renders a percentage", () => {
    expect(renderNumbersAsSpeech("3.5%")).toBe("three point five percent");
  });

  it("renders the fils of a currency fraction", () => {
    expect(renderNumbersAsSpeech("48,000.50 AED")).toBe(
      "forty-eight thousand dirhams and fifty fils",
    );
  });

  it("renders a decimal with no currency as point form", () => {
    expect(renderNumbersAsSpeech("version 2.5")).toBe("version two point five");
  });

  it("reads years as pairs", () => {
    expect(renderNumbersAsSpeech("in March 2024")).toBe("in March twenty twenty-four");
    expect(renderNumbersAsSpeech("since 2019")).toBe("since twenty nineteen");
  });

  it("renders ordinals", () => {
    expect(renderNumbersAsSpeech("the 3rd charge")).toBe("the third charge");
    expect(renderNumbersAsSpeech("your 21st transaction")).toBe("your twenty-first transaction");
  });

  it("renders integers through the helper at every scale", () => {
    expect(integerToWords(0)).toBe("zero");
    expect(integerToWords(19)).toBe("nineteen");
    expect(integerToWords(21)).toBe("twenty-one");
    expect(integerToWords(105)).toBe("one hundred and five");
    expect(integerToWords(1_000)).toBe("one thousand");
    expect(integerToWords(1_000_000)).toBe("one million");
  });
});

describe("rule 5 — identifier shapes are NOT touched", () => {
  it("leaves a spaced card number for the redactor", () => {
    const input = "The card ending 4111 1111 1111 1111 was used.";
    const rendered = renderNumbersAsSpeech(input);
    expect(rendered).toBe(input);
    // The whole point of leaving it alone: redaction still recognises it.
    expect(redactPII(rendered)).toContain("[REDACTED_PAN]");
  });

  it("leaves a solid card number for the redactor", () => {
    const input = "account 4111111111111111";
    expect(renderNumbersAsSpeech(input)).toBe(input);
    expect(redactPII(input)).toContain("[REDACTED_PAN]");
  });

  it("leaves a phone number in every common shape", () => {
    for (const phone of [
      "Call 050 123 4567 now",
      "call 050-123-4567",
      "+971501234567",
      "050 1234567",
    ]) {
      expect(renderNumbersAsSpeech(phone)).toBe(phone);
    }
  });

  it("leaves an SSN for the redactor", () => {
    const input = "My number is 123-45-6789";
    expect(renderNumbersAsSpeech(input)).toBe(input);
    expect(redactPII(input)).toContain("[REDACTED_SSN]");
  });

  it("leaves a long reference number alone", () => {
    const input = "reference 1234567";
    expect(renderNumbersAsSpeech(input)).toBe(input);
  });
});

describe("rule 5 — the gate's guarantees hold after rendering", () => {
  it("is idempotent", () => {
    const samples = [
      "The charge was 48,000 AED.",
      "in March 2024",
      "3.5%",
      "the 3rd charge of 2500 dirhams",
    ];
    for (const s of samples) {
      const once = renderNumbersAsSpeech(s);
      expect(renderNumbersAsSpeech(once)).toBe(once);
    }
  });

  it("never throws, whatever it is handed", () => {
    for (const s of ["", "no digits here", "9".repeat(400), "1,2,3,4,5", "....", "12,34"]) {
      expect(() => renderNumbersAsSpeech(s)).not.toThrow();
    }
  });

  it("leaves text without digits completely alone", () => {
    expect(renderNumbersAsSpeech("Was this charge yours?")).toBe("Was this charge yours?");
  });
});
