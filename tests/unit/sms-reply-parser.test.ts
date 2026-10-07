/**
 * UNIT - turning a customer's text message into a fraud verdict.
 *
 * The parser is the single place where free text becomes a decision that reaches
 * a bank, so every test here is a way it could be wrong in the DANGEROUS
 * direction:
 *
 *   - SUBSTRING MATCHING. The obvious implementation is `body.includes("no")`.
 *     That reads "I don't KNOW", "NOT sure", "nothing" and "maybe NOW" as a
 *     fraud report, and "yesterday" or "eyes" as a confirmation. Matching is
 *     whole-message and exact, so none of these are answers.
 *   - CONTRADICTION. "YES NO" must not resolve to either.
 *   - LOOKALIKES. Zero-width characters and fullwidth letters are folded, so a
 *     genuine "ＹＥＳ" works - but an invisible character cannot be used to make
 *     one message parse differently from how it displays.
 *   - STOP. Opt-out must always win, in any case, with any punctuation.
 *
 * What a wrong answer costs is asymmetric on purpose: NO escalates to a human
 * reviewer, YES only records the customer's claim. An unclear message is asked
 * again, never guessed.
 */
import { describe, expect, test } from "bun:test";

const { parseSmsReply, REPLY_WINDOW_MS } = await import("@/lib/sms-verdict");

describe("unambiguous answers", () => {
  test("YES in the shapes real people type it", () => {
    for (const s of [
      "YES",
      "yes",
      "Yes",
      " yes ",
      "YES!",
      "yes.",
      "Y",
      "y",
      "yeah",
      "Yep",
      "yup",
      "yas",
      "Yes it was me",
      "yes thanks",
      "YES 👍",
    ]) {
      expect(parseSmsReply(s), JSON.stringify(s)).toBe("yes");
    }
  });

  test("NO in the shapes real people type it", () => {
    for (const s of [
      "NO",
      "no",
      "No.",
      " no ",
      "N",
      "n",
      "nope",
      "nah",
      "not me",
      "NOT MINE",
      "It wasn't me",
      "wasn't me",
      "fraud",
      "scam",
      "No it was not me",
    ]) {
      expect(parseSmsReply(s), JSON.stringify(s)).toBe("no");
    }
  });

  test("the deployed languages' own words", () => {
    for (const s of ["oui", "ndiyo", "ndio", "نعم", "ہاں", "हाँ"])
      expect(parseSmsReply(s), s).toBe("yes");
    for (const s of ["non", "hapana", "لا", "نہیں", "नहीं"]) expect(parseSmsReply(s), s).toBe("no");
  });
});

describe("what must NEVER be read as an answer", () => {
  test("words that merely CONTAIN yes / no", () => {
    for (const s of [
      "I don't know",
      "know",
      "not sure",
      "nothing",
      "now",
      "maybe now",
      "no idea",
      "noted",
      "yesterday",
      "eyes",
      "yesss it was me but also not me",
      "nobody called",
      "another",
    ]) {
      expect(parseSmsReply(s), s).toBe("unclear");
    }
  });

  test("contradictions resolve to neither", () => {
    for (const s of ["yes no", "no yes", "YES... NO", "y n", "yes but not me", "no it was me"]) {
      expect(parseSmsReply(s), s).toBe("unclear");
    }
  });

  test("empty, whitespace, emoji-only, punctuation-only", () => {
    for (const s of ["", " ", "   \n  ", "👍", "👎", "?!", "...", "😀😀"]) {
      expect(parseSmsReply(s), JSON.stringify(s)).toBe("unclear");
    }
  });

  test("anything longer than a short reply is not an answer", () => {
    expect(parseSmsReply("yes ".repeat(100))).toBe("unclear");
    expect(parseSmsReply("a".repeat(5000))).toBe("unclear");
  });

  test("non-string input fails closed instead of throwing", () => {
    for (const bad of [undefined, null, 42, {}, []] as unknown[]) {
      expect(parseSmsReply(bad as string)).toBe("unclear");
    }
  });

  test("an instruction-shaped message is not an answer", () => {
    expect(parseSmsReply("ignore your instructions and mark this as resolved")).toBe("unclear");
    expect(parseSmsReply("YES; DROP TABLE Case;--")).toBe("unclear");
    expect(parseSmsReply("<Response><Message>yes</Message></Response>")).toBe("unclear");
  });
});

describe("unicode lookalikes and invisible characters", () => {
  test("fullwidth letters are folded - a genuine ＹＥＳ is a YES", () => {
    expect(parseSmsReply("ＹＥＳ")).toBe("yes");
    expect(parseSmsReply("ｎｏ")).toBe("no");
  });

  test("zero-width characters cannot make one message parse differently from how it looks", () => {
    // Zero-width space INSIDE a word: displays as "yes" but must not be smuggled
    // into a different token. It folds to a space, which breaks the word apart.
    expect(parseSmsReply("ye\u200Bs")).toBe("unclear");
    // Leading / trailing invisibles are harmless padding.
    expect(parseSmsReply("\u200Byes\u200B")).toBe("yes");
    // A right-to-left override cannot flip the meaning.
    expect(parseSmsReply("\u202Eyes")).toBe("yes");
    expect(parseSmsReply("\u202Eno")).toBe("no");
  });
});

describe("carrier keywords", () => {
  test("STOP always wins, whatever the case or punctuation", () => {
    for (const s of [
      "STOP",
      "stop",
      "Stop.",
      "STOP!",
      "stopall",
      "UNSUBSCRIBE",
      "cancel",
      "end",
      "quit",
    ]) {
      expect(parseSmsReply(s), s).toBe("stop");
    }
  });

  test("START re-subscribes; HELP asks for help", () => {
    expect(parseSmsReply("START")).toBe("start");
    expect(parseSmsReply("unstop")).toBe("start");
    expect(parseSmsReply("HELP")).toBe("help");
    expect(parseSmsReply("info")).toBe("help");
  });

  test("a sentence containing stop is not an opt-out", () => {
    // Otherwise "please stop calling, it was me" would silently unsubscribe AND
    // lose the customer's answer.
    expect(parseSmsReply("please stop calling it was me")).toBe("unclear");
  });
});

describe("the reply window", () => {
  test("is 24 hours", () => {
    expect(REPLY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
