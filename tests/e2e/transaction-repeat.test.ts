/**
 * The transaction_ref race, and the refusal contract it must produce.
 *
 * The unique index on Case(orgId, transactionRef) is the atomic backstop against
 * two signals dialling one transaction. The test that matters is not "the index
 * exists" — it is that the loser of the race gets the SAME typed refusal the
 * policy gate's fast path returns, rather than an unhandled 500.
 *
 * A 500 here would be actively harmful: it tells the bank "our fault, retry
 * later", so a client honouring that retries into the same wall, and the body
 * leaks an internal constraint name.
 *
 *   bun test tests/e2e/transaction-repeat.test.ts
 */
import { test, expect, afterAll } from "bun:test";
import { createCase } from "@/lib/case-state-machine";
import { db, dbAudit } from "@/lib/db";

const stamp = Date.now().toString(36);
const ORG = `txn-repeat-${stamp}`;
const REF = `TXN-REPEAT-${stamp}`;

afterAll(async () => {
  await db.case.deleteMany({ where: { transactionRef: REF } });
  await db.$disconnect();
  await dbAudit.$disconnect();
});

test("a repeated transaction_ref is refused as 409 transaction_repeat, not a 500", async () => {
  const first = await createCase({
    caseRef: `SV-T-${stamp.toUpperCase()}`,
    orgId: ORG,
    transactionRef: REF,
  });
  expect(first.state).toBe("RECEIVED");

  let thrown: unknown;
  try {
    await createCase({
      caseRef: `SV-U-${stamp.toUpperCase()}`,
      orgId: ORG,
      transactionRef: REF,
    });
  } catch (err) {
    thrown = err;
  }

  // Refused, not crashed.
  expect(thrown).toBeDefined();
  const typed = thrown as { status?: number; code?: string; message?: string };
  expect(typed.status).toBe(409);
  expect(typed.code).toBe("transaction_repeat");
  // The body must name the transaction, not the database constraint.
  expect(typed.message ?? "").toContain(REF);
  expect(typed.message ?? "").not.toContain("P2002");
  expect(typed.message ?? "").not.toContain("Case_orgId");

  // Exactly one case exists for the transaction.
  expect(await db.case.count({ where: { transactionRef: REF } })).toBe(1);
}, 60_000);

test("a different org may legitimately use the same transaction_ref", async () => {
  // Scoped per org on purpose: two banks must be able to reference the same
  // upstream transaction without colliding, or the dedup would refuse one
  // bank's traffic because of another bank's data.
  const other = `txn-repeat-other-${stamp}`;
  const ref = `TXN-SHARED-${stamp}`;
  const a = await createCase({
    caseRef: `SV-V-${stamp.toUpperCase()}`,
    orgId: ORG,
    transactionRef: ref,
  });
  const b = await createCase({
    caseRef: `SV-W-${stamp.toUpperCase()}`,
    orgId: other,
    transactionRef: ref,
  });
  expect(a.id).not.toBe(b.id);

  await db.case.deleteMany({ where: { transactionRef: ref } });
}, 60_000);
