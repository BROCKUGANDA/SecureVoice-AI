/**
 * The voice handoff now reaches the institution's own CRM, and this is the gate
 * that would notice if it stopped.
 *
 * `openCaseHandoffTicket` is the single place a case becomes a ticket from the
 * agent tools, so three things are pinned here rather than at each call site:
 *
 *   · a ticket carries REFERENCES ONLY — no phone, merchant, amount or transcript.
 *     `HandoffTicket` has no such fields, which stops the compiler, but a caller
 *     adding one to the object literal is a runtime problem, and a CRM is a
 *     wide-audience tool with its own retention rules.
 *   · an unscoped case opens nothing. `createHandoffTicket` refuses an empty
 *     orgId because a connection belongs to exactly one institution; silently
 *     attempting it anyway would be a log line nobody acts on.
 *   · nothing thrown from here reaches the caller. The customer is on the line
 *     waiting for a human; a CRM outage must not become a refused handoff.
 *
 * Also pinned: which warm-transfer outcome earns a ticket. Only the DEGRADED one.
 * A live bridge that worked put a human on the call, and a ticket for it would be
 * a second copy of work somebody is already doing.
 */
import { describe, expect, mock, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Ticket = Record<string, unknown> & { orgId: string; reason: string };

const opened: Ticket[] = [];
let crmThrows = false;
let caseRow: Record<string, unknown> | null = {
  orgId: "org-insurer",
  signalKind: "claim_payout",
  language: "en",
  transactionRef: "TXN-77",
};

mock.module("@/lib/db", () => ({
  db: {
    case: {
      findUnique: async () => caseRow,
    },
  },
}));

mock.module("@/lib/institution", () => ({
  getInstitutionType: async () => "insurer",
}));

mock.module("@/lib/crm/index", () => ({
  createHandoffTicket: async (ticket: Ticket) => {
    if (crmThrows) throw new Error("crm unreachable");
    opened.push(ticket);
    return [];
  },
}));

const { openCaseHandoffTicket } = await import("@/lib/crm/case-ticket");

beforeEach(() => {
  opened.length = 0;
  crmThrows = false;
  caseRow = {
    orgId: "org-insurer",
    signalKind: "claim_payout",
    language: "en",
    transactionRef: "TXN-77",
  };
});

describe("openCaseHandoffTicket", () => {
  test("opens one ticket carrying the case's references", async () => {
    const ok = await openCaseHandoffTicket("SV-C-1", "human_review", "urgent");
    expect(ok).toBe(true);
    expect(opened).toHaveLength(1);
    const ticket = opened[0]!;
    expect(ticket).toMatchObject({
      caseRef: "SV-C-1",
      orgId: "org-insurer",
      institutionType: "insurer",
      signalKind: "claim_payout",
      reason: "human_review",
      priority: "urgent",
      language: "en",
      transactionRef: "TXN-77",
      auditRef: "SV-C-1",
    });
  });

  test("the ticket names no customer value", async () => {
    await openCaseHandoffTicket("SV-C-2", "human_review", "urgent");
    const keys = Object.keys(opened[0]!).sort();
    for (const forbidden of ["phone", "merchant", "amount", "transcript", "card"]) {
      expect(
        keys.filter((k) => k.toLowerCase().includes(forbidden)),
        `${forbidden} reached the CRM payload`,
      ).toEqual([]);
    }
  });

  test("a case with no organisation opens nothing", async () => {
    caseRow = { orgId: null, signalKind: null, language: "en", transactionRef: null };
    expect(await openCaseHandoffTicket("SV-C-3", "human_review", "urgent")).toBe(false);
    expect(opened).toEqual([]);
  });

  test("a case that does not exist opens nothing", async () => {
    caseRow = null;
    expect(await openCaseHandoffTicket("SV-C-4", "human_review", "urgent")).toBe(false);
    expect(opened).toEqual([]);
  });

  test("an unreachable CRM is a false, never a throw", async () => {
    crmThrows = true;
    let threw = false;
    let result = true;
    try {
      result = await openCaseHandoffTicket("SV-C-5", "human_review", "urgent");
    } catch {
      threw = true;
    }
    expect(threw, "a CRM outage must not propagate into a live handoff").toBe(false);
    expect(result).toBe(false);
  });
});

/**
 * Which voice paths actually call this, read off the source.
 *
 * A text check rather than a spy: `tests/tools/warm-transfer.test.ts` runs
 * against the real database and `mock.module` would bleed across it, and the
 * thing worth pinning is not "the mock was called" but "the degraded branch is
 * the one that files, and nobody deleted the call when they edited the route".
 */
describe("the handoff tools are wired to the CRM", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

  test("human_handoff files one, always — it never bridges a call", () => {
    const route = read("src/app/api/elevenlabs/tools/human-handoff/route.ts");
    expect(route).toContain('openCaseHandoffTicket(guard.caseRef, "human_review", "urgent")');
  });

  test("warm_transfer files only when the live bridge did NOT happen", () => {
    const route = read("src/app/api/elevenlabs/tools/warm-transfer/route.ts");
    const files = /if \(!transferred\) \{\s*void openCaseHandoffTicket\(/.test(route);
    expect(files).toBe(true);
    // And not unconditionally: a transferred call already has a human on it.
    expect(route.match(/openCaseHandoffTicket\(/g)).toHaveLength(1);
  });
});
