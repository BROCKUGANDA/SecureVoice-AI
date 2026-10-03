/**
 * UNIT — the canonical case state machine (src/lib/case-state-machine.ts).
 *
 * `canTransition` is pure and is the gate every writer goes through, so it can
 * be exercised as a table without a database. The invariants below are the ones
 * that would let a case reach a nonsensical state if the table rotted:
 *
 *   · Every terminal state has NO outgoing edges. REJECTED, FAILED, EXHAUSTED and
 *     CLOSED are dead ends by definition; an edge out of one means a case can be
 *     resurrected after it was finished.
 *   · CLOSED is reachable from every state a case can legitimately finish in,
 *     and is reachable only from those — a case that can end nowhere is a case
 *     that leaks forever.
 *   · A case always starts at RECEIVED, and nothing transitions INTO RECEIVED —
 *     a case cannot be rewound to birth.
 *   · No state is both reachable and unreachable: every declared state except
 *     RECEIVED is the target of at least one legal edge, so the vocabulary
 *     carries no dead entries.
 *   · Unknown states fail closed. An unrecognised `from` has no edges, so a
 *     typo can never open a transition.
 *   · Verification outcomes are siblings: CONFIRMED_LEGITIMATE,
 *     CONFIRMED_FRAUD and UNCERTAIN are reachable from the same states, because
 *     the caller's answer decides which one, not the system's mood.
 */
import { describe, expect, test } from "bun:test";
import {
  CASE_STATES,
  IllegalTransitionError,
  canTransition,
  type CaseState,
} from "@/lib/case-state-machine";

/** Reconstructed from the module's documented table for readability. */
const TERMINAL: CaseState[] = ["REJECTED", "FAILED", "EXHAUSTED", "CLOSED"];

describe("case state vocabulary", () => {
  test("declares the expected states", () => {
    const unique = [...CASE_STATES].filter((s, i, all) => all.indexOf(s) === i);
    expect(unique.length).toBe(CASE_STATES.length);
    expect(CASE_STATES).toContain("RECEIVED");
    expect(CASE_STATES).toContain("CLOSED");
  });

  test("RECEIVED is a declared state and the only entry point", () => {
    expect(CASE_STATES[0]).toBe("RECEIVED");
  });
});

