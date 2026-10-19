/**
 * PRIVACY GATE — the blind index, and what it finally allows.
 *
 * `pii_vault` was write-only: `storePii()` minted a random uuid, only `resolvePii()`
 * read it, so nothing could ask the vault "do you already hold this number?". That
 * is the reason `Case.phone` kept the customer's number in the clear — an inbound
 * SMS reply and an inbound voice callback arrive with a number and NO tenant, and
 * the only thing they could match on was the readable column.
 *
 * Properties under test:
 *   1. a vault row is FINDABLE and DEDUPED per tenant, and the same number in two
 *      tenants hashes to two different indexes (so the table cannot be used to
 *      discover that one person banks twice);
 *   2. a case written through `createCase` carries a token and an org-free match
 *      index, and holds no readable number — while the number still resolves for
 *      the dial, because the point of vaulting it is not to lose it;
 *   3. the reply path that decides a fraud report still finds its alert, including
 *      the cross-tenant fail-safe and rows the backfill has not reached;
 *   4. erasure reaches the relocated value, not just the pointer;
 *   5. the backfill is dry-run by default and idempotent.
 *
 * A sealing key is required for all of this, so the suite brings its own — never a
 * deployment's.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { db } from "@/lib/db";
import { createCase } from "@/lib/case-state-machine";
import { eraseCase } from "@/lib/privacy/crypto-shred";
import { handleSmsReply } from "@/lib/sms-verdict";
import {
  blindIndexOf,
  casePhoneWhere,
  resolveCasePhone,
  storePii,
  tokenForPii,
} from "@/lib/compliance/pii-vault";

process.env.AUTH_SECRET = "blind-index-suite-key-0123456789abcdef0123456789abcdef";
process.env.ELEVENLABS_DRY_RUN = "true";

const RUN = `bi-${randomUUID().slice(0, 8)}`;
const madeCases: string[] = [];
const madeOrgs: string[] = [];
/** `organization` rows this suite created — the clear script needs a living tenant. */
const madeOrgRows: string[] = [];

function newOrg(): string {
  // A real uuid: `Organization.id` is a uuid column and two case-write paths look
  // it up (`getInstitutionType`, the vendor webhook endpoint). A synthetic prefix
  // makes both throw and get caught, so the suite passes while filling the log
  // with errors that bury the ones worth reading.
  const orgId = randomUUID();
  madeOrgs.push(orgId);
  return orgId;
}

afterAll(async () => {
  const tokens = await db.case.findMany({
    where: { caseRef: { in: madeCases } },
    select: { customerPhoneToken: true },
  });
  await db.case.deleteMany({ where: { caseRef: { in: madeCases } } }).catch(() => undefined);
  for (const row of tokens) {
    if (!row.customerPhoneToken) continue;
    await db.$executeRaw`DELETE FROM "pii_vault" WHERE "token" = ${row.customerPhoneToken}`;
  }
  // Rows sealed directly by this suite, which no case points at.
  await db.pIIVault.deleteMany({ where: { orgId: { in: madeOrgs } } });
  await db.organization.deleteMany({ where: { id: { in: madeOrgRows } } }).catch(() => undefined);
});

/** A raw, queryable case row: the shape the backfill has not reached yet. */
async function legacyCase(orgId: string, phone: string, ageMs = 0) {
  const caseRef = `${RUN}-legacy-${randomUUID().slice(0, 8)}`;
  madeCases.push(caseRef);
  await db.case.create({
    data: {
      caseRef,
      orgId,
      state: "UNREACHABLE",
      phone,
      language: "en",
      smsSentAt: new Date(Date.now() - ageMs),
    },
    select: { id: true },
  });
  return caseRef;
}

