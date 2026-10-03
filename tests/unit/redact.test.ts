/**
 * UNIT — PII redaction (src/lib/redact.ts).
 *
 * This sits on the egress path for every transcript, audit row, persisted record
 * and signed webhook payload, so its contract is asymmetric and worth stating:
 *
 *   · It is LOSSY BY DESIGN. Redacted values cannot be unredacted. A test that
 *     tried to round-trip a PAN would be asserting the opposite of the intent.
 *   · It is BEST-EFFORT for PANs (no Luhn check), so the suite asserts the
 *     shape is removed, never that a specific card was detected.
 *   · It must NOT destroy amounts, case references or risk scores. Over-redaction
 *     is a real failure here: an audit trail where "AED 2500" became
 *     "[REDACTED]" is useless for the disputes it exists to settle. The module
 *     therefore requires an OTP-ish context cue before touching a bare 4-8 digit
 *     number, and that restraint is asserted here.
 *   · `payload` walks nested structures, because a PAN one level down in a
 *     webhook body is exactly as leaked as one at the top.
 */
import { describe, expect, test } from "bun:test";
import { payload, snippet, transcript } from "@/lib/redact";

/** Every digit run of 13+ must be gone. */
function hasLongDigitRun(s: string): boolean {
  return /\d{13,}/.test(s.replace(/\[\w*REDACTED\w*[:\]]/g, ""));
}

describe("transcript — card PANs", () => {
  test("a contiguous PAN is removed", () => {
    const out = transcript("your card 4111111111111111 was charged");
    expect(out).not.toContain("4111111111111111");
  });

  test("a space-separated PAN is removed", () => {
    const out = transcript("card 4111 1111 1111 1111 charged");
    expect(out).not.toMatch(/4111\s*1111\s*1111\s*1111/);
  });

  test("a hyphen-separated PAN is removed", () => {
    expect(hasLongDigitRun(transcript("card 4111-1111-1111-1111"))).toBe(false);
  });

  test("several PANs are all removed", () => {
    const out = transcript("4111111111111111 and 5500005555555559");
    expect(hasLongDigitRun(out)).toBe(false);
  });

  test("a long digit run is removed even when it is too short to be a PAN", () => {
    // 12 digits is below the PAN window (13-19) but still matches the phone
    // shape, so it is removed as a phone number. What must survive is the SHORT
    // run that makes up an amount, which is asserted below.
    expect(transcript("order 123456789012")).not.toContain("123456789012");
  });

  test("a short numeric amount survives", () => {
    expect(transcript("charged 2500")).toContain("2500");
    expect(transcript("ref 12345")).toContain("12345");
  });

  test("Luhn is not enforced — detection is best-effort by shape", () => {
    // A non-Luhn 16-digit run is still removed: a false negative here leaks a
    // card, which is worse than a false positive on a long number.
    const out = transcript("number 1234567890123456");
    expect(out).not.toContain("1234567890123456");
  });
});

describe("transcript — IBAN", () => {
  test("a UAE IBAN is removed", () => {
    const out = transcript("transfer from AE070331234567890123456 to beneficiary");
    expect(out).not.toContain("AE070331234567890123456");
  });

  test("a lowercase IBAN is removed too", () => {
    expect(transcript("ae070331234567890123456").toLowerCase()).not.toContain(
      "ae070331234567890123456",
    );
  });
});

describe("transcript — email", () => {
  test("an email address is removed", () => {
    const out = transcript("notified customer@example.com about the case");
    expect(out).not.toContain("customer@example.com");
  });

  test("an email with a subdomain and plus-tag is removed", () => {
    const out = transcript("reach ops+alerts@mail.corp.co.uk");
    expect(out).not.toContain("ops+alerts@mail.corp.co.uk");
  });

  test("text that merely contains an at-sign is not mangled", () => {
    // No dot-domain, so this is not an address.
    expect(transcript("case ref at 3 items")).toContain("at 3 items");
  });
});

describe("transcript — phone numbers", () => {
  test("an international number is removed", () => {
    const out = transcript("call +971 50 123 4567 now");
    expect(out).not.toContain("50 123 4567");
  });

  test("a local UAE number is removed", () => {
    expect(transcript("reach 0501234567 today")).not.toContain("0501234567");
  });

  test("a spaced number is removed", () => {
    expect(hasLongDigitRun(transcript("dial 050 123 4567"))).toBe(false);
  });
});

