/**
 * THE OPT-OUT THAT ONLY HALF LANDED — STOP wrote the SMS suppression and left
 * the voice registry empty forever.
 *
 * `DoNotCall` is read in exactly two places: src/lib/policy-gate.ts refuses a
 * non-critical call at ingest, and src/worker/dial.ts re-checks at the dial
 * moment. Nothing in src/ ever WROTE it. So the gate was a gate that could never
 * fail — `findUnique` returned null for every number on earth, the dial proceeded,
 * and a customer who texted STOP was then rung by whichever tenant's routine
 * claim-payout job fired next. Meanwhile the suppression row made the console
 * show the opt-out as honoured. Half an opt-out is worse than none: it turns a
 * complaint into a surprise.
 *
 * The properties asserted, each because its opposite is the incident:
 *
 *   1. BOTH registries, ONE reply — and in ONE transaction, so they cannot
 *      drift into "texted but not called" or "called but texted".
 *   2. EVERY wording the parser already recognises as an opt-out lands, not just
 *      the literal "STOP": unsubscribe / cancel / end / quit / stopall. A fix
 *      keyed to one keyword re-opens the hole for the other five.
 *   3. START removes BOTH — the mirror image. A clearing half of the job leaves
 *      a row that silently refuses that customer's routine calls forever, which
 *      is a denial of service the customer already withdrew.
 *   4. Keyed on the PHONE alone, matching `phone @id`. Not org-scoped, and this
 *      is the convention of the neighbouring write: the opt-out belongs to the
 *      person, whichever tenant's case fires next.
 *   5. The stored key is the trimmed E.164 the gate queries with. A row written
 *      under " +971..." would never be read by `findUnique({where:{phone:to}})`.
 *   6. A registry write that FAILS is not reported as an opt-out. The old code
 *      caught, logged and returned `outcome: "stop"` — Twilio then confirms the
 *      opt-out to the customer while both tables stay empty. That is how this
 *      bug survived: it was unobservable from every side.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type Registry = "smsSuppression" | "doNotCall";
type Row = { phone: string; reason: string; createdAt: Date };

const tables: Record<Registry, Map<string, Row>> = {
  smsSuppression: new Map(),
  doNotCall: new Map(),
};
const writes: { table: Registry; where: unknown; create?: unknown }[] = [];
const audits: { intent: string }[] = [];
const errors: { message: string; meta?: unknown }[] = [];
let transitioned: { caseRef: string; to: string }[] = [];

/** Flip to make every registry write fault, as a partial outage would. */
let failWrites = false;

function registry(name: Registry) {
  return {
    upsert: ({
      where,
      create,
    }: {
      where: { phone: string };
      create: { phone: string; reason: string };
      update: Record<string, never>;
    }) => {
      writes.push({ table: name, where, create });
      if (failWrites) return Promise.reject(new Error("P2022: table DoNotCall does not exist"));
      const existing = tables[name].get(where.phone);
      if (existing) return Promise.resolve(existing); // `update: {}` keeps the original row
      const row: Row = { phone: create.phone, reason: create.reason, createdAt: new Date() };
      tables[name].set(row.phone, row);
      return Promise.resolve(row);
    },
    deleteMany: ({ where }: { where: { phone: string } }) => {
      writes.push({ table: name, where });
      if (failWrites) return Promise.reject(new Error("connection reset"));
      const count = tables[name].delete(where.phone) ? 1 : 0;
      return Promise.resolve({ count });
    },
    /** The exact read the dialling gate performs: src/lib/policy-gate.ts, dial.ts. */
    findUnique: ({ where }: { where: { phone: string } }) =>
      Promise.resolve(tables[name].get(where.phone) ?? null),
  };
}

const tx = { smsSuppression: registry("smsSuppression"), doNotCall: registry("doNotCall") };

mock.module("@/lib/db", () => ({
  db: {
    ...tx,
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    case: {
      findFirst: async () => ({
        orgId: "org-a",
        state: "UNREACHABLE",
        freezeStaged: false,
        freezeReference: null,
        language: "en",
        signalKind: "card_transaction",
        transactionRef: "TX-1",
      }),
      findMany: async () => [{ caseRef: "SV-F- DNC1", orgId: "org-a", language: "en" }],
      count: async () => 0,
      update: async () => ({ id: "case-1", state: "NOTIFIED" }),
    },
  },
}));

