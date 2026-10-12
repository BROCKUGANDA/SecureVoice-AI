/**
 * The soft freeze the customer is told about must exist in the database.
 *
 * `src/lib/ai/ai-authz.ts` used to be a stub: it returned `{ ok: true, status:
 * 202 }` for any input, read nothing, wrote nothing, and its two callers
 * discarded the result and then spoke, in the caller's own language, "I have
 * temporarily restricted your card to protect your account." This suite is what
 * keeps that from coming back. Every assertion here is about what a row says
 * after the call, because a spoken confirmation with no row behind it is the
 * failure this product cannot have: a customer hanging up believing their funds
 * are protected when nothing was written.
 *
 *   bun test tests/tools/soft-freeze.test.ts
 */
import { afterAll, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { executeSoftFreeze } from "@/lib/ai/ai-authz";
import { TOOL_TENANT_ORG_ID } from "../tool-tenant";

const RUN_ID = Date.now().toString(36).toUpperCase();
const createdCaseRefs: string[] = [];
let caseSeq = 0;

async function makeCase(state: string, callSid: string) {
  // Suffix from a counter, not from the call sid: every sid below ends with the
  // same RUN_ID, so a slice of it collides on `Case_caseRef_key`.
  const caseRef = `SV-F-FRZ${RUN_ID}${(caseSeq++).toString().padStart(2, "0")}`;
  createdCaseRefs.push(caseRef);
  return db.case.create({
    data: { caseRef, callSid, orgId: TOOL_TENANT_ORG_ID, state },
    select: { caseRef: true },
  });
}

const freezeRows = (caseRef: string) =>
  db.auditLog.count({ where: { callRef: caseRef, action: "freeze", intent: "freeze_staged" } });

afterAll(async () => {
  if (createdCaseRefs.length > 0) {
    await db.auditLog.deleteMany({ where: { callRef: { in: createdCaseRefs } } });
    await db.case.deleteMany({ where: { caseRef: { in: createdCaseRefs } } });
  }
}, 60_000);

test("a call leg with no case stages nothing and says so", async () => {
  const res = await executeSoftFreeze(`CA_UNMAPPED_${RUN_ID}`);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe("no_case");
});

test("an empty call reference stages nothing", async () => {
  const res = await executeSoftFreeze("");
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe("no_case");
});

test("a caller's denial on a live call writes a durable, audited hold", async () => {
  const sid = `CA_VERIFY_${RUN_ID}`;
  const { caseRef } = await makeCase("VERIFYING", sid);

  const res = await executeSoftFreeze(sid, "test_media_stream");
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.caseRef).toBe(caseRef);
  expect(res.reference).toBe(`SV-FRZ-${caseRef}`);
  expect(res.alreadyStaged).toBe(false);

  const row = await db.case.findUnique({ where: { caseRef } });
  expect(row?.state).toBe("FREEZE_STAGED");
  expect(row?.freezeStaged).toBe(true);
  expect(row?.freezeReference).toBe(`SV-FRZ-${caseRef}`);
  // The customer's denial is recorded before the hold that follows from it.
  expect(row?.customerResponse).toBe("no");

  expect(await freezeRows(caseRef)).toBe(1);
});

test("a second freeze on the same case does not stage twice or decide twice", async () => {
  const sid = `CA_TWICE_${RUN_ID}`;
  const { caseRef } = await makeCase("DISCLOSED", sid);

  const first = await executeSoftFreeze(sid, "test_media_stream");
  expect(first.ok).toBe(true);
  const second = await executeSoftFreeze(sid, "test_media_stream");
  expect(second.ok).toBe(true);
  if (second.ok) expect(second.alreadyStaged).toBe(true);

  // One hold, one decision on the chain. A duplicate would read to a compliance
  // reviewer as the agent freezing the card twice.
  expect(await freezeRows(caseRef)).toBe(1);
});

test("a case in a state that forbids a hold is refused, and stays as it was", async () => {
  const sid = `CA_CLOSED_${RUN_ID}`;
  const { caseRef } = await makeCase("CLOSED", sid);

  const res = await executeSoftFreeze(sid, "test_media_stream");
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.code).toBe("illegal_state");
    expect(res.from).toBe("CLOSED");
  }

  const row = await db.case.findUnique({ where: { caseRef } });
  expect(row?.state).toBe("CLOSED");
  expect(row?.freezeStaged).not.toBe(true);
  expect(await freezeRows(caseRef)).toBe(0);
});

test("an UNREACHABLE case cannot be frozen from a call that never happened", async () => {
  const sid = `CA_UNREACH_${RUN_ID}`;
  const { caseRef } = await makeCase("UNREACHABLE", sid);
  const res = await executeSoftFreeze(sid, "test_media_stream");
  expect(res.ok).toBe(false);
  const row = await db.case.findUnique({ where: { caseRef } });
  expect(row?.state).toBe("UNREACHABLE");
});

test("a case already at CONFIRMED_FRAUD goes straight to the hold", async () => {
  const sid = `CA_CONFIRMED_${RUN_ID}`;
  const { caseRef } = await makeCase("CONFIRMED_FRAUD", sid);
  const res = await executeSoftFreeze(sid, "test_media_stream");
  expect(res.ok).toBe(true);
  const row = await db.case.findUnique({ where: { caseRef } });
  expect(row?.state).toBe("FREEZE_STAGED");
});
