/**
 * THE REPLY THAT COULD ONLY BE FILED AWAY — an SMS answer had one way out of
 * UNREACHABLE, and it was "this is over".
 *
 * UNREACHABLE is where a case sits after the voice call failed and the
 * blind-ping SMS went out. Its outgoing edges used to be exactly one: NOTIFIED.
 * That is right for YES, NO and for 24h of silence, and wrong for everything
 * else, because there was nothing else it could legally do. A customer who
 * answers the text has proved the number is live and proved they are reading it;
 * if their answer is not something SMS can settle — they asked for a human, or
 * two tenants are waiting on one handset so the reply cannot be placed — the
 * honest outcome is to try the voice channel again. The table forbade it, so the
 * only available move was to let the window lapse and publish
 * `unreachable_no_reply`: the bank's fraud team is told NOBODY ANSWERED about a
 * customer who did answer, and they triage the alert accordingly. A false
 * statement to a bank is the failure mode this whole subsystem exists to avoid.
 *
 * The edge added is UNREACHABLE -> RETRY_SCHEDULED, and these tests hold the
 * shape of it:
 *
 *   1. The case can get BACK to the voice flow — and only the way the dial
 *      worker enters it. RETRY_SCHEDULED is where the attempt ladder, the
 *      after-hours deferral and the `dial_job` (case_id, attempt_no) uniqueness
 *      already live.
 *   2. The tempting shortcut stays illegal. UNREACHABLE -> DIALING would let a
 *      webhook mark a call as placed with no job and no carrier behind it — the
 *      same falsehood tests/unit/dial-media-streams-truth.test.ts was written
 *      against a real occurrence of.
 *   3. Nothing is stranded or resurrected by the new edge: the case still
 *      reaches NOTIFIED and CLOSED, no terminal state gained a way out, and the
 *      single writer still refuses the jumps it always refused.
 *   4. The SMS fallback's own invariant survives — RETRY_SCHEDULED has no edge
 *      INTO UNREACHABLE, so a case awaiting a voice retry is never re-texted.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const written: { caseRef: string; data: Record<string, unknown> }[] = [];
const transitionAudits: { intent: string; meta?: Record<string, unknown> }[] = [];
const realtime: Record<string, unknown>[] = [];

let rowState = "UNREACHABLE";

mock.module("@/lib/db", () => ({
  db: {
    case: {
      findUnique: async () => ({
        id: "case-1",
        caseRef: "SV-F-DNC1",
        state: rowState,
        orgId: "org-a",
      }),
      update: async ({
        where,
        data,
      }: {
        where: { caseRef: string };
        data: Record<string, unknown>;
      }) => {
        written.push({ caseRef: where.caseRef, data });
        return { id: "case-1", state: data.state };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  },
}));

mock.module("@/lib/outbox", () => ({
  enqueueOutbox: async () => ({ id: "ev-1" }),
}));

mock.module("@/lib/notifications", () => ({ notify: async () => ({ ok: true }) }));
mock.module("@/lib/realtime", () => ({
  notifyRealtime: async (args: Record<string, unknown>) => {
    realtime.push(args);
  },
}));

mock.module("@/lib/audit-chain", () => ({
  append: async (entry: { intent: string; meta?: Record<string, unknown> }) => {
    transitionAudits.push({ intent: entry.intent, meta: entry.meta });
    return "hash";
  },
}));

const { canTransition, CASE_STATES, TERMINAL_CASE_STATES, transitionCase, IllegalTransitionError } =
  await import("@/lib/case-state-machine");

/** States the dialling flow passes through before a human is reached. */
const VOICE_FLOW = ["DIALING", "RINGING", "ANSWERED", "DISCLOSED", "VERIFYING"];

beforeEach(() => {
  rowState = "UNREACHABLE";
  written.length = 0;
  transitionAudits.length = 0;
  realtime.length = 0;
});

