/**
 * UNIT — the reversal window: a clock, a sweep, and escalation instead of reversal.
 *
 * `REVERSAL_WINDOW_SECS` used to be a number copied into a response body and an
 * audit payload, with nothing storing a deadline and nothing firing when it passed.
 * These cases are the properties that make it a control:
 *
 *   1. staging records WHEN, and the writer owns that instant — a caller cannot
 *      pass its own deadline into a hold;
 *   2. a window that closes with no second actor ESCALATES: the hold is marked
 *      lapsed, the case moves through the state machine, and a page reaches the
 *      inbox — once, bounded, and never for a hold that had no clock to begin with;
 *   3. nothing about expiry is described as a reversal, because nothing was ever
 *      frozen at a bank;
 *   4. the sweeps actually run: a lib function with no scheduler is a table of
 *      rows waiting for a caller that will never come.
 *
 * Real rows, real state machine, real audit chain. A mocked `db` here would only
 * prove that this file's own stub answers the way this file expects.
 */
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { db } from "@/lib/db";
import { transitionCase } from "@/lib/case-state-machine";
import { sweepExpiredFreezeWindows } from "@/lib/freeze-window";

// The window is read per call (`env.reversalWindowSecs`), so the suite sets its own
// deadline instead of waiting out the production five minutes or faking a clock.
const WINDOW_SECS = 60;
process.env.REVERSAL_WINDOW_SECS = String(WINDOW_SECS);

const RUN = `fw-${randomUUID().slice(0, 8)}`;
const opened: { caseRefs: string[]; orgIds: string[] } = { caseRefs: [], orgIds: [] };

/** A case already staged, with the clock placed exactly where the test needs it. */
async function stagedHold(args: {
  agedSecs: number | null;
  committedAt?: Date;
  org?: string;
}): Promise<{ caseRef: string; orgId: string }> {
  const orgId = args.org ?? `${RUN}-org-${randomUUID().slice(0, 8)}`;
  const caseRef = `${RUN}-case-${randomUUID().slice(0, 8)}`;
  opened.orgIds.push(orgId);
  opened.caseRefs.push(caseRef);
  await db.case.create({
    data: {
      caseRef,
      orgId,
      state: "FREEZE_STAGED",
      freezeStaged: true,
      freezeReference: `SV-FRZ-${caseRef}`,
      freezeStagedAt: args.agedSecs === null ? null : new Date(Date.now() - args.agedSecs * 1000),
      freezeCommittedAt: args.committedAt ?? null,
    },
    select: { id: true },
  });
  return { caseRef, orgId };
}

const stateOf = async (caseRef: string) =>
  (await db.case.findUnique({ where: { caseRef } }))?.state;

beforeAll(async () => {
  // The sweep is a platform duty with no tenant filter, and this is a shared test
  // database: a suite whose process was killed leaves its staged holds behind, and
  // those rows now carry clocks the sweep will honour. Lap them first so every
  // assertion below is about the fixtures this file created, the same way
  // tests/realtime acknowledges the slate before measuring the escalation ladder.
  await sweepExpiredFreezeWindows();
});

afterAll(async () => {
  // An unacknowledged page sits in the set every global escalation sweep reads, so
  // this suite closes what it opened.
  await db.notification
    .updateMany({ where: { orgId: { in: opened.orgIds } }, data: { acknowledgedAt: new Date() } })
    .catch(() => {});
  await db.case.deleteMany({ where: { caseRef: { in: opened.caseRefs } } }).catch(() => {});
});