describe("the vault index", () => {
  test("sealing the same value twice for one tenant returns ONE token", async () => {
    const orgId = newOrg();
    const phone = "+971501112222";
    const first = await storePii({ orgId, type: "phone", plaintext: phone });
    const second = await storePii({ orgId, type: "phone", plaintext: phone });
    expect(second).toBe(first);
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "pii_vault" WHERE "orgId" = ${orgId} AND "type" = 'phone'
    `;
    expect(rows[0]?.n).toBe(1);
    // The token that survives is the one that decrypts.
    expect(await resolveCasePhone({ customerPhoneToken: first, phone: null }, orgId)).toBe(phone);
  });

  test("spelling differences resolve to the same index", async () => {
    const orgId = newOrg();
    const token = await storePii({ orgId, type: "phone", plaintext: "+971 50 111 2233" });
    expect(await tokenForPii({ orgId, type: "phone", plaintext: "+971501112233" })).toBe(token);
  });

  test("two tenants holding one number get different tokens AND different indexes", async () => {
    const bank = newOrg();
    const insurer = newOrg();
    const phone = "+971501119999";
    const bankToken = await storePii({ orgId: bank, type: "phone", plaintext: phone });
    const insurerToken = await storePii({ orgId: insurer, type: "phone", plaintext: phone });
    expect(bankToken).not.toBe(insurerToken);

    // The vault's index is org-scoped on purpose: the same value hashes differently
    // per tenant, so a reader of `pii_vault` cannot group the two rows and learn
    // that one customer banks at both.
    const indexes = await db.$queryRaw<{ orgId: string; blindIndex: string }[]>`
      SELECT "orgId", "blindIndex" FROM "pii_vault" WHERE "type" = 'phone'
        AND "orgId" IN (${bank}, ${insurer})
    `;
    expect(indexes).toHaveLength(2);
    expect(indexes[0]!.blindIndex).not.toBe(indexes[1]!.blindIndex);

    // Neither tenant can read the other's value with its own token.
    expect(await tokenForPii({ orgId: bank, type: "phone", plaintext: phone })).toBe(bankToken);
  });

  test("the case index is org-free, which is what lets a tenant-less reply match", async () => {
    const phone = "+971501118888";
    expect(blindIndexOf("phone", phone)).toBe(blindIndexOf("phone", phone, undefined));
    // An org-scoped case index could not be computed by the SMS reply path at all.
    expect(blindIndexOf("phone", phone)).not.toBe(blindIndexOf("phone", phone, "some-org"));
  });
});

describe("a case written through createCase", () => {
  test("holds a token and an index, and no readable number", async () => {
    const orgId = newOrg();
    const phone = "+971501114444";
    const created = await createCase({
      caseRef: `${RUN}-c-${randomUUID().slice(0, 8)}`,
      orgId,
      phone,
    });
    madeCases.push(created.caseRef);

    const row = await db.case.findUnique({ where: { caseRef: created.caseRef } });
    expect(row?.phone).toBeNull();
    expect(row?.customerPhoneToken).not.toBeNull();
    expect(row?.phoneIndex).toBe(blindIndexOf("phone", phone));

    // The number is gone from the table in every form a query can express...
    expect(await db.case.count({ where: { phone } })).toBe(0);
    // ...but the destination still resolves, because the dial path is why it exists.
    expect(await resolveCasePhone(row, orgId)).toBe(phone);
  });

  test("is found by a lookup that has no tenant", async () => {
    const orgId = newOrg();
    const phone = "+971501115555";
    const created = await createCase({
      caseRef: `${RUN}-c-${randomUUID().slice(0, 8)}`,
      orgId,
      phone,
    });
    madeCases.push(created.caseRef);
    await db.case.update({
      where: { caseRef: created.caseRef },
      data: { state: "UNREACHABLE", smsSentAt: new Date() },
    });

    const found = await db.case.findMany({
      where: casePhoneWhere(phone),
      select: { caseRef: true },
    });
    expect(found.map((f) => f.caseRef)).toContain(created.caseRef);
  });

  test("keeps the number when there is no key to seal it with", async () => {
    const orgId = newOrg();
    const prior = process.env.AUTH_SECRET;
    const phone = "+971501116666";
    // A deployment that forgot its secret must still be able to intervene: the
    // alternative is a case with no destination and a fraud alert that never rings.
    delete process.env.AUTH_SECRET;
    let caseRef = "";
    try {
      const created = await createCase({
        caseRef: `${RUN}-c-${randomUUID().slice(0, 8)}`,
        orgId,
        phone,
      });
      caseRef = created.caseRef;
    } finally {
      process.env.AUTH_SECRET = prior;
    }
    madeCases.push(caseRef);

    const row = await db.case.findUnique({ where: { caseRef } });
    expect(row?.phone).toBe(phone);
    // Visibly NOT vaulted: nothing about the row claims a protection it did not get.
    expect(row?.customerPhoneToken).toBeNull();
    expect(row?.phoneIndex).toBeNull();
  });

  test("the plaintext is never written from the caller's argument", () => {
    // Source-level: `createCase` must take the phone from `vaultCasePhone`'s result.
    // A re-introduced `phone: data.phone` would put the number back on every new row
    // while the vault kept filling, and the two would disagree silently.
    const source = readFileSync("src/lib/case-state-machine.ts", "utf8");
    const payload = source.slice(
      source.indexOf("db.case.create({"),
      source.indexOf("select: { id: true, caseRef: true, state: true }"),
    );
    expect(payload.length, "the create payload was not findable — update this pin").toBeGreaterThan(
      0,
    );
    expect(payload).toContain("phone: destination.phone");
    // Scoped to the payload on purpose: `data.phone` is legitimately read once, as
    // the argument handed to `vaultCasePhone` above the create, and a whole-file
    // match cannot tell the two apart.
    expect(payload).not.toMatch(/phone:\s*data\.phone/);
  });
});

describe("the SMS reply path", () => {
  test("a NO on a vaulted alert reaches the fraud desk", async () => {
    const orgId = newOrg();
    const phone = "+971501120001";
    const created = await createCase({
      caseRef: `${RUN}-c-${randomUUID().slice(0, 8)}`,
      orgId,
      phone,
    });
    madeCases.push(created.caseRef);
    await db.case.update({
      where: { caseRef: created.caseRef },
      data: { state: "UNREACHABLE", smsSentAt: new Date() },
    });

    const result = await handleSmsReply({ from: phone, body: "no" });
    expect(result.outcome).toBe("resolved_no");
    expect(result.caseRef).toBe(created.caseRef);
    expect((await db.case.findUnique({ where: { caseRef: created.caseRef } }))?.state).toBe(
      "NOTIFIED",
    );
  });

  test("a legacy row that still holds the number is answered, not lost", async () => {
    const orgId = newOrg();
    const phone = "+971501120002";
    await legacyCase(orgId, phone);
    const result = await handleSmsReply({ from: phone, body: "yes" });
    expect(result.outcome).toBe("resolved_yes");
  });

  test("one handset with two institutions still closes neither", async () => {
    // The fail-safe the module documents, re-proved on the indexed path: the reply
    // now matches through `phoneIndex`, so the guard against closing the wrong
    // bank's alert has to survive the change of lookup.
    const bank = newOrg();
    const insurer = newOrg();
    const phone = "+971501120003";
    const first = await createCase({
      caseRef: `${RUN}-c-${randomUUID().slice(0, 8)}`,
      orgId: bank,
      phone,
    });
    const second = await createCase({
      caseRef: `${RUN}-c-${randomUUID().slice(0, 8)}`,
      orgId: insurer,
      phone,
    });
    madeCases.push(first.caseRef, second.caseRef);
    await db.case.updateMany({
      where: { caseRef: { in: [first.caseRef, second.caseRef] } },
      data: { state: "UNREACHABLE", smsSentAt: new Date() },
    });

    const result = await handleSmsReply({ from: phone, body: "yes" });
    expect(result.outcome).toBe("ambiguous");
    const states = await db.case.findMany({
      where: { caseRef: { in: [first.caseRef, second.caseRef] } },
      select: { state: true },
    });
    expect(states.map((s) => s.state).sort()).toEqual(["UNREACHABLE", "UNREACHABLE"]);
  });

  test("a reply after the window is 'expired', not 'we never called you'", async () => {
    const orgId = newOrg();
    const phone = "+971501120004";
    // 25h old: outside the reply window, so the open-alert lookup must miss.
    const created = await createCase({
      caseRef: `${RUN}-c-${randomUUID().slice(0, 8)}`,
      orgId,
      phone,
    });
    madeCases.push(created.caseRef);
    await db.case.update({
      where: { caseRef: created.caseRef },
      data: { state: "UNREACHABLE", smsSentAt: new Date(Date.now() - 25 * 3600_000) },
    });

    const result = await handleSmsReply({ from: phone, body: "yes" });
    expect(result.outcome).toBe("expired");
  });

  test("a number nobody alerted is refused without naming a case", async () => {
    const result = await handleSmsReply({ from: "+971509990000", body: "no" });
    expect(result.outcome).toBe("no_open_alert");
    // The answer cannot confirm which numbers are customers of this platform.
    expect(result.caseRef).toBeUndefined();
    expect(typeof result.reply).toBe("string");
  });
});

describe("erasure reaches the value, not just the pointer", () => {
  test("erasing a case clears its columns and destroys its sealed row", async () => {
    const orgId = newOrg();
    const phone = "+971501130001";
    const created = await createCase({
      caseRef: `${RUN}-c-${randomUUID().slice(0, 8)}`,
      orgId,
      phone,
    });
    madeCases.push(created.caseRef);
    const before = await db.case.findUnique({ where: { caseRef: created.caseRef } });
    expect(before?.customerPhoneToken).not.toBeNull();

    const result = await eraseCase(created.caseRef, {
      reason: "test",
      requestedBy: "dpo@example.test",
      legalBasis: "policy:test",
    });
    expect(result.clearedColumns).toContain("customerPhoneToken");
    expect(result.clearedColumns).toContain("phoneIndex");
    expect(result.vaultRowsDestroyed).toBe(1);

    const row = await db.case.findUnique({ where: { caseRef: created.caseRef } });
    expect(row?.phone).toBeNull();
    expect(row?.phoneIndex).toBeNull();
    expect(row?.customerPhoneToken).toBeNull();
    const sealed = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "pii_vault" WHERE "token" = ${before?.customerPhoneToken}
    `;
    expect(sealed[0]?.n).toBe(0);
  });

  test("a token another case still points at is not destroyed", async () => {
    const orgId = newOrg();
    const phone = "+971501130002";
    const a = await createCase({ caseRef: `${RUN}-c-${randomUUID().slice(0, 8)}`, orgId, phone });
    const b = await createCase({ caseRef: `${RUN}-c-${randomUUID().slice(0, 8)}`, orgId, phone });
    madeCases.push(a.caseRef, b.caseRef);
    // The vault dedupes per tenant, so both cases point at ONE sealed row. Erasing
    // one customer's request must not delete data the other case still references.
    expect(
      (await db.case.findUnique({ where: { caseRef: a.caseRef } }))?.customerPhoneToken,
    ).toEqual((await db.case.findUnique({ where: { caseRef: b.caseRef } }))?.customerPhoneToken);

    const first = await eraseCase(a.caseRef, { reason: "test", legalBasis: "policy:test" });
    expect(first.vaultRowsDestroyed).toBe(0);

    const second = await eraseCase(b.caseRef, { reason: "test", legalBasis: "policy:test" });
    expect(second.vaultRowsDestroyed).toBe(1);
  });
});

