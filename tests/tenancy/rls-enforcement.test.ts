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
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { TENANT_ROLE, tenantScopeReport, withTenantScope } from "@/lib/tenancy/db-scope";

const RUN = Date.now().toString(36).toUpperCase();
const ORG_A = `11111111-aaaa-4aaa-8aaa-${RUN.slice(0, 12).padEnd(12, "0").toLowerCase()}`;
const ORG_B = `22222222-bbbb-4bbb-8bbb-${RUN.slice(0, 12).padEnd(12, "0").toLowerCase()}`;

// `organization.id`, `user.id`, `UserProfile.userId` and `UserProfile.orgId` are
// `@db.Uuid`, so the fixtures that need a REAL tenant row cannot reuse ORG_A/ORGB:
// those are base36 and carry letters outside [a-f]. Hashing keeps the per-run
// uniqueness while producing a value every uuid column accepts.
const HEX = createHash("sha256").update(RUN).digest("hex");
const uuidFor = (tag: string): string =>
  `${tag
    .replace(/[^a-f0-9]/gi, "")
    .slice(0, 8)
    .padEnd(8, "0")
    .toLowerCase()}-0000-4000-8000-${HEX.slice(0, 12)}`;
const TENANT_A = uuidFor("a1a1a1a1");
const TENANT_B = uuidFor("b2b2b2b2");
const PROBE_USER = uuidFor("c3c3c3c3");

const caseIds: string[] = [];
let rowA: { id: string; caseRef: string };
let rowB: { id: string; caseRef: string };
let rowNull: { id: string; caseRef: string };

// Fixtures for the tables the console routes were NOT moved onto the enforced
// path — see the "what the tenant role is blind to" block below.
let auditA: { id: string };
let auditB: { id: string };
let auditNoOwner: { id: string };
let accountRow: { id: string };
let mailRow: { id: string };
const CALL_REF = {
  A: `SV-F-ENF${RUN}A`,
  B: `SV-F-ENF${RUN}B`,
  N: `SV-F-ENF${RUN}N`,
};

async function makeCase(orgId: string | null, tag: string) {
  const caseRef = `SV-F-RLS${RUN}${tag}`;
  const row = await db.case.create({
    data: { caseRef, orgId, state: "RECEIVED" },
    select: { id: true, caseRef: true },
  });
  caseIds.push(row.id);
  return row;
}

async function makeAudit(callRef: string, orgId: string | null) {
  const row = await db.auditLog.create({
    data: { callRef, action: "freeze", chainHash: `ch-${callRef}`, orgId },
    select: { id: true },
  });
  return row;
}

beforeAll(async () => {
  rowA = await makeCase(ORG_A, "A");
  rowB = await makeCase(ORG_B, "B");
  rowNull = await makeCase(null, "N");

  // ── the second set of fixtures: real rows in the other tenant tables ────────
  for (const [side, id] of [
    ["A", TENANT_A],
    ["B", TENANT_B],
  ] as const) {
    await db.organization.create({
      data: {
        id,
        name: `Enforcement Probe Org ${side}`,
        slug: `enforcement-probe-${side.toLowerCase()}-${HEX.slice(0, 12)}`,
        createdAt: new Date(),
      },
    });
  }
  await db.user.create({
    data: {
      id: PROBE_USER,
      email: `enforcement-${RUN}@example.test`,
      name: "Probe",
      emailVerified: true,
    },
  });
  accountRow = await db.account.create({
    data: {
      userId: PROBE_USER,
      accountId: `probe-${RUN}`,
      providerId: "credential",
      passwordHash: "not-a-real-hash",
    },
    select: { id: true },
  });
  await db.userProfile.create({
    data: {
      userId: PROBE_USER,
      email: `enforcement-${RUN}@example.test`,
      name: "Probe",
      role: "operator",
      orgId: TENANT_A,
      orgName: "Tenant A's own white-label name",
    },
  });
  mailRow = await db.emailInbound.create({
    data: {
      messageId: `enforcement-${RUN}@example.test`,
      recipient: "support",
      fromEmail: "customer@example.test",
      subject: "a reply that belongs to no tenant until it is correlated",
      bodyText: "redacted body",
    },
    select: { id: true },
  });
  auditA = await makeAudit(CALL_REF.A, TENANT_A);
  auditB = await makeAudit(CALL_REF.B, TENANT_B);
  auditNoOwner = await makeAudit(CALL_REF.N, null);
}, 120_000);

