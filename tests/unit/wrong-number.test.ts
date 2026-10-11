/**
 * Wrong-number and call-back-later detection.
 *
 * The property under test is not "does the regex fire" — it is that the
 * decision is EXPLAINABLE and that the two ways it can be wrong are not the
 * same mistake. Firing on "who is this?" costs a real cardholder; not firing on
 * "nobody by that name lives here" costs a stranger's privacy. Both are pinned.
 *
 * The second block is the one that matters for a bank: the canonical case state
 * machine has to be able to express the closure, without a freeze and without an
 * escalation, and where it CANNOT, this module says so rather than inventing a
 * state.
 *
 *   bun test tests/unit/wrong-number.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  CASE_STATES,
  canTransition,
} from "@/lib/case-state-machine";
import {
  MIN_ACTIONABLE_CONFIDENCE,
  buildWrongNumberClosure,
  canCloseFrom,
  closurePath,
  detectCallbackRequest,
  detectWrongNumber,
  redactForWrongNumber,
  wrongNumberRuleCount,
  type WrongNumberVerdict,
} from "@/lib/voice/wrong-number";

/* ─────────────────────────────── detection ─────────────────────────────── */

describe("detectWrongNumber — English", () => {
  const MUST_FIRE = [
    "this is not my number",
    "this isn't my number",
    "That's not my number, who is this?",
    "wrong number",
    "you have the wrong number",
    "you've got the wrong number",
    "this is not my phone",
    "that's the wrong person",
    "nobody by that name lives here",
    "no one with that name is here",
    "this number belongs to someone else",
    "someone else's phone",
    "this is not my husband",
    "I don't know you",
  ];

  for (const phrase of MUST_FIRE) {
    test(`fires on "${phrase}"`, () => {
      const v = detectWrongNumber(phrase);
      expect(v.kind).toBe("wrong_number");
      expect(v.confidence).toBeGreaterThanOrEqual(MIN_ACTIONABLE_CONFIDENCE);
      expect(v.matched).toBeTruthy();
    });
  }

  test("returns the phrase that fired, so a human can audit the decision", () => {
    expect(detectWrongNumber("I think this is the wrong number here").matched).toContain(
      "wrong number",
    );
  });

  test("caps the returned phrase — a caller can say anything", () => {
    const v = detectWrongNumber(`wrong number ${"and also ".repeat(40)}blah`);
    expect((v.matched ?? "").length).toBeLessThanOrEqual(60);
  });
});

describe("detectWrongNumber — Arabic", () => {
  const MUST_FIRE = [
    "هذا ليس رقمي",
    "هذا رقم غير صحيح",
    "الرقم غير صحيح",
    "رقم شخص آخر",
    "لا يوجد أحد بهذا الاسم",
    "رقم آخر",
  ];

  for (const phrase of MUST_FIRE) {
    test(`fires on "${phrase}"`, () => {
      const v = detectWrongNumber(phrase);
      expect(v.kind).toBe("wrong_number");
      expect(v.confidence).toBeGreaterThanOrEqual(MIN_ACTIONABLE_CONFIDENCE);
    });
  }

  test("survives the letter forms a transcriber varies", () => {
    // أ إ آ → ا, ة → ه, tashkeel stripped. Without this the same sentence
    // matches or misses depending on who was speaking.
    expect(detectWrongNumber("هذا ليس رقمي").kind).toBe("wrong_number");
    expect(detectWrongNumber("هٰذَا لَّيسَ رَقْمِي").kind).toBe("wrong_number");
  });

  test("can be narrowed to one script with the language option", () => {
    expect(detectWrongNumber("هذا ليس رقمي", { language: "en" }).kind).toBe("not_detected");
    expect(detectWrongNumber("هذا ليس رقمي", { language: "ar" }).kind).toBe("wrong_number");
  });
});

describe("detectWrongNumber — what must NOT fire", () => {
  const MUST_NOT_FIRE = [
    "",
    "yes",
    "no it was not me",
    // THE most important non-match in this file. "that was not mine" is a
    // FRAUD REPORT — the single most valuable thing a customer can say on this
    // call — and classifying it as a wrong number would discard the signal the
    // product exists to act on.
    "that charge is not mine",
    "I didn't make this purchase",
    "what is this about",
    "can you repeat that please",
    "what's wrong with my card",
    "who sent you",
  ];

  for (const phrase of MUST_NOT_FIRE) {
    test(`stays silent on "${phrase}"`, () => {
      const v = detectWrongNumber(phrase);
      expect(v.kind).toBe("not_detected");
      expect(v.matched).toBeNull();
    });
  }
});