describe("the backfill script", () => {
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ["--preload", "./scripts/worker-preload.ts", "scripts/backfill-case-phone-vault.ts", ...args],
      { encoding: "utf8", env: process.env, timeout: 120_000 },
    );

  const report = (out: string) => {
    const line = out.split("\n").find((l) => l.startsWith("PII_BACKFILL_REPORT "));
    if (!line) throw new Error(`no report line in:\n${out}`);
    return JSON.parse(line.slice("PII_BACKFILL_REPORT ".length)) as {
      mode: string;
      scanned: number;
      tokenized: number;
      skippedNoOrg: number;
      failed: number;
      pending: number;
    };
  };

  test("the default run reads and writes nothing", async () => {
    const orgId = newOrg();
    const phone = "+971501140001";
    await legacyCase(orgId, phone);
    // `storePii` INSERTs, so a dry run that sealed would leave vault rows no case
    // points at — the name of this test is a property, not a description of mood.
    expect(await db.pIIVault.count({ where: { orgId } })).toBe(0);

    const res = run(["--org", orgId]);
    expect(res.status).toBe(0);
    const parsed = report(res.stdout);
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.scanned).toBe(1);
    expect(parsed.pending).toBe(1);
    // The row is untouched: a dry run that clears plaintext would be the incident
    // this gate exists to keep behind a flag.
    expect((await db.case.findFirst({ where: { phone } }))?.phone).toBe(phone);
    expect(await db.pIIVault.count({ where: { orgId } })).toBe(0);
    expect(res.stdout).toContain("DRY RUN");
  });

  test("--apply vaults, clears, and finds nothing left the second time", async () => {
    const orgId = newOrg();
    const phone = "+971501140002";
    const caseRef = await legacyCase(orgId, phone);

    const applied = report(run(["--apply", "--org", orgId]).stdout);
    expect(applied.mode).toBe("apply");
    expect(applied.tokenized).toBe(1);
    expect(applied.failed).toBe(0);
    expect(applied.pending).toBe(0);

    const row = await db.case.findUnique({ where: { caseRef } });
    expect(row?.phone).toBeNull();
    expect(row?.phoneIndex).toBe(blindIndexOf("phone", phone));
    expect(await db.pIIVault.count({ where: { orgId } })).toBe(1);
    expect(await resolveCasePhone(row, orgId)).toBe(phone);

    // Idempotent: the queue is "rows still holding a number", and there are none.
    const again = report(run(["--apply", "--org", orgId]).stdout);
    expect(again.scanned).toBe(0);
  });

  test("a row with no tenant is counted as un-vaultable, not silently skipped", async () => {
    const phone = "+971501140003";
    const caseRef = `${RUN}-orphan-${randomUUID().slice(0, 8)}`;
    madeCases.push(caseRef);
    await db.case.create({ data: { caseRef, orgId: null, state: "UNREACHABLE", phone } });

    // Read-only over the whole database: an unscoped row is invisible to `--org`,
    // and this property is about the rows that have no org to name.
    const parsed = report(run([]).stdout);
    expect(parsed.scanned).toBeGreaterThanOrEqual(1);
    expect(parsed.skippedNoOrg).toBeGreaterThanOrEqual(1);
    // Left exactly as it was: `storePii` refuses an unscoped vault row, because a
    // token no tenant can resolve is a number that has been lost, not protected.
    expect((await db.case.findUnique({ where: { caseRef } }))?.phone).toBe(phone);
  });
});

