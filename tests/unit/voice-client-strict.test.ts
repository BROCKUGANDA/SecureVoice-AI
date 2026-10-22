import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { speakText } from "@/lib/voice-client";

/**
 * Strict mode is the demo/scenario contract: the ElevenLabs agent voice or
 * nothing. The device voice is never a substitute, because the page says the
 * visitor is hearing the agent.
 */

const realFetch = globalThis.fetch;
const realWindow = (globalThis as unknown as { window?: unknown }).window;
const realUtterance = (globalThis as unknown as { SpeechSynthesisUtterance?: unknown })
  .SpeechSynthesisUtterance;

let speaks = 0;

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  lang = "";
  rate = 1;
  voice: unknown = null;
}

const fakeWindow = {
  speechSynthesis: {
    cancel() {},
    speak(u: FakeUtterance) {
      speaks += 1;
      u.onend?.();
    },
    getVoices() {
      return [];
    },
  },
};

beforeEach(() => {
  speaks = 0;
  (globalThis as unknown as { window?: unknown }).window = fakeWindow;
  (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance =
    FakeUtterance;
  globalThis.fetch = (async () => {
    throw new Error("tts 503");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as unknown as { window?: unknown }).window = realWindow;
  (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance =
    realUtterance;
});

describe("strict ElevenLabs demo voice", () => {
  test("a failed synthesis is silent, not the device voice", async () => {
    const outcome = await speakText("strict demo line a", "en", "agent", 1, { strict: true });
    expect(outcome.neural).toBe(false);
    expect(speaks).toBe(0);
  });

  test("the non-strict path still falls back to the device voice", async () => {
    const outcome = await speakText("non-strict demo line b", "en", "agent", 1);
    expect(outcome.neural).toBe(false);
    expect(speaks).toBe(1);
  });
});
