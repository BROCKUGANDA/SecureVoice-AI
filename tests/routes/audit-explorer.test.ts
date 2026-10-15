/**
 * The audit EXPLORER read paths: `scope=rows` and `scope=integrity`.
 *
 * These are NEW read surfaces on `GET /api/console/audit`, and a new read surface
 * is exactly where a tenant leak goes unnoticed — the original two shapes are
 * covered by tests/tenancy/console-routes.test.ts, so nothing else would exercise
 * these, and the `scope` parameter is caller-supplied, so it is exactly the kind
 * of input that widens a query by accident.
 *
 * What is asserted, and what each one prevents:
 *
 *  · TENANT SCOPE on both new scopes, and it is worth being precise about WHICH
 *    layer is doing the work. Removing the org predicate from the `where` entirely
 *    does NOT make these tests fail: the rows are read inside `withTenantScope`,
 *    so the row-level policy on `AuditLog` (`9zzzzzzzzzzzzzzzzzzzzzz_tenant_rls`)
 *    decides what the query can reach regardless of the predicate's shape. That is
 *    the intended architecture — the database is the control, the `where` states
 *    intent — so these tests assert that the ENDPOINT does not leak, not that one
 *    clause of the query is individually load-bearing. tests/tenancy/
 *    enforced-paths.test.ts is what pins the `withTenantScope` call itself.
 *
 *    Both layers are present anyway. Defence in depth is not redundancy to remove
 *    once the database is trusted; a future refactor that moves this read off the
 *    scoped path is caught by the predicate, and one that keeps the path but drops
 *    the predicate is caught by the policy.
 *  · Filter values are caller-supplied and must narrow, never widen.
 *  · `limit` is CLAMPED. An unbounded page size is a denial of service, and the
 *    clamp is the only thing standing between a browser and the whole table.
 *  · Pagination does not repeat or skip a row across a page boundary. The chain
 *    walk exists because two rows can share a timestamp, so `id` is the tie-break
 *    and this is what proves it.
 *  · `complete: false` is reported rather than implied. An integrity check that
 *    hit its cap and answered "verified" would be worse than no check at all.
 */

import { afterAll, beforeEach, expect, test, mock } from "bun:test";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import * as realCredits from "@/lib/credits";

const RUN = Date.now().toString(36);
const RUN_HEX = createHash("sha256").update(RUN).digest("hex");
const uuidFor = (tag: string): string =>
  `${tag
    .replace(/[^a-f0-9]/gi, "")
    .slice(0, 8)
    .padEnd(8, "0")
    .toLowerCase()}-0000-4000-8000-${RUN_HEX.slice(0, 12)}`;
const USER_A = uuidFor("aaaaaaaa");
const USER_B = uuidFor("bbbbbbbb");
const ORG_A = uuidFor("0a0a0a0a");
const ORG_B = uuidFor("0b0b0b0b");

/** Which org the mocked session reports. Flipped per test. Same seam as
 *  tests/tenancy/console-routes.test.ts — `getProfile`, not the identity provider,
 *  so the real route logic and the real scoping are what run. */
const session = { orgId: ORG_A as string | null, userId: USER_A };
mock.module("@/lib/credits", () => ({
  ...realCredits,
  getProfile: async () =>
    session.orgId
      ? {
          userId: session.userId,
          email: `${session.userId}@securevoice.ae`,
          name: "Audit Explorer",
          role: "operator" as const,
          orgId: session.orgId,
          credits: 500,
        }
      : null,
}));
function asOrgA(): void {
  session.orgId = ORG_A;
  session.userId = USER_A;
}
function asOrgB(): void {
  session.orgId = ORG_B;
  session.userId = USER_B;
}

const REF_A = `SV-EXPLORER-A-${RUN}`;
const REF_B = `SV-EXPLORER-B-${RUN}`;
const MARKER_A = `marker-tenant-a-${RUN}`;
const MARKER_B = `marker-tenant-b-${RUN}`;