describe("a customer who answered the text can be reached by voice again", () => {
  test("UNREACHABLE -> RETRY_SCHEDULED -> DIALING is legal, so the reply is not a dead end", () => {
    expect(canTransition("UNREACHABLE", "RETRY_SCHEDULED")).toBe(true);
    // The edge is only worth having if it actually returns the case to the voice
    // flow: the dial worker claims a scheduled retry and enters DIALING from it.
    expect(canTransition("RETRY_SCHEDULED", "DIALING")).toBe(true);
  });

  test("the writer performs it instead of throwing", async () => {
    // The table is the gate every state change passes through. Proving the
    // predicate alone would not prove the single writer admits the edge.
    await expect(transitionCase("SV-F-DNC1", "RETRY_SCHEDULED")).resolves.toEqual({
      id: "case-1",
      state: "RETRY_SCHEDULED",
    });
    expect(written).toHaveLength(1);
    expect(written[0]!.data.state).toBe("RETRY_SCHEDULED");
    expect(transitionAudits.map((a) => a.intent)).toContain(
      "transition_unreachable_to_retry_scheduled",
    );
  });

  test("a case awaiting that retry is never re-texted", () => {
    // sms-fallback's at-most-once rule rests on this: an edge back into
    // UNREACHABLE from RETRY_SCHEDULED would let a second blind-ping SMS fire for
    // a case that is already scheduled for another call.
    expect(canTransition("RETRY_SCHEDULED", "UNREACHABLE")).toBe(false);
    expect(canTransition("DIALING", "UNREACHABLE")).toBe(true); // the fallback still works
  });

  test("waiting on a reply is not a terminal state", () => {
    expect(TERMINAL_CASE_STATES).not.toContain("UNREACHABLE");
    expect(TERMINAL_CASE_STATES).not.toContain("RETRY_SCHEDULED");
  });
});

describe("the edge did not loosen anything else", () => {
  test("an SMS reply still cannot claim a call was placed", async () => {
    // The shortcut this change deliberately did NOT take. DIALING is entered by
    // the worker that holds a dial job; a reply-driven transition into it would
    // put "we phoned the customer" in the state with nobody dialling.
    for (const to of VOICE_FLOW) {
      expect(canTransition("UNREACHABLE", to), to).toBe(false);
    }
    await expect(transitionCase("SV-F-DNC1", "DIALING")).rejects.toThrow(IllegalTransitionError);
    expect(written).toHaveLength(0);
  });

  test("the reply cannot resolve the alert by picking an outcome itself", () => {
    for (const to of ["CONFIRMED_LEGITIMATE", "CONFIRMED_FRAUD", "UNCERTAIN", "FREEZE_STAGED"]) {
      expect(canTransition("UNREACHABLE", to), to).toBe(false);
    }
  });

  test("telling the bank it is over is still the other way out", () => {
    expect(canTransition("UNREACHABLE", "NOTIFIED")).toBe(true);
    expect(canTransition("NOTIFIED", "CLOSED")).toBe(true);
  });

  test("no terminal state gained a door", () => {
    for (const terminal of TERMINAL_CASE_STATES) {
      for (const to of CASE_STATES) {
        expect(canTransition(terminal, to), `${terminal} -> ${to}`).toBe(false);
      }
    }
  });

  test("every state still ends somewhere, so a recall cannot strand a case", () => {
    const terminal = new Set<string>(TERMINAL_CASE_STATES);
    for (const start of CASE_STATES) {
      const seen = new Set<string>([start]);
      const queue = [start];
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

  test("UNREACHABLE's ways out are the two this file argues about, and only those", () => {
    // A third edge added by someone who has not read this file is exactly the
    // kind of drift the single-writer rule is here to catch.
    const outs = CASE_STATES.filter((to) => canTransition("UNREACHABLE", to));
    expect(outs).toEqual(["NOTIFIED", "RETRY_SCHEDULED"]);
  });
});