describe("staging stamps the clock", () => {
  test("the state machine records when a hold was staged", async () => {
    const orgId = `${RUN}-stamp-${randomUUID().slice(0, 8)}`;
    const caseRef = `${RUN}-stamp-${randomUUID().slice(0, 8)}`;
    opened.orgIds.push(orgId);
    opened.caseRefs.push(caseRef);
    await db.case.create({ data: { caseRef, orgId, state: "CONFIRMED_FRAUD" } });

    const before = Date.now();
    await transitionCase(caseRef, "FREEZE_STAGED", {
      freezeStaged: true,
      freezeReference: `SV-FRZ-${caseRef}`,
    });
    const row = await db.case.findUnique({ where: { caseRef } });
    expect(row?.state).toBe("FREEZE_STAGED");
    const stagedAt = row?.freezeStagedAt?.getTime();
    // A real instant, taken now — not null, not the row's creation time.
    expect(stagedAt).toBeGreaterThan(before - 5_000);
    expect(stagedAt).toBeLessThan(Date.now() + 5_000);
  });

  test("a caller cannot hand the state machine its own deadline", async () => {
    const orgId = `${RUN}-forge-${randomUUID().slice(0, 8)}`;
    const caseRef = `${RUN}-forge-${randomUUID().slice(0, 8)}`;
    opened.orgIds.push(orgId);
    opened.caseRefs.push(caseRef);
    await db.case.create({ data: { caseRef, orgId, state: "CONFIRMED_FRAUD" } });

    // An epoch clock would read as a hold whose window closed 56 years ago: swept
    // on the next tick, escalated, paged. The writer stamps after spreading the
    // caller's meta, so a forged deadline never lands.
    await transitionCase(caseRef, "FREEZE_STAGED", { freezeStagedAt: new Date(0) });
    const row = await db.case.findUnique({ where: { caseRef } });
    expect(row?.freezeStagedAt?.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });
});

describe("sweepExpiredFreezeWindows", () => {
  test("a closed window escalates: marker, state move, audit row, page", async () => {
    const { caseRef, orgId } = await stagedHold({ agedSecs: WINDOW_SECS * 4 });

    const now = new Date();
    expect(await sweepExpiredFreezeWindows(now)).toContain(caseRef);

    const row = await db.case.findUnique({ where: { caseRef } });
    expect(row?.state).toBe("ESCALATED");
    expect(row?.freezeLapsedAt?.getTime()).toBe(now.getTime());
    expect(row?.freezeCommittedAt).toBeNull();
    // The hold really was staged; expiring it does not edit that fact away.
    expect(row?.freezeStaged).toBe(true);

    const audit = await db.auditLog.findFirst({
      where: { callRef: caseRef, intent: "freeze_window_lapsed" },
      select: { meta: true },
    });
    expect(audit).not.toBeNull();
    // `AuditLog.meta` is a JSON STRING column, canonicalised once for the hash and
    // stored verbatim, so the chain's bytes and the row's bytes are the same bytes.
    const meta = JSON.parse(String(audit?.meta)) as Record<string, unknown>;
    expect(meta.committed).toBe(false);
    expect(meta.enforcement).toBe("escalated");
    expect(meta.reversal_window_secs).toBe(WINDOW_SECS);

    const page = await db.notification.findFirst({
      where: { orgId, alertType: "case:freeze_window_lapsed" },
    });
    expect(page?.severity).toBe("page");
    expect(page?.caseRef).toBe(caseRef);
  });

  test("a hold still inside its window is left alone", async () => {
    const { caseRef } = await stagedHold({ agedSecs: 5 });
    expect(await sweepExpiredFreezeWindows()).not.toContain(caseRef);
    expect(await stateOf(caseRef)).toBe("FREEZE_STAGED");
  });

  test("a hold a human committed is never reported as lapsed", async () => {
    // The residue of the commit/claim race: still FREEZE_STAGED, already committed.
    // `state` alone would sweep it, which is why the predicate carries the commit.
    const { caseRef } = await stagedHold({ agedSecs: WINDOW_SECS * 4, committedAt: new Date() });
    expect(await sweepExpiredFreezeWindows()).not.toContain(caseRef);
    const row = await db.case.findUnique({ where: { caseRef } });
    expect(row?.freezeLapsedAt).toBeNull();
    expect(row?.freezeCommittedAt).not.toBeNull();
  });

  test("a hold staged before the clock existed is not escalated", async () => {
    // The page-storm guard. Rows written by the previous code have no staging
    // instant, and inventing one from `createdAt` would lapse years of settled
    // decisions on the first tick after a deploy.
    const { caseRef } = await stagedHold({ agedSecs: null });
    expect(await sweepExpiredFreezeWindows()).not.toContain(caseRef);
    expect(await stateOf(caseRef)).toBe("FREEZE_STAGED");
  });

  test("expiry escalates once, not on every tick", async () => {
    const { caseRef } = await stagedHold({ agedSecs: WINDOW_SECS * 4 });
    expect(await sweepExpiredFreezeWindows()).toContain(caseRef);
    const before = await db.auditLog.count({
      where: { callRef: caseRef, intent: "freeze_window_lapsed" },
    });
    expect(await sweepExpiredFreezeWindows()).not.toContain(caseRef);
    const after = await db.auditLog.count({
      where: { callRef: caseRef, intent: "freeze_window_lapsed" },
    });
    expect(after).toBe(before);
  });

  test("one expiry is a lapse and never a reversal", async () => {
    const { caseRef } = await stagedHold({ agedSecs: WINDOW_SECS * 4 });
    await sweepExpiredFreezeWindows();
    const rows = await db.auditLog.findMany({
      where: { callRef: caseRef },
      select: { intent: true },
    });
    const intents = rows.map((r) => r.intent).join(" ");
    // Nothing was frozen at a bank, so nothing can be unfrozen here. A row claiming
    // a reversal would be a false statement about a financial action — the exact
    // falsehood the ruling behind this sweep exists to prevent.
    expect(intents).not.toMatch(/revers|unfreeze|thaw|release/);
    expect(intents).toContain("freeze_window_lapsed");
  });

  test("the sweep is bounded, and the cut strands nothing", async () => {
    const a = await stagedHold({ agedSecs: WINDOW_SECS * 9 });
    const b = await stagedHold({ agedSecs: WINDOW_SECS * 3 });

    const first = await sweepExpiredFreezeWindows(new Date(), 1);
    expect(first).toHaveLength(1);
    // Oldest clock first, so what has waited longest is what gets served.
    expect(first).toContain(a.caseRef);
    expect(await stateOf(b.caseRef)).toBe("FREEZE_STAGED");

    // One row per tick is a bound, not a truncation of duty: the rest are met on a
    // later tick rather than dropped.
    for (let i = 0; i < 5 && (await stateOf(b.caseRef)) === "FREEZE_STAGED"; i++) {
      await sweepExpiredFreezeWindows(new Date(), 1);
    }
    expect(await stateOf(b.caseRef)).toBe("ESCALATED");
  });

  test("a page belongs to one tenant and carries only its own case", async () => {
    const mine = await stagedHold({ agedSecs: WINDOW_SECS * 4 });
    const otherOrg = `${RUN}-other-${randomUUID().slice(0, 8)}`;
    opened.orgIds.push(otherOrg);
    const theirs = await stagedHold({ agedSecs: WINDOW_SECS * 4, org: otherOrg });

    await sweepExpiredFreezeWindows();
    // The sweep serves every tenant, so both lapse. What must not happen is either
    // page carrying the other's case, or landing in the other's inbox.
    expect(await stateOf(theirs.caseRef)).toBe("ESCALATED");
    for (const { caseRef, orgId } of [mine, theirs]) {
      const page = await db.notification.findFirst({
        where: { orgId, alertType: "case:freeze_window_lapsed" },
      });
      expect(page?.caseRef).toBe(caseRef);
      const foreign = await db.notification.count({
        where: { alertType: "case:freeze_window_lapsed", caseRef, orgId: { not: orgId } },
      });
      expect(foreign).toBe(0);
    }
  });
});

describe("the sweeps are scheduled", () => {
  const worker = readFileSync("src/worker/dial.ts", "utf8");
  const tick = worker.slice(
    worker.indexOf("async function maybeSweep"),
    worker.indexOf("async function tick"),
  );

  test("every platform deadline runs on the worker's tick", () => {
    // Matched inside the function body, not the file: an import line would satisfy
    // a whole-file match while nothing ever called it — which is how
    // `advanceEscalations` spent a year looking wired while only a route
    // re-exported it.
    expect(tick).toContain("await sweepExpiredSmsCases()");
    expect(tick).toContain("await sweepExpiredFreezeWindows()");
    expect(tick).toContain("await advanceEscalations()");
  });

  test("one failing sweep cannot stop the others or the dial drain", () => {
    expect((tick.match(/try \{/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((tick.match(/catch \(err\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test("the staging clock is stamped once, by the single writer", () => {
    const machine = readFileSync("src/lib/case-state-machine.ts", "utf8");
    expect(machine.match(/freezeStagedAt: new Date\(\)/g) ?? []).toHaveLength(1);

    // The routes that stage a hold must do it through `transitionCase`: a writer
    // that set the row itself would stage holds nothing ever expires. Matched on
    // `db.case.<mutator>` rather than on the literal `state: "FREEZE_STAGED"`,
    // because that text is also a field of a return type in ai-authz.ts and a
    // whole-file regex cannot tell a type annotation from a database write.
    for (const file of [
      "src/app/api/elevenlabs/tools/card-freeze/route.ts",
      "src/lib/ai/ai-authz.ts",
    ]) {
      const src = readFileSync(file, "utf8");
      expect(src).not.toMatch(/db\.case\.(update|updateMany|create|delete)/);
      expect(src).toContain("transitionCase(");
    }
  });

  test("a commit that arrives after the lapse is refused, and records when it did not", () => {
    // Static, because the commit route needs a step-up-authenticated session: the
    // property worth pinning is that this route both checks the marker and writes
    // `freezeCommittedAt`, the column that keeps "a specialist held this card"
    // distinguishable from "nobody decided" now that both land in ESCALATED.
    const commit = readFileSync("src/app/api/console/freeze/commit/route.ts", "utf8");
    expect(commit).toMatch(/caseRow\.freezeLapsedAt/);
    expect(commit).toMatch(/freezeCommittedAt:\s*committedAt/);
  });
});
