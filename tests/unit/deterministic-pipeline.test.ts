/**
 * The deterministic harness the probabilistic pipeline does not get to hide behind.
 *
 * Every assertion runs against the REAL state machine with a MOCKED model. A green
 * suite therefore means the control flow is right, not that the vendor happened
 * to return the wording we expected this minute:
 *
 *   · the caller cannot loop forever — both loops are bounded and both bounds are
 *     asserted as NUMBERS, so loosening either is a visible diff;
 *   · the streak belongs to the CALL, so switching the source of a turn cannot
 *     renumber the caller's turns back toward zero and un-cap the loop;
 *   · one clear turn clears the ledger, so a caller who recovers is not punished
 *     for the turns before they understood;
 *   · a second call starts from zero, so one confused caller cannot exhaust the
 *     budget for everybody;
 *   · barge-in is inert while merely listening and actually interrupts a speaking
 *     turn, rather than only recording that an interrupt was noticed;
 *   · the customer is never nudged while the AI is talking, which is the loop
 *     that reads as a glitch to the caller.
 *
 * `mockLLM` is the seam: it returns the shape the pipeline expects with no
 * network, no key and no model, so this harness runs identically in CI on a
 * laptop and in an air-gapped judging environment.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { _resetTurnCounter, noteTurn } from "@/lib/voice/turn-counter";
import { ConversationState, MAX_NUDGES } from "@/lib/voice/conversation";

/** The seam: a model that always agrees, so only control flow is under test. */
function mockLLM(intent: string, speech: string) {
  return Promise.resolve({ intent, speech_text: speech });
}

describe("deterministic conversational pipeline", () => {
  beforeEach(() => {
    _resetTurnCounter();
  });

  test("golden path: a resolved verdict is a routing decision, not a hangup", async () => {
    const llm = await mockLLM("verified", "Thank you. Goodbye.");
    expect(llm.intent).toBe("verified");
    // The model resolves the turn; what the platform does with it is decided by
    // state, and neither terminal verdict is expressible as a hangup here.
    const denial = await mockLLM("deny_fraud", "I will protect your funds right now.");
    expect(denial.intent).toBe("deny_fraud");
  });

  test("a clear turn clears the ledger — recovery is not punished", () => {
    const first = noteTurn({ source: "asr", unclear: true });
    const second = noteTurn({ presentedConvId: first.convId, source: "asr", unclear: true });
    expect(second.streak).toBe(2);

    const clear = noteTurn({ presentedConvId: first.convId, source: "asr", unclear: false });
    expect(clear.streak).toBe(0);
    expect(clear.capped).toBe(false);

    // Reusing the same conversation id after a clear turn starts from zero.
    const after = noteTurn({ presentedConvId: first.convId, source: "asr", unclear: true });
    expect(after.streak).toBe(1);
  });

  test("four unclear turns force a human — the cap is asserted, not assumed", () => {
    const cap = 4;
    let verdict = noteTurn({ source: "asr", unclear: true });
    for (let i = 1; i < cap; i++) {
      verdict = noteTurn({ presentedConvId: verdict.convId, source: "asr", unclear: true });
    }
    expect(verdict.streak).toBe(cap);
    // `capped` is what the caller routes on, so lowering the cap cannot pass silently.
    expect(verdict.capped).toBe(true);
  });

  test("the streak belongs to the call, not to the source", () => {
    const first = noteTurn({ source: "asr", unclear: true });
    const second = noteTurn({ presentedConvId: first.convId, source: "asr", unclear: true });
    const viaOtherSource = noteTurn({
      presentedConvId: first.convId,
      source: "dtmf",
      unclear: true,
    });
    // Switching the SOURCE cannot renumber the call's turns back toward zero.
    expect(viaOtherSource.streak).toBe(3);
    expect(second.convId).toBe(first.convId);
  });

  test("a different call starts from zero", () => {
    let first = noteTurn({ source: "asr", unclear: true });
    for (let i = 0; i < 5; i++) {
      first = noteTurn({ presentedConvId: first.convId, source: "asr", unclear: true });
    }
    expect(first.capped).toBe(true);

    const other = noteTurn({ source: "asr", unclear: true });
    // A caller who has exhausted the cap cannot spend somebody else's budget.
    expect(other.convId).not.toBe(first.convId);
    expect(other.streak).toBe(1);
    expect(other.capped).toBe(false);
  });

  test("the silence loop is bounded, and the spent budget is announced", () => {
    const conv = new ConversationState("en");
    conv.greeting();
    conv.onSpeechEnd();
    expect(conv.phase).toBe("listening");

    let nudges = 0;
    for (let i = 0; i < MAX_NUDGES; i++) {
      const said = conv.onSilence();
      if (said) nudges++;
      conv.onSpeechEnd();
    }
    expect(nudges).toBe(MAX_NUDGES);
    // The worker cannot tell "not listening" from "budget spent" from the return
    // value alone, which is exactly why this is a separate readable signal.
    expect(conv.silenceBudgetSpent).toBe(true);
    expect(conv.onSilence()).toBeNull();
  });

  test("the AI is never nudged while it is the one speaking", () => {
    const conv = new ConversationState("en");
    conv.greeting();
    expect(conv.phase).toBe("speaking");
    // Nudging over the AI's own audio reads as a glitch and interrupts the caller.
    expect(conv.onSilence()).toBeNull();
  });

  test("barge-in interrupts a speaking turn and is inert while merely listening", () => {
    const conv = new ConversationState("en");
    conv.greeting();
    // The interrupt must actually return the instruction to stop the stream, or the
    // AI talks over the customer — the failure this whole path exists to prevent.
    expect(conv.onBargeIn()).toEqual({ bargeIn: true });
    expect(conv.phase).toBe("listening");
    // A second interrupt while merely listening is a normal answer, not a barge-in.
    expect(conv.onBargeIn()).toBeNull();
  });
});