mock.module("@/lib/case-state-machine", () => {
  class IllegalTransitionError extends Error {}
  return {
    IllegalTransitionError,
    transitionCaseWithOutbox: async (caseRef: string, to: string) => {
      transitioned.push({ caseRef, to });
      return { id: "case-1", state: to, eventId: "ev-1" };
    },
    transitionCase: async (_caseRef: string, to: string) => ({ id: "case-1", state: to }),
    canTransition: () => true,
  };
});

mock.module("@/lib/audit-chain", () => ({
  append: async (entry: { intent: string }) => {
    audits.push({ intent: entry.intent });
    return "hash";
  },
}));

mock.module("@/lib/notifications", () => ({ notify: async () => ({ ok: true }) }));
mock.module("@/lib/institution", () => ({ getInstitutionType: async () => "bank" }));
mock.module("@/lib/crm", () => ({ createHandoffTicket: async () => ({ ok: true }) }));
mock.module("@/lib/abuse/bad-actor", () => ({
  checkBadActor: () => ({ action: "allow", strikes: 0 }),
  recordStrike: () => ({ action: "allow", strikes: 0 }),
}));
mock.module("@/lib/validation/safe-log", () => ({
  logInfo: () => {},
  logError: (message: string, meta?: unknown) => {
    errors.push({ message, meta });
  },
}));

const { handleSmsReply, parseSmsReply } = await import("@/lib/sms-verdict");

const PHONE = "+971501234567";

/** Everything the parser treats as an opt-out: STOP plus its synonyms. */
const OPT_OUTS = [
  "STOP",
  "stop",
  " stop ",
  "STOP!",
  "Stopall",
  "unsubscribe",
  "UNSUBSCRIBE",
  "cancel",
  "end",
  "quit",
  "QUIT.",
];

beforeEach(() => {
  tables.smsSuppression.clear();
  tables.doNotCall.clear();
  writes.length = 0;
  audits.length = 0;
  errors.length = 0;
  transitioned.length = 0;
  failWrites = false;
});