/** Seed one audit row directly. `append()` would re-hash and is not what is under test. */
async function seed(callRef: string, orgId: string, action: string, text: string) {
  return db.auditLog.create({
    data: {
      callRef,
      orgId,
      action,
      intent: action,
      redactedText: text,
      callerId: "seed",
      chainHash: `${callRef}${action}${text}`.padEnd(64, "0").slice(0, 64),
      prevHash: null,
    },
    select: { id: true, callRef: true },
  });
}

async function callAs(url: string) {
  // Imported inside the call so the mock above is registered first.
  const { GET } = await import("@/app/api/console/audit/route");
  const res = await GET(new NextRequest(url));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let seeded: Promise<unknown> | null = null;
function ensureSeeded() {
  seeded ??= (async () => {
    // Both orgs get rows with the SAME action name, so a filter that widens scope
    // rather than narrowing it matches org B's row and is caught rather than
    // passing because the fixture happened to differ.
    await seed(REF_A, ORG_A, "freeze", `${MARKER_A} first row`);
    await seed(REF_A, ORG_A, "handoff", `${MARKER_A} second row`);
    await seed(REF_A, ORG_A, "freeze", `${MARKER_A} third row`);
    await seed(REF_B, ORG_B, "freeze", `${MARKER_B} only row`);
  })();
  return seeded;
}

/**
 * Reset the session to org A before every test.
 *
 * A shared mutable session is the harness's shape, so a test that flipped it to
 * org B and did not flip it back would silently change what the NEXT test proves.
 * Defaulting here means each test states only the org it deliberately leaves.
 */
beforeEach(() => {
  asOrgA();
});

afterAll(async () => {
  await ensureSeeded();
  await db.auditLog.deleteMany({ where: { callRef: { in: [REF_A, REF_B] } } }).catch(() => undefined);
});

type Row = { id: string; callRef: string; action: string; redactedText: string | null };
type RowsBody = {
  rows: Row[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
};

// ── scope=rows ────────────────────────────────────────────────────────────────

test("scope=rows returns only the caller's own rows", async () => {
  await ensureSeeded();
  const { status, body } = await callAs("http://localhost/api/console/audit?scope=rows");
  expect(status).toBe(200);
  const b = body as unknown as RowsBody;

  expect(b.rows.length).toBeGreaterThan(0);
  // The row that EXISTS and belongs to org B is the one that matters.
  expect(b.rows.map((r) => r.callRef)).toContain(REF_A);
  expect(b.rows.map((r) => r.callRef)).not.toContain(REF_B);
  expect(JSON.stringify(b)).not.toContain(MARKER_B);
});

test("a filter value narrows rather than widens", async () => {
  await ensureSeeded();
  // Both orgs seeded a row with action "freeze", so a filter that WIDENED instead
  // of narrowing would match org B's row rather than nothing.
  asOrgA();
  const { body } = await callAs("http://localhost/api/console/audit?scope=rows&action=freeze");
  const b = body as unknown as RowsBody;
  expect(JSON.stringify(b)).not.toContain(REF_B);
  expect(JSON.stringify(b)).not.toContain(MARKER_B);
  // The control that keeps this a real test: the filter DOES narrow within the
  // caller's own rows. Without it, "nothing matched" would pass identically.
  expect(b.rows.every((r) => r.action === "freeze")).toBe(true);
  expect(b.rows.length).toBeGreaterThan(0);
});

test("free-text search matches the caller's own transcript only", async () => {
  await ensureSeeded();
  const mine = await callAs(`http://localhost/api/console/audit?scope=rows&q=${MARKER_A}`);
  expect((mine.body as unknown as RowsBody).rows.length).toBeGreaterThan(0);

  // The same needle against org B's marker must return nothing to org A.
  const foreign = await callAs(`http://localhost/api/console/audit?scope=rows&q=${MARKER_B}`);
  expect((foreign.body as unknown as RowsBody).rows.length).toBe(0);
}, 60_000);

test("limit is clamped, so one request cannot ask for the whole table", async () => {
  await ensureSeeded();
  asOrgA();
  const { body } = await callAs("http://localhost/api/console/audit?scope=rows&limit=1000000");
  const b = body as unknown as RowsBody;
  expect(b.limit).toBeLessThanOrEqual(200);
  expect(b.rows.length).toBeLessThanOrEqual(200);
});

test("a negative limit falls back to the default rather than erroring or going unbounded", async () => {
  await ensureSeeded();
  const { status, body } = await callAs("http://localhost/api/console/audit?scope=rows&limit=-5");
  expect(status).toBe(200);
  const b = body as unknown as RowsBody;
  expect(b.limit).toBeGreaterThan(0);
  expect(b.limit).toBeLessThanOrEqual(200);
});

test("pagination neither repeats nor skips a row", async () => {
  await ensureSeeded();
  const first = (await callAs("http://localhost/api/console/audit?scope=rows&limit=1")).body as unknown as RowsBody;
  const second = (await callAs(`http://localhost/api/console/audit?scope=rows&limit=1&offset=${first.nextOffset}`)).body as unknown as RowsBody;

  expect(first.rows).toHaveLength(1);
  expect(second.rows).toHaveLength(1);
  // The tie-break assertion: page 2 is not page 1 again. `toHaveLength` above is
  // what makes these indexed accesses safe; `!` would defeat the point of running
  // the stricter tests tsconfig against this file.
  expect(second.rows[0]!.id).not.toBe(first.rows[0]!.id);
  expect(first.hasMore).toBe(true);
  expect(first.nextOffset).toBe(1);
});

test("org B sees the mirror image of the same query", async () => {
  await ensureSeeded();
  asOrgB();
  const { status, body } = await callAs("http://localhost/api/console/audit?scope=rows");
  expect(status).toBe(200);
  const b = body as unknown as RowsBody;

  // Symmetric to the org A case above: same query, opposite tenant, opposite rows.
  // A scope predicate applied one way but not the other passes a one-sided test.
  expect(b.rows.map((r) => r.callRef)).toContain(REF_B);
  expect(b.rows.map((r) => r.callRef)).not.toContain(REF_A);
  expect(JSON.stringify(b)).not.toContain(MARKER_A);
}, 60_000);

// ── scope=integrity ───────────────────────────────────────────────────────────

test("scope=integrity reports chains, and never reaches another tenant's", async () => {
  await ensureSeeded();
  const { status, body } = await callAs("http://localhost/api/console/audit?scope=integrity");
  expect(status).toBe(200);
  const b = body as { chainsChecked: number; verified: number; totalRows: number; broken: unknown };

  expect(b.chainsChecked).toBeGreaterThan(0);
  expect(typeof b.verified).toBe("number");
  expect(b.totalRows).toBeGreaterThan(0);
  // Org B's chain is not counted, and its reference never appears in the payload.
  expect(JSON.stringify(body)).not.toContain(REF_B);
}, 60_000);

test("integrity reports completeness instead of implying full coverage", async () => {
  await ensureSeeded();
  const { body } = await callAs("http://localhost/api/console/audit?scope=integrity");
  // `complete` is what distinguishes "every chain checked" from "the cap was hit".
  // The flag has to EXIST and be a boolean, whatever its value here.
  expect(typeof (body as { complete: unknown }).complete).toBe("boolean");
}, 60_000);

// ── the original shapes must not have moved ───────────────────────────────────

test("the default and callRef shapes are unchanged", async () => {
  await ensureSeeded();
  const list = await callAs("http://localhost/api/console/audit");
  expect(list.status).toBe(200);
  expect(Array.isArray((list.body as { cases: unknown[] }).cases)).toBe(true);

  const walk = await callAs(`http://localhost/api/console/audit?callRef=${REF_A}`);
  expect(walk.status).toBe(200);
  expect((walk.body as { verification: unknown }).verification).toBeDefined();
}, 60_000);
