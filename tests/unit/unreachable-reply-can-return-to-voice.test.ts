/**
 * AN SMS REPLY CAN PUT A CASE BACK ON THE PHONE.
 *
 * `UNREACHABLE` used to have exactly one exit: `NOTIFIED`. That is correct for a
 * reply that settles the question, and wrong for every other reply, because it
 * left the state machine with no honest way to say "the customer answered the
 * text and it did not resolve — try the voice channel again". The only writer
 * left was the expiry sweep, which recorded `unreachable_no_reply` on a case
 * where somebody had in fact replied. The bank was told the customer never
 * answered.
 *
 * The edge added is UNREACHABLE -> RETRY_SCHEDULED, not -> DIALING: the dial
 * worker owns the way into DIALING and bypassing it would skip the lease, the
 * attempt ladder and the carrier rate window. The tests below assert both halves
 * — the new edge exists AND the shortcut it deliberately does not open.
 */
import { describe, expect, it } from "bun:test";

import { CASE_STATES, TERMINAL_CASE_STATES, canTransition } from "@/lib/case-state-machine";

describe("UNREACHABLE has a way back to the voice flow", () => {
  it("an unresolved reply can schedule another dial attempt", () => {
    expect(canTransition("UNREACHABLE", "RETRY_SCHEDULED")).toBe(true);
  });

  it("a resolving reply still ends the case the way it always did", () => {
    expect(canTransition("UNREACHABLE", "NOTIFIED")).toBe(true);
  });

  it("but UNREACHABLE never jumps straight to DIALING", () => {
    // The dial worker claims RETRY_SCHEDULED rows and owns the transition into
    // DIALING. Opening this edge would let a caller skip the lease, the attempt
    // ladder and the carrier's two-calls-per-five-minutes window.
    expect(canTransition("UNREACHABLE", "DIALING")).toBe(false);
  });

  it("the return path actually leads somewhere: RETRY_SCHEDULED can still dial", () => {
    expect(canTransition("RETRY_SCHEDULED", "DIALING")).toBe(true);
    expect(canTransition("RETRY_SCHEDULED", "EXHAUSTED")).toBe(true);
  });

  it("UNREACHABLE cannot be laundered into any other state", () => {
    const allowed = CASE_STATES.filter((s) => canTransition("UNREACHABLE", s));
    expect(allowed.sort()).toEqual(["NOTIFIED", "RETRY_SCHEDULED"]);
  });
});

describe("the wider table was not damaged to add one edge", () => {
  it("every transition target is a declared state", () => {
    for (const from of CASE_STATES) {
      for (const to of CASE_STATES) {
        if (canTransition(from, to)) {
          expect(CASE_STATES).toContain(to);
        }
      }
    }
  });

  it("terminal states still have no exits", () => {
    expect(TERMINAL_CASE_STATES.length).toBeGreaterThan(0);
    for (const terminal of TERMINAL_CASE_STATES) {
      for (const to of CASE_STATES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("the state set is closed", () => {
    // Adding a state without wiring its edges is how a case gets stuck.
    expect(new Set(CASE_STATES).size).toBe(CASE_STATES.length);
    for (const state of CASE_STATES) {
      expect(typeof state).toBe("string");
    }
  });
});