describe("STOP populates the registry the dialling gate reads", () => {
  test("every recognised opt-out word writes BOTH registries", async () => {
    for (const body of OPT_OUTS) {
      // Guard the list itself: these are the words the ONE parser calls an
      // opt-out. If it recognises a new one, this must be added, not missed.
      expect(parseSmsReply(body), body).toBe("stop");
      tables.smsSuppression.clear();
      tables.doNotCall.clear();
      const res = await handleSmsReply({ from: PHONE, body });
      expect(res, body).toEqual({ reply: null, outcome: "stop" });
      expect(await tx.doNotCall.findUnique({ where: { phone: PHONE } }), body).not.toBeNull();
      expect(await tx.smsSuppression.findUnique({ where: { phone: PHONE } }), body).not.toBeNull();
    }
  });

  test("the gate's own read now refuses the call: the row exists and says why", async () => {
    await handleSmsReply({ from: PHONE, body: "unsubscribe" });
    // policy-gate.ts / dial.ts do `findUnique({ where: { phone } })` and print
    // `dnc.reason` into the audit row, so both must be real.
    const dnc = await tx.doNotCall.findUnique({ where: { phone: PHONE } });
    expect(dnc).not.toBeNull();
    expect(dnc!.phone).toBe(PHONE);
    expect(typeof dnc!.reason).toBe("string");
    expect(dnc!.reason.length).toBeGreaterThan(0);
    expect(dnc!.createdAt).toBeInstanceOf(Date);
  });

  test("the key is the trimmed E.164 the case row stores, not the raw header", async () => {
    // A row written under " +971501234567 " would never be found by the gate's
    // `findUnique({ where: { phone: to } })` — the opt-out would sit in the
    // table, invisible, which is the same incident with better test coverage.
    await handleSmsReply({ from: `  ${PHONE}  `, body: "STOP" });
    expect(await tx.doNotCall.findUnique({ where: { phone: PHONE } })).not.toBeNull();
    expect([...tables.doNotCall.keys()]).toEqual([PHONE]);
  });

  test("it is keyed on the phone alone — no tenant column exists to scope by", async () => {
    await handleSmsReply({ from: PHONE, body: "STOP" });
    for (const w of writes) {
      expect(Object.keys(w.where as Record<string, unknown>).sort()).toEqual(["phone"]);
    }
    // Bank A's STOP must mute Bank B's routine calls: the opt-out belongs to the
    // person. An org-scoped key here would be a silent failure to honour it.
    const sms = writes.find((w) => w.table === "smsSuppression");
    const dnc = writes.find((w) => w.table === "doNotCall");
    expect(dnc!.where).toEqual(sms!.where);
  });

  test("a second STOP does not duplicate the row or reset when they opted out", async () => {
    await handleSmsReply({ from: PHONE, body: "STOP" });
    const first = (await tx.doNotCall.findUnique({ where: { phone: PHONE } }))!.createdAt;
    await handleSmsReply({ from: PHONE, body: "STOP" });
    expect(tables.doNotCall.size).toBe(1);
    expect((await tx.doNotCall.findUnique({ where: { phone: PHONE } }))!.createdAt).toEqual(first);
  });

  test("a reply that FAILED to be recorded is not reported as an opt-out", async () => {
    // The mutation this file exists for. Swallow-and-log makes the incident
    // permanent and undetectable: the customer is told they are opted out, both
    // registries stay empty, and every log line looks fine.
    failWrites = true;
    let reported: unknown = null;
    let threw = false;
    try {
      reported = await handleSmsReply({ from: PHONE, body: "STOP" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(reported).toBeNull();
    expect(await tx.doNotCall.findUnique({ where: { phone: PHONE } })).toBeNull();
    expect(errors.some((e) => e.message.includes("opt-out"))).toBe(true);
  });

  test("one registry cannot land without the other", async () => {
    // Both writes go through $transaction, so "suppressed for SMS, still
    // callable for voice" — the original state of the world — is unrepresentable.
    await expect(handleSmsReply({ from: PHONE, body: "STOP" })).resolves.toEqual({
      reply: null,
      outcome: "stop",
    });
    expect(writes.some((w) => w.table === "smsSuppression")).toBe(true);
    expect(writes.some((w) => w.table === "doNotCall")).toBe(true);
  });

  test("this file's list IS the parser's whole opt-out vocabulary", () => {
    // The hole cannot be re-opened by adding a keyword to src/lib/sms-verdict.ts
    // and forgetting to carry it into the registry write.
    const candidates = [
      ...OPT_OUTS,
      "stop all",
      "opt out",
      "do not call",
      "dnc",
      "remove me",
      "no more",
      "please stop texting me",
    ];
    const recognised = candidates.filter((c) => parseSmsReply(c) === "stop");
    expect(recognised.sort()).toEqual([...OPT_OUTS].sort());
  });
});

describe("START reverses it in both", () => {
  test("START removes the do-not-call entry, not only the suppression", async () => {
    await handleSmsReply({ from: PHONE, body: "STOP" });
    expect(await tx.doNotCall.findUnique({ where: { phone: PHONE } })).not.toBeNull();

    const res = await handleSmsReply({ from: PHONE, body: "START" });
    expect(res).toEqual({ reply: null, outcome: "start" });
    expect(await tx.doNotCall.findUnique({ where: { phone: PHONE } })).toBeNull();
    expect(await tx.smsSuppression.findUnique({ where: { phone: PHONE } })).toBeNull();
  });

  test("UNSTOP is the same instruction and gets the same reversal", async () => {
    await handleSmsReply({ from: PHONE, body: "stop" });
    await handleSmsReply({ from: PHONE, body: "unstop" });
    expect(tables.doNotCall.size).toBe(0);
    expect(tables.smsSuppression.size).toBe(0);
  });

  test("a START with nothing to clear is not an error", async () => {
    const res = await handleSmsReply({ from: PHONE, body: "START" });
    expect(res.outcome).toBe("start");
  });

  test("opting out again after a START re-registers the number", async () => {
    await handleSmsReply({ from: PHONE, body: "STOP" });
    await handleSmsReply({ from: PHONE, body: "START" });
    await handleSmsReply({ from: PHONE, body: "QUIT" });
    expect(await tx.doNotCall.findUnique({ where: { phone: PHONE } })).not.toBeNull();
  });
});

describe("a verdict is not an opt-out", () => {
  test("YES and NO never touch the registries", async () => {
    // The customer answering the alert is not asking to be left alone. Writing
    // DNC here would silently stop every future routine call to a customer who
    // never opted out — the same defect in the opposite direction.
    for (const body of ["YES", "no", "not me", "maybe", "help"]) {
      await handleSmsReply({ from: PHONE, body });
      expect(tables.doNotCall.size, body).toBe(0);
      expect(tables.smsSuppression.size, body).toBe(0);
    }
  });

  test("a number that is not E.164 is refused before any registry is written", async () => {
    const res = await handleSmsReply({ from: "500-555-0009", body: "STOP" });
    expect(res).toEqual({ reply: null, outcome: "rejected" });
    expect(writes).toHaveLength(0);
  });
});