describe("detectWrongNumber — identity questions are reported but not actionable", () => {
  // "Who is this?" is what a REAL cardholder asks in the first ten seconds of
  // a fraud call. It is also what a stranger says. Closing on it would hang up
  // on the customer this product exists to serve.
  const QUESTIONS = ["who is this?", "who's this", "who is calling", "where did you get my number"];

  for (const q of QUESTIONS) {
    test(`reports "${q}" below the action threshold`, () => {
      const v = detectWrongNumber(q);
      expect(v.kind).toBe("wrong_number");
      expect(v.confidence).toBeLessThan(MIN_ACTIONABLE_CONFIDENCE);
      expect(buildWrongNumberClosure(v).actionable).toBe(false);
    });
  }

  test("the Arabic equivalents too", () => {
    for (const q of ["من هذا", "من أنت"]) {
      expect(detectWrongNumber(q).confidence).toBeLessThan(MIN_ACTIONABLE_CONFIDENCE);
    }
  });
});

/* ──────────────────────────── call-back requests ──────────────────────────── */

describe("detectCallbackRequest", () => {
  test("catches the explicit requests, English", () => {
    for (const phrase of [
      "call me back",
      "ring me back later",
      "try me later",
      "get back to me",
      "this is not a good time",
      "now is not a good time",
      "I'm driving right now",
      "I'm in a meeting",
      "email me instead",
      "some other time",
    ]) {
      const r = detectCallbackRequest(phrase);
      expect(r.requested, phrase).toBe(true);
      expect(r.matched, phrase).toBeTruthy();
    }
  });

  test("catches the Arabic requests", () => {
    for (const phrase of [
      "اتصل بي لاحقا",
      "راسلني",
      "الوقت غير مناسب",
      "مش وقت مناسب",
      "انا مشغول",
    ]) {
      expect(detectCallbackRequest(phrase).requested, phrase).toBe(true);
    }
  });

  test("reports the requested window", () => {
    expect(detectCallbackRequest("call me back tomorrow").when).toBe("tomorrow");
    expect(detectCallbackRequest("اتصل بي غدا").when).toBe("tomorrow");
    expect(detectCallbackRequest("can you call me back later today").when).toBe("later_today");
    expect(detectCallbackRequest("call me back").when).toBe("unspecified");
  });

  test("stays silent on ordinary speech", () => {
    for (const phrase of ["", "yes", "go ahead", "can you repeat that", "what's your name"]) {
      expect(detectCallbackRequest(phrase).requested, phrase).toBe(false);
      expect(detectCallbackRequest(phrase).matched).toBeNull();
    }
  });

  test("surfaces through the verdict so a caller makes ONE decision", () => {
    const v = detectWrongNumber("I am in a meeting, please call me later today");
    expect(v.kind).toBe("callback_requested");
    expect(v.confidence).toBeGreaterThan(0);
    expect(v.matched).toBeTruthy();
  });

  test("a wrong number outranks a callback in the same breath", () => {
    // "Wrong number, call me back" is still a stranger. Getting this backwards
    // means we politely arrange to call the stranger again.
    expect(detectWrongNumber("this is the wrong number, call me back later").kind).toBe(
      "wrong_number",
    );
  });
});

/* ─────────────────────────────── PDPL redaction ─────────────────────────────── */

