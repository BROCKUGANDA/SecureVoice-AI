/**
 * Conversational state machine — the property under test is the WIRING RULES,
 * not any vendor. Every rule the pasted spec demanded is asserted here WITHOUT
 * a live WebSocket, because conversation.ts is pure:
 *
 *   · greeting fires exactly once at T+0 and never again;
 *   · barge-in interrupts while SPEAKING, but not while merely LISTENING;
 *   · the silence nudge never fires while the AI is talking (no over-talking),
 *     and is bounded so it can never loop "are you there?" forever;
 *   · answering resets the dead-air budget; the copy is present in all six
 *     languages and is not an English string with a TODO.
 */
import { describe, expect, test } from "bun:test";
import {
  ConversationState,
  OPENING,
  NUDGE,
  MAX_NUDGES,
  type ConvLang,
} from "@/lib/voice/conversation";

const LANGS: ConvLang[] = ["en", "ar", "hi", "ur", "fr", "sw"];

describe("opening and nudge copy", () => {
  test("every language has a non-empty opening and nudge", () => {
    for (const lang of LANGS) {
      expect(OPENING[lang]?.length ?? 0).toBeGreaterThan(0);
      expect(NUDGE[lang]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("each language's copy is distinct (not English with a TODO)", () => {
    const openings = new Set(LANGS.map((l) => OPENING[l]));
    const nudges = new Set(LANGS.map((l) => NUDGE[l]));
    expect(openings.size).toBe(LANGS.length);
    expect(nudges.size).toBe(LANGS.length);
  });

  test("no copy contains markdown or emoji that TTS would mangle", () => {
    for (const lang of LANGS) {
      for (const text of [OPENING[lang], NUDGE[lang]]) {
        expect(text).not.toMatch(/[*#_`]|[\u{1F300}-\u{1FAFF}]/u);
      }
    }
  });
});

describe("greeting lifecycle", () => {
  test("greeting speaks once at T+0, then the machine is speaking", () => {
    const c = new ConversationState("en");
    const first = c.greeting();
    expect(first).not.toBeNull();
    expect(first && "speak" in first && first.speak).toBe(OPENING.en);
    expect(c.phase).toBe("speaking");
  });

  test("a second greeting is idempotent — it does not double-open the call", () => {
    const c = new ConversationState("en");
    c.greeting();
    expect(c.greeting()).toBeNull();
  });

  test("onSpeechEnd moves speaking to listening, and is a no-op elsewhere", () => {
    const c = new ConversationState("en");
    c.greeting();
    c.onSpeechEnd();
    expect(c.phase).toBe("listening");
    c.onSpeechEnd(); // still listening
    expect(c.phase).toBe("listening");
  });

  test("greeting copy follows the call language", () => {
    const c = new ConversationState("ur");
    expect(c.greeting()).toEqual({ speak: OPENING.ur });
  });
});

describe("barge-in", () => {
  test("fires only while the AI is speaking", () => {
    const c = new ConversationState("en");
    c.greeting(); // speaking
    expect(c.onBargeIn()).toEqual({ bargeIn: true });
    expect(c.phase).toBe("listening"); // we stopped talking, now we listen
  });

  test("does NOT fire while merely listening (a normal answer)", () => {
    const c = new ConversationState("en");
    c.greeting();
    c.onSpeechEnd(); // listening
    expect(c.onBargeIn()).toBeNull();
  });

  test("does NOT fire before the greeting", () => {
    const c = new ConversationState("en");
    expect(c.onBargeIn()).toBeNull();
  });
});

describe("silence nudge", () => {
  /** Advance a machine to the LISTENING state. */
  const listening = () => {
    const c = new ConversationState("en");
    c.greeting();
    c.onSpeechEnd();
    return c;
  };

  test("nudges a silent caller while listening", () => {
    const c = listening();
    const nudge = c.onSilence();
    expect(nudge).toEqual({ speak: NUDGE.en });
    expect(c.phase).toBe("speaking"); // the nudge itself is the AI talking
  });

  test("never nudges while the AI is talking (no talking over the caller)", () => {
    const c = new ConversationState("en");
    c.greeting(); // speaking
    expect(c.onSilence()).toBeNull();
  });

  test("never nudges before the greeting (idle)", () => {
    const c = new ConversationState("en");
    expect(c.onSilence()).toBeNull();
  });

  test("is bounded — it cannot loop forever", () => {
    const c = listening();
    let fired = 0;
    for (let i = 0; i < MAX_NUDGES + 5; i++) {
      const nudge = c.onSilence();
      if (nudge) {
        fired++;
        c.onSpeechEnd(); // nudge drained, listening again
      }
    }
    expect(fired).toBe(MAX_NUDGES);
  });

  test("answering resets the dead-air budget for the next turn", () => {
    const c = listening();
    // Burn this turn's whole nudge budget.
    for (let i = 0; i < MAX_NUDGES; i++) {
      expect(c.onSilence()).not.toBeNull();
      c.onSpeechEnd();
    }
    expect(c.onSilence()).toBeNull(); // budget spent

    // The caller answers, is routed, and a reply plays then drains.
    c.markThinking();
    c.beginSpeaking();
    c.onSpeechEnd(); // back to listening, with a fresh budget

    expect(c.onSilence()).not.toBeNull(); // can nudge again next turn
  });

  test("no nudge fires while a routed reply is being chosen (thinking)", () => {
    const c = listening();
    c.markThinking();
    expect(c.onSilence()).toBeNull();
  });
});

describe("language wiring", () => {
  test("nudge copy is chosen by the call language", () => {
    for (const lang of LANGS) {
      const c = new ConversationState(lang);
      c.greeting();
      c.onSpeechEnd();
      expect(c.onSilence()).toEqual({ speak: NUDGE[lang] });
    }
  });
});