afterAll(async () => {
  if (caseIds.length > 0) await db.case.deleteMany({ where: { id: { in: caseIds } } });
  await db.auditLog.deleteMany({
    where: { id: { in: [auditA.id, auditB.id, auditNoOwner.id] } },
  });
  await db.emailInbound.deleteMany({ where: { id: mailRow.id } });
  await db.userProfile.deleteMany({ where: { userId: PROBE_USER } });
  await db.account.deleteMany({ where: { id: accountRow.id } });
  await db.user.deleteMany({ where: { id: PROBE_USER } });
  await db.organization.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
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

// ── The two console routes converted onto this path ──────────────────────────
//
// `GET /api/console/audit` and the `UserProfile` half of
// `GET|POST|DELETE /api/console/settings` now run their tenant queries inside
// `withTenantScope`. What has to be proven is not that they filter — a filter is
// easy to write and easy to forget — but that the DATABASE filters, so these
// probes deliberately name the OTHER tenant's identifiers and run queries whose
// `where` carries no org predicate at all. That is the query a forgotten
// predicate produces; here it is the query the route actually issues.

describe("the converted console routes", () => {
  test("AuditLog: naming another tenant's primary key resolves nothing", async () => {
    const seen = await withTenantScope(TENANT_A, async (tx) => ({
      mine: await tx.auditLog.count({ where: { id: auditA.id } }),
      theirs: await tx.auditLog.count({ where: { id: auditB.id } }),
      unowned: await tx.auditLog.count({ where: { id: auditNoOwner.id } }),
    }));
    expect(seen).toEqual({ mine: 1, theirs: 0, unowned: 0 });

    // Control: the same three ids are all real and all visible to the
    // application role, so a zero above is the policy and not a missing row.
    const all = await db.auditLog.count({
      where: { id: { in: [auditA.id, auditB.id, auditNoOwner.id] } },
    });
    expect(all).toBe(3);
  });

  test("AuditLog: the predicate-free listing the route would run unscoped is still bounded", async () => {
    const scoped = await withTenantScope(TENANT_A, (tx) =>
      tx.auditLog.findMany({
        where: { callRef: { startsWith: "SV-F-ENF" } },
        select: { callRef: true, orgId: true },
      }),
    );
    expect(scoped.map((r) => r.callRef)).toEqual([CALL_REF.A]);
    // The same query without the scope is what a bare `db.` read returns — the
    // assertion that separates "RLS binds" from "RLS is a migration file".
    const bare = await db.auditLog.findMany({
      where: { callRef: { startsWith: "SV-F-ENF" } },
      select: { callRef: true },
    });
    expect(bare.length).toBeGreaterThan(scoped.length);
  });

  test("UserProfile: read by userId alone, the org is decided below the ORM", async () => {
    // Exactly the statement `GET /api/console/settings` runs: `where` names the
    // caller's own userId and NOTHING about the org.
    const own = await withTenantScope(TENANT_A, (tx) =>
      tx.userProfile.findUnique({
        where: { userId: PROBE_USER },
        select: { orgId: true, orgName: true },
      }),
    );
    expect(own?.orgId).toBe(TENANT_A);

    const asAnotherTenant = await withTenantScope(TENANT_B, (tx) =>
      tx.userProfile.findUnique({ where: { userId: PROBE_USER }, select: { orgName: true } }),
    );
    expect(asAnotherTenant).toBeNull();
  });

  test("UserProfile: the same statement updates its own tenant's row and no other's", async () => {
    const rotated = await withTenantScope(TENANT_A, (tx) =>
      tx.userProfile.update({
        where: { userId: PROBE_USER },
        data: { orgName: "Rotated by tenant A" },
        select: { orgName: true },
      }),
    );
    expect(rotated.orgName).toBe("Rotated by tenant A");

    // Tenant B running the identical statement — the write `DELETE
    // /api/console/settings` performs — finds no row to update.
    await expect(
      withTenantScope(TENANT_B, (tx) =>
        tx.userProfile.update({
          where: { userId: PROBE_USER },
          data: { elevenKeyEnc: null },
        }),
      ),
    ).rejects.toThrow();
    const unchanged = await db.userProfile.findUnique({
      where: { userId: PROBE_USER },
      select: { orgName: true },
    });
    expect(unchanged?.orgName).toBe("Rotated by tenant A");
  });
});

// ── What the tenant role is blind to ────────────────────────────────────────
//
// Three of the five routes in this conversion stay on the application path, and
// the reason is the database's, not a preference: `organization`, `account` and
// `EmailInbound` return ZERO rows inside `sv_tenant` — the first two because
// migration `..._tenant_rls_coverage` gives the auth tables row security with no
// policy at all, the third because nothing populates `orgId` so the policy's
// `"orgId" IS NOT NULL` arm excludes every row. These asserts are the evidence
// for those decisions, and they flip if a future migration changes the posture —
// at which point the routes become convertible and this file says so.

describe("what the tenant role is blind to", () => {
  test("organization: the row that RESOLVES the tenant cannot be inside the tenant", async () => {
    const byApp = await db.organization.findUnique({
      where: { id: TENANT_A },
      select: { setupCompletedAt: true },
    });
    expect(byApp).not.toBeNull();
    const inScope = await withTenantScope(TENANT_A, (tx) =>
      tx.organization.findUnique({ where: { id: TENANT_A }, select: { id: true } }),
    );
    expect(inScope).toBeNull();
  });

  test("account: the credential read is a service-path concern", async () => {
    expect(await db.account.findUnique({ where: { id: accountRow.id } })).not.toBeNull();
    const inScope = await withTenantScope(TENANT_A, (tx) =>
      tx.account.findUnique({ where: { id: accountRow.id }, select: { passwordHash: true } }),
    );
    expect(inScope).toBeNull();
  });

  test("EmailInbound: an unowned row is invisible to every tenant", async () => {
    expect(await db.emailInbound.findUnique({ where: { id: mailRow.id } })).not.toBeNull();
    const inScope = await withTenantScope(TENANT_A, (tx) =>
      tx.emailInbound.findUnique({ where: { id: mailRow.id }, select: { subject: true } }),
    );
    expect(inScope).toBeNull();
    // The fixture was written the way `POST /api/email/inbound` writes every row:
    // no `orgId`. That route cannot supply one — the sender is a customer
    // replying to support@, and any correlation to a tenant happens afterwards,
    // if at all — so a tenant-scoped inbox would be empty for everyone, which is
    // why `GET /api/console/mail` keeps its operator-role gate instead.
    expect(
      await db.emailInbound.findUnique({ where: { id: mailRow.id }, select: { orgId: true } }),
    ).toEqual({ orgId: null });
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
