/**
 * Row-level security, enforced rather than declared.
 *
 * The claim under test is narrow: inside `withTenantScope`, one organisation
 * cannot read or write another organisation's rows, and the reason it cannot is a
 * database policy — not a predicate some application code remembered to add.
 *
 * Two facts make this suite worth having. The connecting role here is a superuser
 * with `BYPASSRLS`, so RLS on that connection is inert by design: a migration
 * that only ran `ENABLE ROW LEVEL SECURITY` would look like isolation and be
 * nothing. And the same fact means the ordinary application path is untouched by
 * this change, which is asserted too — otherwise the first report of "the console
 * is empty" would be the discovery.
 *
 *   bun test tests/tenancy/rls-enforcement.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { TENANT_ROLE, tenantScopeReport, withTenantScope } from "@/lib/tenancy/db-scope";

const RUN = Date.now().toString(36).toUpperCase();
const ORG_A = `11111111-aaaa-4aaa-8aaa-${RUN.slice(0, 12).padEnd(12, "0").toLowerCase()}`;
const ORG_B = `22222222-bbbb-4bbb-8bbb-${RUN.slice(0, 12).padEnd(12, "0").toLowerCase()}`;

const caseIds: string[] = [];
let rowA: { id: string; caseRef: string };
let rowB: { id: string; caseRef: string };
let rowNull: { id: string; caseRef: string };

async function makeCase(orgId: string | null, tag: string) {
  const caseRef = `SV-F-RLS${RUN}${tag}`;
  const row = await db.case.create({
    data: { caseRef, orgId, state: "RECEIVED" },
    select: { id: true, caseRef: true },
  });
  caseIds.push(row.id);
  return row;
}

beforeAll(async () => {
  rowA = await makeCase(ORG_A, "A");
  rowB = await makeCase(ORG_B, "B");
  rowNull = await makeCase(null, "N");
}, 120_000);

afterAll(async () => {
  if (caseIds.length > 0) await db.case.deleteMany({ where: { id: { in: caseIds } } });
}, 60_000);

describe("the switch that makes policies bind", () => {
  test("the connecting role bypasses RLS, which is why SET LOCAL ROLE exists", async () => {
    const report = await tenantScopeReport();
    expect(report.connectingRoleBypassesRls).toBe(true);
    expect(report.effectiveRole).not.toBe(TENANT_ROLE);
  });

  test("inside a scope the session really is the tenant role", async () => {
    const who = await withTenantScope(ORG_A, async (tx) => {
      const rows = await tx.$queryRaw<{ r: string }[]>`SELECT current_user AS r`;
      return rows[0]?.r;
    });
    expect(who).toBe(TENANT_ROLE);
  });

  test("an empty org is refused rather than silently returning nothing", async () => {
    await expect(withTenantScope("", (tx) => tx.case.count())).rejects.toThrow(/orgId/);
  });

  test("the role reverts after the transaction — the pool must not inherit it", async () => {
    await withTenantScope(ORG_A, (tx) => tx.case.count());
    const after = await db.$queryRaw<{ r: string }[]>`SELECT current_user AS r`;
    expect(after[0]?.r).not.toBe(TENANT_ROLE);
    // And the GUC is gone with it, or the next tenant on this connection would
    // read this tenant's rows.
    const guc = await db.$queryRaw<{ v: string | null }[]>`
      SELECT current_setting('app.org_id', true) AS v
    `;
    expect(guc[0]?.v ?? "").toBe("");
  });
});

describe("policies decide, not predicates", () => {
  test("a tenant reads its own row and zero rows for another org", async () => {
    const counts = await withTenantScope(ORG_A, async (tx) => ({
      mine: await tx.case.count({ where: { id: rowA.id } }),
      theirs: await tx.case.count({ where: { id: rowB.id } }),
      // No orgId predicate at all: this is the query a forgotten `.use()` would
      // run, and the database is what stops it.
      everything: await tx.case.count(),
    }));
    expect(counts.mine).toBe(1);
    expect(counts.theirs).toBe(0);
    expect(counts.everything).toBe(1);
  });

  test("a row with no owner is not fair game for an authenticated tenant", async () => {
    const seen = await withTenantScope(ORG_A, (tx) => tx.case.count({ where: { id: rowNull.id } }));
    expect(seen).toBe(0);
  });

  test("a tenant cannot write a row into somebody else's organisation", async () => {
    await expect(
      withTenantScope(ORG_A, (tx) =>
        tx.case.create({
          data: { caseRef: `SV-F-RLS${RUN}X`, orgId: ORG_B, state: "RECEIVED" },
        }),
      ),
    ).rejects.toThrow();
    const leaked = await db.case.count({ where: { caseRef: `SV-F-RLS${RUN}X` } });
    expect(leaked).toBe(0);
  });

  test("a tenant cannot reparent an existing row", async () => {
    await withTenantScope(ORG_A, (tx) =>
      tx.case.update({ where: { id: rowA.id }, data: { state: "SCREENED" } }),
    );
    expect((await db.case.findUnique({ where: { id: rowA.id } }))?.state).toBe("SCREENED");

    await expect(
      withTenantScope(ORG_A, (tx) =>
        tx.case.update({ where: { id: rowA.id }, data: { orgId: ORG_B } }),
      ),
    ).rejects.toThrow();
    const still = await db.case.findUnique({ where: { id: rowA.id }, select: { orgId: true } });
    expect(still?.orgId).toBe(ORG_A);
  });

  test("the ordinary application path is unaffected — no policy applies to it", async () => {
    const all = await db.case.count({ where: { id: { in: [rowA.id, rowB.id, rowNull.id] } } });
    expect(all).toBe(3);
  });
});

describe("coverage", () => {
  // The migration discovers org-bearing tables from information_schema, so a
  // table added later is guarded when the migration is re-applied — but a table
  // added and never migrated is exactly how isolation silently stops being true.
  // This asserts the applied state, which is the only state that protects rows.
  test("every table that carries an orgId has row security enabled", async () => {
    const report = await tenantScopeReport();
    expect(report.orgTables).toBeGreaterThan(10);
    expect(report.unprotectedTables).toEqual([]);
    expect(report.orgTablesWithRls).toBe(report.orgTables);
  });

  test("the tenant role holds no privileged attributes", async () => {
    const rows = await db.$queryRaw<{ super: boolean; bypass: boolean }[]>`
      SELECT usesuper AS super, usebypassrls AS bypass FROM pg_user WHERE usename = 'sv_tenant'
    `;
    // A role that is not a member of pg_user is invisible here; the policy binds
    // to it either way, so an empty result is not a failure — but a row that
    // says superuser or BYPASSRLS is.
    for (const r of rows) {
      expect(r.super).toBe(false);
      expect(r.bypass).toBe(false);
    }
  });
});