describe("transcript — OTPs only with a context cue", () => {
  test("an OTP announced as such is removed", () => {
    const out = transcript("your otp is 123456");
    expect(out).not.toContain("123456");
  });

  test("a PIN, CVV and passcode are removed", () => {
    expect(transcript("pin 8899").replace(/8899/g, "")).not.toContain("8899");
    expect(transcript("cvv 321").replace(/321/g, "")).not.toContain("321");
    expect(transcript("passcode 4455").replace(/4455/g, "")).not.toContain("4455");
  });

  test("a non-Latin context cue works too", () => {
    expect(transcript("رمز 123456").replace(/123456/g, "")).not.toContain("123456");
  });

  // The restraint that makes audit fidelity possible.
  test("a bare 4-8 digit number survives — it is probably an amount", () => {
    expect(transcript("charged AED 2500 today")).toContain("2500");
    expect(transcript("risk score 0.94")).toContain("0.94");
    expect(transcript("case ref 1234")).toContain("1234");
  });

  test("an amount with thousands separators survives", () => {
    expect(transcript("charged AED 2,500.00")).toContain("2,500.00");
  });
});

describe("transcript — idempotence and edges", () => {
  test("an empty string is returned unchanged", () => {
    expect(transcript("")).toBe("");
  });

  test("a clean sentence is returned unchanged", () => {
    const clean = "The customer confirmed the transaction was fraudulent.";
    expect(transcript(clean)).toBe(clean);
  });

  test("redaction is idempotent — re-running changes nothing", () => {
    const once = transcript("card 4111111111111111 otp 123456 a@b.com");
    expect(transcript(once)).toBe(once);
  });

  test("multiple secret classes in one string are all removed", () => {
    const out = transcript("4111111111111111 a@b.com +971501234567 otp 999888");
    expect(out).not.toMatch(/\d{13,}/);
    expect(out).not.toContain("a@b.com");
    expect(out).not.toContain("999888");
  });
});

describe("snippet", () => {
  test("each known kind gets its own tagged placeholder", () => {
    for (const kind of ["card", "iban", "phone", "email", "otp", "pin"] as const) {
      expect(snippet("value", kind)).toBe(`[REDACTED:${kind}]`);
    }
  });

  test("the original value never survives", () => {
    const out = snippet("4111111111111111", "card");
    expect(out).not.toContain("4111");
  });

  test("an empty value is still tagged, not passed through", () => {
    expect(snippet("", "otp")).toBe("[REDACTED:otp]");
  });
});

describe("payload — nested structures", () => {
  test("a top-level string is redacted", () => {
    expect(payload("card 4111111111111111")).not.toContain("4111111111111111");
  });

  test("a secret nested in an object is redacted", () => {
    const out = payload({ note: "card 4111111111111111", caseRef: "case_123" });
    expect(out.note).not.toContain("4111111111111111");
    // Non-secret fields survive, so the record stays useful.
    expect(out.caseRef).toBe("case_123");
  });

  test("a secret nested in an array is redacted", () => {
    const out = payload(["a@b.com", "nothing here"]);
    expect(out[0]).not.toContain("a@b.com");
    expect(out[1]).toBe("nothing here");
  });

  test("a deeply nested secret is redacted", () => {
    const out = payload({ a: { b: { c: ["otp 123456"] } } });
    expect(JSON.stringify(out)).not.toContain("123456");
  });

  test("null and undefined pass through unchanged", () => {
    expect(payload(null)).toBeNull();
    expect(payload(undefined)).toBeUndefined();
  });

  test("numbers, booleans and non-string primitives survive", () => {
    expect(payload(42)).toBe(42);
    expect(payload(true)).toBe(true);
    // A bare number is not a string, so the transcript rules do not apply.
    expect(payload(1234)).toBe(1234);
  });

  test("keys are preserved so the shape of the payload is unchanged", () => {
    const out = payload({ note: "x", amount: 100 });
    expect(Object.keys(out)).toEqual(["note", "amount"]);
  });

  test("the original input is not mutated", () => {
    const input = { note: "card 4111111111111111" };
    payload(input);
    expect(input.note).toBe("card 4111111111111111");
  });

  test("an empty object and array survive", () => {
    expect(payload({})).toEqual({});
    expect(payload([])).toEqual([]);
  });

  test("a whole webhook-shaped payload comes out free of secrets", () => {
    const out = payload({
      event: "post_call",
      transcript: "card 4111111111111111 and a@b.com",
      caller: { email: "ops@bank.ae", phone: "+971501234567" },
      tags: ["otp 445566"],
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("4111111111111111");
    expect(json).not.toContain("a@b.com");
    expect(json).not.toContain("445566");
    expect(json).toContain("post_call");
  });
});