describe("canTransition — happy paths", () => {
  test("the main happy path from signal to close is legal end to end", () => {
    const path: CaseState[] = [
      "RECEIVED",
      "SCREENED",
      "DIALING",
      "RINGING",
      "ANSWERED",
      "DISCLOSED",
      "VERIFYING",
      "CONFIRMED_FRAUD",
      "FREEZE_STAGED",
      "ESCALATED",
      "NOTIFIED",
      "CLOSED",
    ];
    for (let i = 1; i < path.length; i += 1) {
      expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  test("a legitimate call is confirmed and closed", () => {
    expect(canTransition("VERIFYING", "CONFIRMED_LEGITIMATE")).toBe(true);
    expect(canTransition("CONFIRMED_LEGITIMATE", "NOTIFIED")).toBe(true);
    expect(canTransition("CONFIRMED_LEGITIMATE", "CLOSED")).toBe(true);
  });

  test("an uncertain outcome escalates rather than deciding", () => {
    expect(canTransition("VERIFYING", "UNCERTAIN")).toBe(true);
    expect(canTransition("UNCERTAIN", "ESCALATED")).toBe(true);
  });
});

describe("canTransition — retry and dial outcomes", () => {
  for (const outcome of ["NO_ANSWER", "BUSY", "VOICEMAIL"] as CaseState[]) {
    test(`${outcome} schedules a retry or exhausts`, () => {
      expect(canTransition("DIALING", outcome)).toBe(true);
      expect(canTransition(outcome, "RETRY_SCHEDULED")).toBe(true);
      expect(canTransition(outcome, "EXHAUSTED")).toBe(true);
    });
  }

  test("a scheduled retry re-enters dialling", () => {
    expect(canTransition("RETRY_SCHEDULED", "DIALING")).toBe(true);
  });

  test("retries are bounded — EXHAUSTED is a dead end", () => {
    expect(canTransition("RETRY_SCHEDULED", "EXHAUSTED")).toBe(true);
    for (const to of CASE_STATES) {
      expect(canTransition("EXHAUSTED", to)).toBe(false);
    }
  });
});

describe("canTransition — terminal states", () => {
  for (const terminal of TERMINAL) {
    test(`${terminal} has no outgoing transitions`, () => {
      for (const to of CASE_STATES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    });
  }

  test("a closed case cannot be reopened", () => {
    for (const to of ["RECEIVED", "DIALING", "VERIFYING", "ESCALATED", "NOTIFIED"] as CaseState[]) {
      expect(canTransition("CLOSED", to)).toBe(false);
    }
  });
});

describe("canTransition — fail closed on unknowns", () => {
  test("an unknown source state has no outgoing transitions", () => {
    for (const to of CASE_STATES) {
      expect(canTransition("NOT_A_STATE", to)).toBe(false);
    }
  });

  test("an unknown target state is never reachable", () => {
    for (const from of CASE_STATES) {
      expect(canTransition(from, "NOT_A_STATE")).toBe(false);
    }
  });

  test("an empty string is not a state", () => {
    expect(canTransition("", "RECEIVED")).toBe(false);
    expect(canTransition("RECEIVED", "")).toBe(false);
  });

  test("state names are case-sensitive", () => {
    expect(canTransition("RECEIVED", "screened")).toBe(false);
    expect(canTransition("received", "SCREENED")).toBe(false);
  });

  test("no state transitions into RECEIVED — a case cannot be rewound", () => {
    for (const from of CASE_STATES) {
      if (from === "RECEIVED") continue;
      expect(canTransition(from, "RECEIVED")).toBe(false);
    }
  });
});

describe("canTransition — impossible jumps", () => {
  test("a case cannot skip screening and dial straight away", () => {
    expect(canTransition("RECEIVED", "DIALING")).toBe(false);
  });

  test("a case cannot skip verification and freeze the card", () => {
    // CONFIRMED_FRAUD is what authorises the freeze; DIALING → FREEZE_STAGED
    // would let an unverified call freeze a card.
    expect(canTransition("DIALING", "FREEZE_STAGED")).toBe(false);
    expect(canTransition("ANSWERED", "FREEZE_STAGED")).toBe(false);
  });

  test("a case cannot be answered before it rings", () => {
    expect(canTransition("DIALING", "ANSWERED")).toBe(false);
  });

  test("a case cannot be disclosed before it is answered", () => {
    expect(canTransition("RINGING", "DISCLOSED")).toBe(false);
  });

  test("a rejected case never progresses", () => {
    for (const to of CASE_STATES) {
      expect(canTransition("REJECTED", to)).toBe(false);
    }
  });

  test("a self-transition is not legal for any state", () => {
    for (const s of CASE_STATES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });
});

describe("canTransition — reachability", () => {
  test("every state except RECEIVED is the target of at least one legal edge", () => {
    // A state nothing can enter is dead vocabulary — either remove it or wire
    // it up. This catches both.
    const targets = new Set<string>();
    for (const from of CASE_STATES) {
      for (const to of CASE_STATES) {
        if (canTransition(from, to)) targets.add(to);
      }
    }
    for (const s of CASE_STATES) {
      if (s === "RECEIVED") continue;
      expect({ state: s, reachable: targets.has(s) }).toEqual({ state: s, reachable: true });
    }
  });

  test("every non-terminal state has at least one outgoing transition", () => {
    for (const s of CASE_STATES) {
      const hasOutgoing = CASE_STATES.some((to) => canTransition(s, to));
      if (TERMINAL.includes(s)) {
        expect({ state: s, hasOutgoing }).toEqual({ state: s, hasOutgoing: false });
      } else {
        expect({ state: s, hasOutgoing }).toEqual({ state: s, hasOutgoing: true });
      }
    }
  });

  test("every state can reach a terminal state — no case can be stranded", () => {
    // Derived from the table by search rather than a hand-written list, because
    // the property that matters is that a case always terminates, not which
    // particular state closes it directly. VERIFYING, for instance, has no
    // direct CLOSED edge: it must first resolve to an outcome.
    const terminal = new Set<string>(TERMINAL);
    for (const start of CASE_STATES) {
      const seen = new Set<string>([start]);
      const queue: string[] = [start];
      let reachesTerminal = terminal.has(start);
      while (queue.length > 0 && !reachesTerminal) {
        const cur = queue.shift()!;
        for (const next of CASE_STATES) {
          if (seen.has(next) || !canTransition(cur, next)) continue;
          seen.add(next);
          if (terminal.has(next)) {
            reachesTerminal = true;
            break;
          }
          queue.push(next);
        }
      }
      expect({ state: start, reachesTerminal }).toEqual({ state: start, reachesTerminal: true });
    }
  });
  test("the three verification outcomes are siblings from the same states", () => {
    const outcomes: CaseState[] = ["CONFIRMED_LEGITIMATE", "CONFIRMED_FRAUD", "UNCERTAIN"];
    for (const from of ["DISCLOSED", "VERIFYING"] as CaseState[]) {
      for (const outcome of outcomes) {
        expect(canTransition(from, outcome)).toBe(true);
      }
    }
  });
});

describe("IllegalTransitionError", () => {
  test("carries both states and a readable message", () => {
    const e = new IllegalTransitionError("RECEIVED", "CLOSED");
    expect(e.from).toBe("RECEIVED");
    expect(e.to).toBe("CLOSED");
    expect(e.message).toBe("Illegal case transition: RECEIVED → CLOSED");
    expect(e.name).toBe("IllegalTransitionError");
  });

  test("is a real Error, so it survives a normal catch and instanceof check", () => {
    const e = new IllegalTransitionError("CLOSED", "RECEIVED");
    expect(e).toBeInstanceOf(Error);
    expect(() => {
      throw e;
    }).toThrow(IllegalTransitionError);
  });
});
