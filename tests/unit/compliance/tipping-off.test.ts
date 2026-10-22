import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_IDENTITY_EN, OPENING_DISCLOSURE_EN, auditAgentReply } from "@/lib/compliance/policy";
import { prepareSpeech } from "@/lib/compliance/speech-gate";
import { isTippingOff, tippingOffReply } from "@/lib/compliance/tipping-off";

describe("FATF tipping-off", () => {
  const TIP: Record<string, string> = {
    en: "We have filed a suspicious transaction report with the FIU.",
    ar: "تم تقديم بلاغ إلى الشرطة.",
    hi: "पुलिस को रिपोर्ट भेज दी है।",
    ur: "پولیس کو رپورٹ بھیج دی ہے۔",
    fr: "Nous allons déposer une plainte auprès de la police.",
    sw: "Tumepiga ripoti kwa polisi.",
  };

  test("every language recognizes the prohibited reporting sentence", () => {
    for (const [lang, text] of Object.entries(TIP)) {
      expect(isTippingOff(text, lang), lang).toBe(true);
      expect(tippingOffReply(lang).length, lang).toBeGreaterThan(20);
    }
  });

  test("notified the police is a filing, not merely report-to-police", () => {
    expect(isTippingOff("We have notified the police.", "en")).toBe(true);
    expect(isTippingOff("I have informed the regulator.", "en")).toBe(true);
  });

  test("a negated filing is not a tipping-off disclosure", () => {
    expect(isTippingOff("I will not file a report.", "en")).toBe(false);
    expect(isTippingOff("We never report this to the police.", "en")).toBe(false);
    const r = auditAgentReply({
      reply: "I will not file a report.",
      intent: "deny_fraud",
      isOpening: false,
      lang: "en",
    });
    expect(r.refused).toBeUndefined();
    expect(r.reply).toBe("I will not file a report.");
  });

  test("French 'police' meaning an insurance policy is not a filing", () => {
    expect(isTippingOff("Souhaitez-vous déclarer un sinistre sur votre police ?", "fr")).toBe(
      false,
    );
    expect(isTippingOff("Je vais signaler cela à la police.", "fr")).toBe(true);
  });

  test("the approved safety copy does not trip the guard", () => {
    for (const text of [
      "I have flagged this transaction as fraud and placed a temporary restriction on your card.",
      "Your account is temporarily restricted to protect your funds.",
      "You may hang up now and call the number on the back of your card.",
      "If anyone asks you to move money to a safe account, hang up.",
    ]) {
      expect(isTippingOff(text, "en"), text).toBe(false);
    }
    expect(isTippingOff("تم تقييد بطاقتك مؤقتاً لحمايتك.", "ar")).toBe(false);
  });

  test("auditAgentReply replaces the sentence instead of speaking it", () => {
    const r = auditAgentReply({
      reply: TIP.en!,
      intent: "deny_fraud",
      isOpening: false,
      lang: "en",
    });
    expect(r.refused).toBe(true);
    expect(r.reply).toBe(tippingOffReply("en"));
    expect(r.guardrails).toContain("refused:tipping_off");
  });

  test("an opening that tips off still receives the opening disclosure and AI identity", () => {
    const r = auditAgentReply({
      reply: "We have filed a report with the police.",
      intent: "greeting",
      isOpening: true,
      lang: "en",
    });
    expect(r.refused).toBe(true);
    expect(r.reply.startsWith(OPENING_DISCLOSURE_EN)).toBe(true);
    expect(r.reply).toContain(AI_IDENTITY_EN);
    expect(r.reply).toContain(tippingOffReply("en"));
    expect(r.reply.toLowerCase()).not.toContain("police");
    expect(r.reply.toLowerCase()).not.toContain("filed");
  });

  test("both TTS routes pass the request language into the speech gate", () => {
    const stream = readFileSync(
      join(process.cwd(), "src/app/api/tts/stream/route.ts"),
      "utf8",
    );
    const buffered = readFileSync(join(process.cwd(), "src/app/api/tts/route.ts"), "utf8");
    expect(stream).toContain("prepareSpeech(requestedText, { ...parsed.data.speech, lang })");
    expect(buffered).toContain("speech: { lang }");
    // The gate itself does the right thing once it is told the language.
    const out = prepareSpeech("تم تقديم بلاغ إلى الشرطة.", { lang: "ar" });
    expect(out.tippingOff).toBe(true);
    expect(out.text).toContain("تم تقييد حسابك");
  });

  test("prepareSpeech replaces it at the send boundary, never returns silence", () => {
    const out = prepareSpeech(TIP.en!, { lang: "en" });
    expect(out.tippingOff).toBe(true);
    expect(out.text).toBe(tippingOffReply("en"));
    expect(out.text.length).toBeGreaterThan(20);
    expect(out.vishing.ok).toBe(true);
  });

  test("the speech gate leaves approved copy alone", () => {
    const out = prepareSpeech("Your account is temporarily restricted to protect your funds.", {
      lang: "en",
    });
    expect(out.tippingOff).toBeUndefined();
    expect(out.text).toContain("temporarily restricted");
  });
});
