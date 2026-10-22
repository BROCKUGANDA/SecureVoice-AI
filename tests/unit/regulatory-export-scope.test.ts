import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { generateCaseFile } from "@/lib/regulatory-export";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const REF_A = `SV-F-SCOPE-${Date.now().toString(36).toUpperCase()}`;

/**
 * A case ref is guessable enough to be an identifier, not an authorisation.
 * The package builder must refuse a ref outside the caller's tenant even when
 * the ref exists, and must still serve it to the owning tenant.
 */
test("regulatory evidence export is tenant-scoped", async () => {
  await db.case.create({
    data: {
      caseRef: REF_A,
      orgId: ORG_A,
      state: "CONFIRMED_FRAUD",
      transcriptRedacted: "redacted transcript",
    },
  });

  await expect(generateCaseFile(REF_A, ORG_B)).rejects.toThrow("Case not found");

  const owned = await generateCaseFile(REF_A, ORG_A);
  expect(owned.intervention_id).toBeTruthy();
  expect(owned.ai_transcript).toBe("redacted transcript");

  // A platform operator (null) may still export across tenants.
  const platform = await generateCaseFile(REF_A, null);
  expect(platform.intervention_id).toBe(owned.intervention_id);
});

test("a confirmed case remains STR-eligible after freeze and escalation", async () => {
  const ref = `SV-F-STR-${Date.now().toString(36).toUpperCase()}`;
  await db.case.create({
    data: {
      caseRef: ref,
      orgId: ORG_A,
      state: "FREEZE_STAGED",
      transcriptRedacted: "redacted transcript",
    },
  });
  try {
    const pkg = await generateCaseFile(ref, ORG_A, { requireConfirmedFraud: true });
    expect(pkg.case_state).toBe("FREEZE_STAGED");
    expect(pkg.ai_transcript).toBe("redacted transcript");
  } finally {
    await db.auditLog.deleteMany({ where: { callRef: ref } });
    await db.case.deleteMany({ where: { caseRef: ref } });
  }
});

test("an unconfirmed case is still refused for an STR", async () => {
  const ref = `SV-F-STR-NO-${Date.now().toString(36).toUpperCase()}`;
  await db.case.create({
    data: { caseRef: ref, orgId: ORG_A, state: "UNCERTAIN" },
  });
  try {
    await expect(generateCaseFile(ref, ORG_A, { requireConfirmedFraud: true })).rejects.toThrow(
      "confirmed-fraud state",
    );
  } finally {
    await db.case.deleteMany({ where: { caseRef: ref } });
  }
});

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { callRef: REF_A } });
  await db.case.deleteMany({ where: { caseRef: REF_A } });
});
