/**
 * MODERATION USAGE METERING — the PLANNED #1 ticket from the register.
 *
 * `recordModerationUsage` writes `moderation` rows into the `UsageLedger`
 * journal — the billing-grade, idempotent surface every other metered
 * vendor path uses — WITHOUT charging anything. Proven here against the
 * real Postgres and the real ledger writer:
 *
 *   1. A moderation call writes exactly one row: kind `moderation`, reason
 *      `moderation:{stage}:{verdict}`, the caller's units, org-scoped.
 *   2. A replay of the same (stage + trace) returns the original row and
 *      writes nothing second — idempotency is on the call, not the money.
 *   3. Wallet, held and available are UNCHANGED by metering (zero weights —
 *      metering is not a spend decision), while the journal `posted` total
 *      grows, so the usage is auditable per tenant.
 *   4. Another tenant's snapshot is unaffected: rows are org-scoped, and
 *      usage written for org A never even appears in org B's `posted`.
 *   5. Bad input is refused loudly at the boundary (empty org/trace/stage/
 *      verdict, negative units) rather than written as garbage rows.
 *
 *   bun scripts/run-tests.mjs moderation-metering
 */
import { afterAll, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { recordModerationUsage, snapshot } from "@/lib/billing/ledger";

const RUN = Date.now().toString(36);
const HEX = (Date.now().toString(16) + "0".repeat(12)).slice(0, 12);
// `organization.id` is a uuid column; the ledger's orgId is a plain string,
// but run-scoped uuids keep cleanup explicit and collisions impossible.
const ORG = `44444444-4444-4333-8333-${HEX}`;
const OTHER_ORG = `55555555-5555-4333-8333-${HEX}`;

async function meteringRows(orgId: string) {
  return db.usageLedger.findMany({
    where: { orgId, kind: "moderation" },
    orderBy: { createdAt: "asc" },
  });
}

afterAll(async () => {
  await db.usageLedger.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
  await db.$disconnect();
});

test("a moderation call writes exactly one metering row", async () => {
  const write = await recordModerationUsage({
    orgId: ORG,
    traceId: `mod-trace-${RUN}-1`,
    stage: "input",
    verdict: "safe",
    units: 42,
  });
  expect(write.ok).toBe(true);
  if (!write.ok) return;
  expect(write.duplicate).toBe(false);
  expect(write.entry.kind).toBe("moderation");
  expect(write.entry.units).toBe(42);
  expect(write.entry.reason).toBe("moderation:input:safe");
  expect(write.entry.idemKey).toBe(`moderation:input:mod-trace-${RUN}-1`);

  const rows = await meteringRows(ORG);
  expect(rows.length).toBe(1);
  expect(rows[0]!.units).toBe(42);
});

test("a replayed call returns the original row, not a second one", async () => {
  const first = await recordModerationUsage({
    orgId: ORG,
    traceId: `mod-trace-${RUN}-replay`,
    stage: "output",
    verdict: "safe",
    units: 10,
  });
  const second = await recordModerationUsage({
    orgId: ORG,
    traceId: `mod-trace-${RUN}-replay`,
    stage: "output",
    verdict: "safe",
    units: 10,
  });
  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(second.duplicate).toBe(true);
  expect(second.entry.id).toBe(first.entry.id);
  expect((await meteringRows(ORG)).length).toBeGreaterThanOrEqual(2);
  expect(
    (await meteringRows(ORG)).filter(
      (r) => r.idemKey === `moderation:output:mod-trace-${RUN}-replay`,
    ).length,
  ).toBe(1);
});

test("metering moves no money: wallet, held and available are unchanged", async () => {
  const before = await snapshot(ORG);
  await recordModerationUsage({
    orgId: ORG,
    traceId: `mod-trace-${RUN}-bal`,
    stage: "speech",
    verdict: "unsafe",
    units: 1000,
  });
  const after = await snapshot(ORG);
  // Money pools are identical...
  expect(after.wallet).toBe(before.wallet);
  expect(after.held).toBe(before.held);
  expect(after.available).toBe(before.available);
  // ...while the raw journal total grew by exactly the metered units, so the
  // usage is auditable without ever having spent a unit of the tenant's
  // wallet. (`rows` in the snapshot counts distinct kinds present, NOT rows,
  // so it is not asserted here — `posted` is the journal's unit total.)
  expect(after.posted - before.posted).toBe(1000);
  expect(
    (await meteringRows(ORG)).filter((r) => r.idemKey === `moderation:speech:mod-trace-${RUN}-bal`)
      .length,
  ).toBe(1);
});

test("rows are org-scoped: another tenant sees none of this usage", async () => {
  await recordModerationUsage({
    orgId: OTHER_ORG,
    traceId: `mod-trace-${RUN}-other`,
    stage: "input",
    verdict: "controversial",
    units: 7,
  });
  const mine = await meteringRows(ORG);
  const theirs = await meteringRows(OTHER_ORG);
  expect(theirs.length).toBe(1);
  expect(mine.every((r) => r.idemKey !== `moderation:input:mod-trace-${RUN}-other`)).toBe(true);
  const otherSnap = await snapshot(OTHER_ORG);
  expect(otherSnap.posted).toBe(7);
  expect(otherSnap.wallet).toBe(0);
  expect(otherSnap.available).toBe(0);
});

test("bad input is refused at the boundary, not written as garbage", async () => {
  await expect(
    recordModerationUsage({ orgId: "  ", traceId: "x", stage: "input", verdict: "safe", units: 1 }),
  ).rejects.toThrow(TypeError);
  await expect(
    recordModerationUsage({ orgId: ORG, traceId: "", stage: "input", verdict: "safe", units: 1 }),
  ).rejects.toThrow(TypeError);
  await expect(
    recordModerationUsage({ orgId: ORG, traceId: "x", stage: "", verdict: "safe", units: 1 }),
  ).rejects.toThrow(TypeError);
  await expect(
    recordModerationUsage({ orgId: ORG, traceId: "x", stage: "input", verdict: "", units: 1 }),
  ).rejects.toThrow(TypeError);
  await expect(
    recordModerationUsage({ orgId: ORG, traceId: "x", stage: "input", verdict: "safe", units: -1 }),
  ).rejects.toThrow(RangeError);
});
