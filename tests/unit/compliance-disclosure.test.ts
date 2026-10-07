/**
 * UNIT — the two vendor-contract controls that were documented but not enforced.
 *
 * 1. THE OPENING DISCLOSURE, IN THE LANGUAGE THE CUSTOMER ACTUALLY HEARS.
 *    ElevenLabs requires that a user is "clearly and prominently" told they are
 *    speaking with an AI, and that the call is recorded. `src/lib/compliance/
 *    policy.ts` exported six `OPENING_DISCLOSURE_*` constants and the header
 *    called the rule "SERVER-ENFORCED" — but nothing imported them, so the
 *    enforcement was a comment. Meanwhile `firstMessageForLanguage` covered three
 *    languages and fell back to English for the other three, which means an Urdu,
 *    French or Swahili customer got a disclosure they might not understand, in a
 *    call that claims to be protecting them.
 *
 *    The fallback is gone. A language without a disclosure cannot be dialled.
 *
 * 2. PROHIBITED DATA NEVER LEAVES FOR THE VENDOR.
 *    ElevenAgents Terms §2.E forbids sending "any financial account identifiers
 *    (e.g., credit card numbers or bank account numbers)" to the platform without
 *    written agreement. The existing redaction guard covered the PERSIST path
 *    (audit log, webhook, dashboard). It did not cover the EGRESS path — the
 *    dynamic variables that become the agent's spoken context. A bank whose
 *    `transaction_ref` or merchant field carried a PAN was sending one to
 *    ElevenLabs on every call.
 *
 * Both controls are asserted here so they cannot silently regress again.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CALL_LANGUAGES,
  firstMessageForLanguage,
  isCallLanguage,
} from "@/lib/elevenlabs/outbound-call";
import {
  OPENING_DISCLOSURE_AR,
  OPENING_DISCLOSURE_EN,
  OPENING_DISCLOSURE_FR,
  OPENING_DISCLOSURE_HI,
  OPENING_DISCLOSURE_SW,
  OPENING_DISCLOSURE_UR,
} from "@/lib/compliance/policy";
import {
  containsAccountIdentifier,
  maskAccountIdentifiers,
  sanitizeDynamicVariables,
  sanitizeUntrusted,
  MAX_UNTRUSTED_LEN,
} from "@/lib/sanitize-untrusted";
import { TTS_LANGUAGE_SUPPORT } from "@/lib/elevenlabs/client";

const DISCLOSURE_BY_LANG: Record<string, string> = {
  en: OPENING_DISCLOSURE_EN,
  ar: OPENING_DISCLOSURE_AR,
  hi: OPENING_DISCLOSURE_HI,
  ur: OPENING_DISCLOSURE_UR,
  fr: OPENING_DISCLOSURE_FR,
  sw: OPENING_DISCLOSURE_SW,
};

describe("the opening disclosure exists in every callable language", () => {
  test("every advertised call language resolves to a message", () => {
    for (const lang of CALL_LANGUAGES) {
      const msg = firstMessageForLanguage(lang);
      expect(msg, `${lang} has no opening message and therefore cannot be dialled`).toBeTruthy();
      expect(msg!.length).toBeGreaterThan(30);
    }
  });

  test("each message contains that language's recorded-call disclosure constant", () => {
    for (const lang of CALL_LANGUAGES) {
      const msg = firstMessageForLanguage(lang)!;
      const disclosure = DISCLOSURE_BY_LANG[lang];
      expect(disclosure, `${lang} has no OPENING_DISCLOSURE constant`).toBeTruthy();
      // Substring, not equality: the message also carries the AI identity and
      // the reason for the call.
      expect(msg).toContain(disclosure);
    }
  });

  test("each message discloses that the caller is an AI, not a human", () => {
    // The vendor rule is about AI disclosure specifically; a recording notice
    // alone does not satisfy it. A Latin-script /AI/i test would have passed the
    // Arabic message while it said only "the intelligent security assistant",
    // so each language is checked against a term that actually means AI.
    const AI_TERM: Record<string, RegExp> = {
      en: /\bAI\b/,
      ar: /الذكاء الاصطناعي/,
      hi: /\bAI\b|कृत्रिम बुद्धिमत्ता/,
      ur: /\bAI\b|مصنوعتی ذہانت/,
      fr: /\bIA\b|intelligence artificielle/,
      sw: /\bAI\b|akili bandia/,
    };
    for (const lang of CALL_LANGUAGES) {
      const msg = firstMessageForLanguage(lang)!;
      expect(msg, `${lang} does not name AI in its own language`).toMatch(AI_TERM[lang]!);
    }
  });

  test("no language silently falls back to English", () => {
    const en = firstMessageForLanguage("en")!;
    for (const lang of CALL_LANGUAGES) {
      if (lang === "en") continue;
      expect(firstMessageForLanguage(lang)).not.toBe(en);
    }
  });

  test("an unsupported language resolves to null rather than to English", () => {
    expect(firstMessageForLanguage("zu")).toBeNull();
    expect(firstMessageForLanguage("")).toBeNull();
    expect(isCallLanguage("zu")).toBe(false);
    expect(isCallLanguage("ar")).toBe(true);
  });
});

describe("account identifiers are masked before they can reach the vendor", () => {
  const PAN = "4111111111111111";

  test("a PAN in a free-text field is masked, not forwarded", () => {
    const out = sanitizeUntrusted(`Electronics World ${PAN}`);
    expect(out).not.toContain(PAN);
    expect(out).toContain("[REDACTED:account_identifier]");
  });

  test("a PAN written with separators is caught, not just a bare digit run", () => {
    for (const variant of ["4111 1111 1111 1111", "4111-1111-1111-1111"]) {
      const out = sanitizeUntrusted(variant);
      expect(out).not.toContain("4111 1111");
      expect(out).not.toContain("4111-1111");
      expect(containsAccountIdentifier(variant)).toBe(true);
    }
  });

  test("a UAE IBAN is masked", () => {
    const iban = "AE070331234567890123456";
    const out = sanitizeUntrusted(`account ${iban}`);
    expect(out).not.toContain("0331234567890123456");
    expect(containsAccountIdentifier(iban)).toBe(true);
  });

  test("masking happens BEFORE the length cap, so a trailing PAN cannot hide past it", () => {
    // A 120-char merchant string with the PAN at the end. If the cap ran first
    // the digits would be truncated to a partial run that no longer matches the
    // identifier pattern, and the surviving prefix would be sent upstream.
    const long = `${"Riverside Shopping Centre ".repeat(4)}${PAN}`;
    expect(long.length).toBeGreaterThan(MAX_UNTRUSTED_LEN);

    const out = sanitizeUntrusted(long);
    expect(out.length).toBeLessThanOrEqual(MAX_UNTRUSTED_LEN);
    // The control is that no identifier digit survives. The marker itself sits
    // at the end here and is cut by the cap, which is harmless for the vendor
    // contract but means the audit never learns masking occurred — see
    // KNOWN GAP: sanitizeUntrusted discards maskAccountIdentifiers' count.
    expect(out).not.toMatch(/\d/);
  });

  test("a 12-digit transaction reference survives unmangled", () => {
    // The reason this guard is narrower than redact.transcript(): stripping
    // phone-shaped digits would corrupt the bank's own correlation key, and a
    // bank that cannot reconcile a call will not adopt the product.
    const ref = "TXN-2026-0914-5532";
    expect(containsAccountIdentifier(ref)).toBe(false);
    expect(sanitizeUntrusted(ref)).toBe(ref);
  });

  test("a millisecond epoch inside an identifier is NOT treated as a card number", () => {
    // Regression, and the reason Luhn + standalone are both required. A bare
    // 13-19 digit rule matched `TXN-<epoch>-<n>`, so every reference created in
    // the same millisecond masked to the identical string and the dial path
    // began refusing distinct transactions as duplicates (it broke WP-2).
    const epoch = Date.now();
    expect(String(epoch).length).toBeGreaterThanOrEqual(13);

    const a = sanitizeUntrusted(`TXN-${epoch}-3`);
    const b = sanitizeUntrusted(`TXN-${epoch}-4`);
    expect(a).toBe(`TXN-${epoch}-3`);
    expect(b).toBe(`TXN-${epoch}-4`);
    expect(a).not.toBe(b);
    expect(containsAccountIdentifier(`CONSENT-${epoch}-1`)).toBe(false);
    expect(containsAccountIdentifier(`idem-${epoch}-0`)).toBe(false);
  });

  test("Luhn is what separates a card number from a long digit run", () => {
    // 4111111111111111 and 5500000000000004 are standard test PANs (Luhn-valid).
    expect(containsAccountIdentifier("4111111111111111")).toBe(true);
    expect(containsAccountIdentifier("5500000000000004")).toBe(true);
    // Same length, fails Luhn.
    expect(containsAccountIdentifier("4111111111111112")).toBe(false);
  });

  test("a PAN embedded between separators is still caught when standalone", () => {
    expect(sanitizeUntrusted("card 4111 1111 1111 1111 on file")).not.toContain("4111 1111");
    expect(sanitizeUntrusted("card 4111-1111-1111-1111 on file")).not.toContain("4111-1111");
  });

  test("every dynamic variable is masked, not only the free-text one", () => {
    const vars = sanitizeDynamicVariables({
      merchant: `Shop ${PAN}`,
      transaction_ref: `ref ${PAN}`,
      amount: 250000,
      currency: "AED",
      case_id: "SV-A-1",
    });
    const serialised = JSON.stringify(vars);
    expect(serialised).not.toContain(PAN);
    // Non-identifier structured values are untouched — the amount is what the
    // customer needs to hear.
    expect(vars.amount).toBe(250000);
    expect(vars.currency).toBe("AED");
  });

  test("KNOWN LIMIT: a PAN glued behind a hyphen is not masked", () => {
    // Asserted, not hidden. The standalone rule cannot tell `T-4111111111111111`
    // apart from `TXN-1791325826155-3` — both are a hyphen followed by a long
    // digit run, and only one of them is a card number. Masking both breaks the
    // bank's correlation keys; masking neither is a hole. The resolution is
    // field-shape validation on transaction_ref, not a cleverer regex.
    expect(containsAccountIdentifier(`T-${PAN}`)).toBe(false);
  });

  test("masking reports how many identifiers it removed", () => {
    const r = maskAccountIdentifiers(`${PAN} and 5500000000000004`);
    expect(r.masked).toBe(2);
    expect(r.value).not.toContain(PAN);
  });
});

describe("the agent cannot execute the high-stakes decision itself", () => {
  /**
   * PUP §3(d) prohibits facilitating high-stakes automated decisions about an
   * individual's wellbeing; §3(b) requires a qualified professional to review
   * financial-services output. The control is that `card_freeze` stages a freeze
   * rather than performing one — so the tool must never be able to report a
   * committed freeze.
   *
   * Asserted against the source rather than a response fixture, because the
   * claim is "no path can do this", and only the source enumerates the paths.
   */
  const SOURCE = "src/app/api/elevenlabs/tools/card-freeze/route.ts";

  test("the freeze tool has no code path that commits a freeze", () => {
    const src = readFileSync(join(process.cwd(), SOURCE), "utf8");
    expect(src).not.toMatch(/committed:\s*true/);
    // And it does state the staged outcome, so the assertion above is not
    // passing because the field was removed entirely.
    expect(src).toMatch(/committed:\s*false/);
    expect(src).toMatch(/FREEZE_STAGED/);
  });

  test("a freeze that cannot be audited is refused rather than allowed through", () => {
    const src = readFileSync(join(process.cwd(), SOURCE), "utf8");
    expect(src).toMatch(/audit_unavailable/);
  });
});

describe("the TTS model can actually voice the language it is given", () => {
  test("urdu and swahili are not claimed as multilingual-v2 languages", () => {
    // eleven_multilingual_v2 = 29 languages; eleven_flash_v2_5 = those 29 plus
    // hu/no/vi. Neither carries ur or sw, and the code used to route sw to
    // flash v2.5 as if it did.
    expect(TTS_LANGUAGE_SUPPORT.ur.multilingual_v2).toBe(false);
    expect(TTS_LANGUAGE_SUPPORT.sw.multilingual_v2).toBe(false);
  });

  test("every callable language resolves to a model that supports it", () => {
    for (const lang of CALL_LANGUAGES) {
      const support = TTS_LANGUAGE_SUPPORT[lang as keyof typeof TTS_LANGUAGE_SUPPORT];
      expect(support, `${lang} is missing from the capability table`).toBeDefined();
      // Something must be able to voice it, or the language should not be advertised.
      expect(support.multilingual_v2 || support.v3).toBe(true);
    }
  });

  test("the capability table covers exactly the advertised languages", () => {
    expect(Object.keys(TTS_LANGUAGE_SUPPORT).sort()).toEqual([...CALL_LANGUAGES].sort());
  });
});