describe("redactForWrongNumber", () => {
  const ATTEMPT = {
    merchant: "Emirates NBD Digital Store",
    amountMinor: 249_900,
    cardLast4: "4417",
  };

  test("reveals NOTHING from the attempt — not the merchant, amount or last four", () => {
    const line = redactForWrongNumber(ATTEMPT);
    expect(line).not.toContain("Emirates");
    expect(line).not.toContain("4417");
    expect(line).not.toContain("2499");
  });

  test("contains no digit at all", () => {
    // Stronger and simpler than auditing a list of fields: there is nothing to
    // redacted-transcript later if there are no digits.
    expect(redactForWrongNumber(ATTEMPT)).not.toMatch(/\d/);
    expect(redactForWrongNumber({})).not.toMatch(/\d/);
  });

  test("is INVARIANT to its input — the whole control", () => {
    const a = redactForWrongNumber(ATTEMPT);
    const b = redactForWrongNumber({});
    const c = redactForWrongNumber({ merchant: "Amazon", amountMinor: 1, cardLast4: "0001" });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("validates rather than echoing a malformed attempt", () => {
    expect(() => redactForWrongNumber({ amountMinor: 249_900.5 })).toThrow();
    expect(() => redactForWrongNumber({ cardLast4: "4111111111111111" })).toThrow();
  });

  test("has an Arabic variant with the same neutrality", () => {
    const ar = redactForWrongNumber(ATTEMPT, { language: "ar" });
    expect(ar.length).toBeGreaterThan(0);
    expect(ar).not.toMatch(/\d/);
    expect(ar).not.toContain("Emirates");
  });
});

/* ──────────────────────────────── the closure ──────────────────────────────── */

const WRONG_NUMBER: WrongNumberVerdict = {
  kind: "wrong_number",
  confidence: 0.95,
  matched: "this is not my number",
};

describe("buildWrongNumberClosure", () => {
  test("speaks a line with no transaction specifics", () => {
    const c = buildWrongNumberClosure(WRONG_NUMBER);
    expect(c.speech.length).toBeGreaterThan(0);
    expect(c.speech).not.toMatch(/\d/);
    expect(c.speech.toLowerCase()).not.toContain("merchant");
  });

  test("NEVER permits a freeze or an escalation — ever", () => {
    // A stranger must not be able to place a hold on someone else's card by
    // answering the phone and saying four words.
    for (const v of [
      WRONG_NUMBER,
      { kind: "callback_requested", confidence: 0.95, matched: "call me back" },
      { kind: "wrong_number", confidence: MIN_ACTIONABLE_CONFIDENCE, matched: "who is this" },
      { kind: "not_detected", confidence: 0, matched: null },
    ] as WrongNumberVerdict[]) {
      const c = buildWrongNumberClosure(v, { currentState: "VERIFYING" });
      expect(c.mustNotFreeze).toBe(true);
      expect(c.mustNotEscalate).toBe(true);
      // And the path it publishes never touches a freeze or an escalation.
      expect(c.record.path).not.toContain("FREEZE_STAGED");
      expect(c.record.path).not.toContain("ESCALATED");
      expect(c.record.redialPath ?? []).not.toContain("RETRY_SCHEDULED");
    }
  });

  test("does not hang up on a low-confidence match", () => {
    const c = buildWrongNumberClosure({ kind: "wrong_number", confidence: 0.55, matched: "who is this" });
    expect(c.actionable).toBe(false);
    expect(c.outcome).toBe("not_detected");
    expect(c.speech).toBe("");
    expect(c.record.intent).toBe("wrong_number_not_conclusive");
  });

  test("records the callback window when one was given", () => {
    const v = detectWrongNumber("please call me back tomorrow");
    const c = buildWrongNumberClosure(v, {
      currentState: "VERIFYING",
      callback: detectCallbackRequest("please call me back tomorrow"),
    });
    expect(c.outcome).toBe("callback_requested");
    expect(c.record.callbackWhen).toBe("tomorrow");
    expect(c.speech.toLowerCase()).toContain("call");
  });

  test("publishes NO path when no current state was supplied", () => {
    // Guessing VERIFYING here would put a confident-looking transition plan in
    // the audit record that may not be legal from where the case actually is.
    const c = buildWrongNumberClosure(WRONG_NUMBER);
    expect(c.record.suggestedState).toBeNull();
    expect(c.record.path).toEqual([]);
  });

  test("has an Arabic closure line", () => {
    const c = buildWrongNumberClosure(WRONG_NUMBER, { language: "ar", currentState: "VERIFYING" });
    expect(c.language).toBe("ar");
    expect(c.speech).not.toMatch(/\d/);
    expect(c.speech.length).toBeGreaterThan(0);
  });
});

/* ─────────────────────── the canonical case state machine ─────────────────────── */

describe("closurePath — a QUERY against the canonical machine, not a second one", () => {
  test("every published edge is legal per canTransition", () => {
    // If this fails, the module has started inventing transitions — the exact
    // failure the one-writer rule in case-state-machine.ts exists to prevent.
    const paths = [
      closurePath("VERIFYING", "CLOSED"),
      closurePath("VERIFYING", "NOTIFIED"),
      closurePath("DISCLOSED", "CLOSED"),
      closurePath("DIALING", "RETRY_SCHEDULED"),
    ];
    for (const path of paths) {
      expect(path).not.toBeNull();
      for (let i = 1; i < path!.length; i++) {
        expect(canTransition(path![i - 1]!, path![i]!)).toBe(true);
      }
    }
  });

  test("a wrong number closes from every state a live call can be in", () => {
    for (const state of ["DISCLOSED", "VERIFYING", "UNCERTAIN", "CONFIRMED_FRAUD"]) {
      expect(canCloseFrom(state, "wrong_number"), state).toBe(true);
    }
  });

  test("the wrong-number path from VERIFYING goes via UNCERTAIN — VERIFYING cannot close directly", () => {
    // Stated as a test because it is the non-obvious half of the answer: the
    // machine CAN express this, but not in one hop.
    expect(canTransition("VERIFYING", "CLOSED")).toBe(false);
    expect(closurePath("VERIFYING", "CLOSED")).toEqual(["VERIFYING", "UNCERTAIN", "CLOSED"]);
  });

  test("a callback can be RECORDED from VERIFYING", () => {
    expect(closurePath("VERIFYING", "NOTIFIED")).toEqual(["VERIFYING", "UNCERTAIN", "NOTIFIED"]);
  });

  test("a callback CANNOT be re-dialled from VERIFYING — reported, not papered over", () => {
    // The honest gap. RETRY_SCHEDULED is reachable only from the unreachable
    // family, so a caller who asks to be called back mid-verification cannot be
    // re-dialed. The fix is an EDGE in another file, not a new state here.
    expect(canTransition("VERIFYING", "RETRY_SCHEDULED")).toBe(false);
    expect(closurePath("VERIFYING", "RETRY_SCHEDULED")).toBeNull();

    const c = buildWrongNumberClosure(
      { kind: "callback_requested", confidence: 0.95, matched: "call me back" },
      { currentState: "VERIFYING" },
    );
    expect(c.record.redialRequired).toBe(true);
    expect(c.record.redialPath).toBeNull();
    expect(c.record.suggestedState).toBe("NOTIFIED");
  });

  test("a callback IS re-dialable once the case is in the unreachable family", () => {
    expect(closurePath("BUSY", "RETRY_SCHEDULED")).toEqual(["BUSY", "RETRY_SCHEDULED"]);
    expect(closurePath("NO_ANSWER", "RETRY_SCHEDULED")).toEqual([
      "NO_ANSWER",
      "RETRY_SCHEDULED",
    ]);
  });

  test("an unknown state has no path — the machine fails closed", () => {
    expect(closurePath("NOT_A_STATE", "CLOSED")).toBeNull();
    expect(canCloseFrom("NOT_A_STATE", "wrong_number")).toBe(false);
  });

  test("being already at the target is a zero-length path", () => {
    expect(closurePath("CLOSED", "CLOSED")).toEqual([]);
  });

  test("no state is left stranded by this module", () => {
    // Every state a case can legitimately be in when a stranger picks up must
    // reach a terminal closure. A state that cannot is a case that leaks.
    const live = [
      "RECEIVED",
      "SCREENED",
      "DIALING",
      "RINGING",
      "ANSWERED",
      "DISCLOSED",
      "VERIFYING",
      "CONFIRMED_LEGITIMATE",
      "CONFIRMED_FRAUD",
      "UNCERTAIN",
      "FREEZE_STAGED",
      "ESCALATED",
      "NOTIFIED",
      "NO_ANSWER",
      "BUSY",
      "VOICEMAIL",
      "UNREACHABLE",
      "RETRY_SCHEDULED",
    ];
    for (const state of live) {
      expect(closurePath(state, "CLOSED"), state).not.toBeNull();
    }
  });

  test("the module declares states that exist", () => {
    // It never names a state the machine does not have.
    expect(CASE_STATES).toContain("CLOSED");
    expect(CASE_STATES).toContain("NOTIFIED");
    expect(CASE_STATES).not.toContain("WRONG_NUMBER");
  });
});

describe("wrongNumberRuleCount", () => {
  test("reports both rule tables, so a reviewer can see the coverage", () => {
    const counts = wrongNumberRuleCount();
    expect(counts.wrongNumber).toBeGreaterThan(15);
    expect(counts.callback).toBeGreaterThan(10);
  });
});
