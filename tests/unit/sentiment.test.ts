/**
 * UNIT — distress / panic detection (src/lib/sentiment.ts).
 *
 * This is the signal that flags a call for human takeover, so its two halves are
 * asymmetric on purpose and both are pinned here:
 *
 *   · Escalation is CONSERVATIVE. Distress and third-party pressure escalate;
 *     confusion alone does not. "when in doubt, hand to a human" — but a confused
 *     customer is not a panicking one, and escalating on every "what?" would
 *     make the signal useless.
 *   · Precedence is DISTINCTNESS-ordered: distress beats third-party pressure
 *     beats confusion. A turn containing both "help" and "someone is telling me"
 *     must report the more specific distress reason, because that reason is what
 *     an operator reads.
 *
 * The repetition heuristic is the subtle one: it fires when a short turn repeats
 * itself, so the boundary between "agitated" and "just a short sentence" is a
 * real property worth pinning rather than an accident.
 */
import { describe, expect, test } from "bun:test";
import { analyzeSentiment } from "@/lib/sentiment";

describe("analyzeSentiment — distress", () => {
  test("flags panic vocabulary and escalates", () => {
    for (const text of [
      "I am panicking",
      "please help me",
      "I am terrified",
      "someone called the police",
    ]) {
      const r = analyzeSentiment(text);
      expect(r.sentiment).toBe("distressed");
      expect(r.escalate).toBe(true);
      expect(r.reason).toBeDefined();
    }
  });

  test("matches distress case-insensitively", () => {
    expect(analyzeSentiment("HELP ME PLEASE").sentiment).toBe("distressed");
    expect(analyzeSentiment("Panicking").sentiment).toBe("distressed");
  });

  test("the reason names the marker that fired", () => {
    // The reason is what an operator reads, so it must identify the trigger.
    const r = analyzeSentiment("I am really scared right now");
    expect(r.reason).toContain("distress marker");
  });

  test("covers the non-English markers", () => {
    const cases: Array<[string, string]> = [
      ["أنا خائف", "arabic"],
      ["डर गया मुझे", "hindi"],
      ["مجھے مدد چاہیے", "urdu"],
      ["j'ai peur", "french"],
      ["naogopa", "swahili"],
    ];
    for (const [text, lang] of cases) {
      const r = analyzeSentiment(text);
      expect({ lang, sentiment: r.sentiment }).toEqual({ lang, sentiment: "distressed" });
    }
  });

  test("money-loss phrasing escalates", () => {
    expect(analyzeSentiment("they took all my money").sentiment).toBe("distressed");
    expect(analyzeSentiment("my savings are gone").sentiment).toBe("distressed");
  });
});

describe("analyzeSentiment — third-party pressure", () => {
  test("live coaching escalates and is labelled as such", () => {
    const r = analyzeSentiment("someone is telling me what to say");
    expect(r.sentiment).toBe("distressed");
    expect(r.escalate).toBe(true);
    expect(r.reason).toBe("possible live coaching / third-party pressure");
  });

  test("distress outranks third-party pressure in the reported reason", () => {
    // Both markers are present; the distress reason is the more actionable one.
    const r = analyzeSentiment("help me, someone is telling me what to say");
    expect(r.sentiment).toBe("distressed");
    expect(r.reason).toContain("distress marker");
  });
});

describe("analyzeSentiment — confusion does not escalate", () => {
  test("confusion is reported as confused and is NOT escalated", () => {
    const r = analyzeSentiment("I don't understand what you mean");
    expect(r.sentiment).toBe("confused");
    expect(r.escalate).toBe(false);
  });

  test("confusion outranks the repetition heuristic", () => {
    const r = analyzeSentiment("what? what? I don't understand");
    expect(r.sentiment).toBe("confused");
    expect(r.escalate).toBe(false);
  });
});

describe("analyzeSentiment — agitation by repetition", () => {
  test("a repeated short turn reads as agitation and escalates", () => {
    const r = analyzeSentiment("help help help");
    // "help" is itself a distress marker, so use a neutral token to isolate the
    // heuristic rather than accidentally re-testing the distress list.
    const neutral = analyzeSentiment("again again again again");
    expect(neutral.sentiment).toBe("distressed");
    expect(neutral.escalate).toBe(true);
    expect(neutral.reason).toBe("repetitive/agitated phrasing");
    expect(r.sentiment).toBe("distressed");
  });

  test("varied words of similar length are not agitation", () => {
    const r = analyzeSentiment("alpha bravo charlie delta echo foxtrot");
    expect(r.sentiment).toBe("calm");
  });

  test("a short turn below the repetition threshold stays calm", () => {
    // Two words cannot trip a rule that requires at least three.
    expect(analyzeSentiment("yes sure").sentiment).toBe("calm");
  });
});

describe("analyzeSentiment — calm", () => {
  test("ordinary text is calm with no reason and no escalation", () => {
    const r = analyzeSentiment("Thank you, that is all I needed today.");
    expect(r).toEqual({ sentiment: "calm", escalate: false });
  });

  test("empty and whitespace input is calm, not an error", () => {
    expect(analyzeSentiment("").sentiment).toBe("calm");
    expect(analyzeSentiment("   ").sentiment).toBe("calm");
  });

  test("a long varied sentence stays calm", () => {
    const r = analyzeSentiment(
      "I would like to ask about the fee on my account because it looked higher than last month and I want to understand why",
    );
    expect(r.sentiment).toBe("calm");
    expect(r.escalate).toBe(false);
  });
});

describe("analyzeSentiment — return contract", () => {
  test("every result carries a sentiment from the declared scale", () => {
    const inputs = ["", "help", "what?", "alpha bravo", "I am panicking"];
    for (const text of inputs) {
      const r = analyzeSentiment(text);
      expect(["calm", "distressed", "confused"]).toContain(r.sentiment);
      expect(typeof r.escalate).toBe("boolean");
    }
  });

  test("escalate is never true for a calm result", () => {
    for (const text of ["good morning", "yes", "thanks a lot"]) {
      const r = analyzeSentiment(text);
      if (r.sentiment === "calm") expect(r.escalate).toBe(false);
    }
  });
});
