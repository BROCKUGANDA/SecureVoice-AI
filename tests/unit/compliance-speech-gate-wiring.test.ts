/**
 * THE GATE IS ON THE WIRE — not merely correct as a module.
 *
 * A compliance function that nothing calls is documentation. These tests drive
 * the real send paths and assert the gate is crossed BEFORE anything can spend a
 * vendor call or reach a customer's handset. Each one fails if someone removes
 * the `prepareSpeech` call at that boundary, because the un-gated path would try
 * to reach ElevenLabs instead of stopping.
 *
 * No network is used: every assertion is made on the decision the path takes
 * when the gate empties or rewrites the text.
 */
import { describe, expect, it } from "bun:test";

import { ElevenLabsStream } from "@/lib/voice/elevenlabs-stream";
import { tts } from "@/lib/elevenlabs/client";
import { interventionTwiml } from "@/lib/twilio";

const OPTIONS = {
  apiKey: "test-key-must-never-be-used",
  voiceId: "voice-1",
};

describe("media-streams TTS send path", () => {
  it("sends no audio at all when the gate empties the text", async () => {
    const stream = new ElevenLabsStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream.streamText("🙂", OPTIONS)) chunks.push(chunk);

    // Zero chunks means it stopped before importing the SDK and before opening
    // a billable request. Without the gate this line would reach for a network.
    expect(chunks).toHaveLength(0);
  });

  it("sends no audio for whitespace and markdown-only input", async () => {
    const stream = new ElevenLabsStream();
    const collect = async (text: string) => {
      const out: Buffer[] = [];
      for await (const chunk of stream.streamText(text, OPTIONS)) out.push(chunk);
      return out;
    };

    expect(await collect("   ")).toHaveLength(0);
    expect(await collect("###")).toHaveLength(0);
    expect(await collect("** **")).toHaveLength(0);
  });
});

describe("buffered TTS send path", () => {
  it("refuses with 422 before any vendor call when nothing survives the gate", async () => {
    let status = 0;
    try {
      await tts({
        text: "🙂",
        voice: "jam",
        lang: "en",
        callerId: "caller-1",
        callRef: "SV-S-TEST1",
      });
    } catch (err) {
      status = (err as { status?: number }).status ?? 0;
    }
    expect(status).toBe(422);
  });

  it("refuses an empty string the same way", async () => {
    let code = "";
    try {
      await tts({
        text: "",
        voice: "jam",
        lang: "en",
        callerId: "caller-2",
        callRef: "SV-S-TEST2",
      });
    } catch (err) {
      code = (err as { code?: string }).code ?? "";
    }
    expect(code).toBe("empty_after_gate");
  });
});

describe("TwiML opening disclosure", () => {
  const script = { lang: "en" as const, merchant: "Dubai Electronics", amount: "2500" };

  it("leaves a conventional tenant's wording alone", () => {
    const twiml = interventionTwiml(
      script.lang,
      script.amount,
      script.merchant,
      null,
      "SV-C-TEST",
      null,
      { shariahCompliant: false },
    );
    expect(twiml).toContain("<Say");
    expect(twiml).not.toContain("takaful");
  });

  it("substitutes prohibited terminology for a Shariah-compliant tenant", () => {
    // "interest" is in the canonical sentence only when the tenant is Islamic,
    // so assert on a merchant name that carries a rule term instead: the gate
    // rewrites whatever the approved script produced.
    const conventional = interventionTwiml(
      script.lang,
      script.amount,
      "Auto Insurance Ltd",
      null,
      "SV-C-TEST",
      null,
      { shariahCompliant: false },
    );
    const shariah = interventionTwiml(
      script.lang,
      script.amount,
      "Auto Insurance Ltd",
      null,
      "SV-C-TEST",
      null,
      { shariahCompliant: true },
    );

    expect(conventional).toContain("Auto Insurance Ltd");
    expect(shariah).toContain("Auto Takaful Ltd");
    expect(shariah).not.toContain("Auto Insurance Ltd");
  });

  it("still escapes XML after gating, so a substituted term cannot break out", () => {
    const twiml = interventionTwiml(
      script.lang,
      "2500",
      'Dubai"><script>alert(1)</script>',
      null,
      "SV-C-TEST",
      null,
      { shariahCompliant: true },
    );
    expect(twiml).not.toContain("<script>alert(1)</script>");
    expect(twiml).toContain("&lt;script&gt;");
  });
});