describe("the un-vaultable clear script", () => {
  const runClear = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--preload",
        "./scripts/worker-preload.ts",
        "scripts/clear-unvaultable-case-phone.ts",
        ...args,
      ],
      { encoding: "utf8", env: process.env, timeout: 120_000 },
    );

  const clearReport = (out: string) => {
    const line = out.split("\n").find((l) => l.startsWith("PHONE_CLEAR_REPORT "));
    if (!line) throw new Error(`no report line in:\n${out}`);
    return JSON.parse(line.slice("PHONE_CLEAR_REPORT ".length)) as {
      mode: string;
      scanned: number;
      clearedNoOrg: number;
      clearedNoOrgRow: number;
      leftForVault: number;
      contended: number;
      distinctNumbers: number;
      pending: number;
    };
  };

  /** An `organization` row that exists: the one shape this script must never clear. */
  async function livingOrg(): Promise<string> {
    const id = randomUUID();
    madeOrgRows.push(id);
    await db.organization.create({
      data: {
        id,
        name: `Clear suite ${id.slice(0, 8)}`,
        slug: `clear-${RUN}-${id.slice(0, 8)}`,
        createdAt: new Date(),
      },
    });
    return id;
  }

  async function orphanCase(phone: string): Promise<string> {
    const caseRef = `${RUN}-clear-orphan-${randomUUID().slice(0, 8)}`;
    madeCases.push(caseRef);
    await db.case.create({ data: { caseRef, orgId: null, state: "UNREACHABLE", phone } });
    return caseRef;
  }

  test("a dry run names all three reasons and writes nothing", async () => {
    const living = await livingOrg();
    const gone = newOrg();
    const phones = [
      await legacyCase(living, "+971501140011"),
      await legacyCase(gone, "+971501140012"),
      await orphanCase("+971501140013"),
    ];

    const parsed = clearReport(runClear(["--ref-prefix", RUN]).stdout);
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.leftForVault).toBeGreaterThanOrEqual(1);
    expect(parsed.clearedNoOrgRow).toBeGreaterThanOrEqual(1);
    expect(parsed.clearedNoOrg).toBeGreaterThanOrEqual(1);
    // All three still hold their number, so the report is a preview, not a side effect.
    expect(await db.case.count({ where: { caseRef: { in: phones }, phone: { not: null } } })).toBe(
      phones.length,
    );
  });

  test("--apply drops the number, keeps the row, and refuses a living tenant", async () => {
    const living = await livingOrg();
    const gone = newOrg();
    const livingRef = await legacyCase(living, "+971501140021");
    const goneRef = await legacyCase(gone, "+971501140022");
    const orphanRef = await orphanCase("+971501140023");

    const parsed = clearReport(runClear(["--apply", "--ref-prefix", RUN]).stdout);
    expect(parsed.mode).toBe("apply");
    expect(parsed.contended).toBe(0);
    expect((await db.case.findUnique({ where: { caseRef: livingRef } }))?.phone).toBe(
      "+971501140021",
    );

    for (const caseRef of [goneRef, orphanRef]) {
      const row = await db.case.findUnique({ where: { caseRef } });
      // The row survives: `AuditLog` is append-only and names it, and a delete would
      // leave that evidence pointing at nothing. Only the readable number goes.
      expect(row).not.toBeNull();
      expect(row?.phone).toBeNull();
      expect(row?.phoneIndex).toBeNull();
      expect(row?.customerPhoneToken).toBeNull();
    }
    // Sealing is the other script's job; this one must leave the vault empty.
    expect(await db.pIIVault.count({ where: { orgId: gone } })).toBe(0);
  });

  test("a cleared row answers to neither arm of the case lookup", async () => {
    const gone = newOrg();
    const phone = "+971501140031";
    const caseRef = await legacyCase(gone, phone);
    clearReport(runClear(["--apply", "--ref-prefix", RUN]).stdout);

    // `phoneIndex` is unwritten and `phone` is null, so an inbound reply naming this
    // number finds no case — correct for a value that was never a customer's.
    const hits = await db.case.findMany({
      where: casePhoneWhere(phone),
      select: { caseRef: true },
    });
    expect(hits.map((h) => h.caseRef)).not.toContain(caseRef);
  });

  test("a non-uuid orgId cannot name a uuid tenant, so it is cleared not refused", async () => {
    // The production shape: `organization.id` is uuid while `Case.orgId` is text, and
    // the load/isolation suites write ids like `org-load-…` and `credits_…`. Such a
    // row belongs in the clear queue, and must not break the tenant lookup.
    const ref = await legacyCase(`org-load-${randomUUID().slice(0, 8)}`, "+971501140051");
    const parsed = clearReport(runClear(["--apply", "--ref-prefix", RUN]).stdout);
    expect(parsed.contended).toBe(0);
    const row = await db.case.findUnique({ where: { caseRef: ref } });
    expect(row?.phone).toBeNull();
    expect(row?.orgId).toContain("org-load-");
  });

  test("a second run clears nothing it has already cleared", async () => {
    const gone = newOrg();
    await legacyCase(gone, "+971501140041");
    const first = clearReport(runClear(["--apply", "--ref-prefix", RUN]).stdout);
    expect(first.scanned).toBeGreaterThanOrEqual(1);

    const again = clearReport(runClear(["--apply", "--ref-prefix", RUN]).stdout);
    // The queue is "rows that still hold a number for a tenant that cannot own it".
    expect(again.clearedNoOrg + again.clearedNoOrgRow).toBe(0);
    expect(again.contended).toBe(0);
  });
});
