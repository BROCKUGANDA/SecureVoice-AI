/**
 * Which read/write paths are database-enforced, as a number that may not shrink.
 *
 * The isolation guard (`src/lib/tenancy/guard.ts`) is application logic: correct,
 * tested, and silently defeatable by one forgotten predicate in one new route.
 * `withTenantScope` (src/lib/tenancy/db-scope.ts) is the same guarantee moved into
 * Postgres, where a missing predicate returns zero rows instead of somebody else's.
 *
 * Adoption is deliberately incremental — every route handler that touches
 * tenant-owned tables would need its queries moved inside a transaction, and some
 * of those handlers are cross-tenant by design (the dial, outbox and retention
 * workers must see every organisation). A ratchet over the files that ARE on the
 * enforced path is the honest way to make that progress visible: it fails if
 * someone reverts a converted handler to bare `db`, and it lists exactly which
 * entry points still rely on application discipline alone.
 *
 * Three properties this file has to keep:
 *
 *   1. IT CAN FAIL. Every gate here is named per file, and the detectors that do
 *      the naming are themselves exercised against synthetic strings — a scan that
 *      matches nothing would otherwise pass quietly.
 *   2. IT MAY NOT SHRINK. The enforced set has a named floor; reverting any one of
 *      those handlers turns this suite red and says which file broke.
 *   3. IT MAY NOT GROW. The unscoped list has a ceiling, so a new bare-`db` tenant
 *      read has to be argued for rather than merged.
 *
 *   bun test tests/tenancy/enforced-paths.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const API_ROOT = resolve(REPO, "src/app/api");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const HANDLERS = walk(API_ROOT);

/** Repo-relative, forward-slashed, so a name reads the same on every platform. */
const rel = (f: string) => relative(REPO, f).replace(/\\/g, "/");

const src = (f: string) => readFileSync(f, "utf8");

/** `statSync` on a path that a concurrent edit removed is not a test failure type. */
function exists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Handlers whose source contains at least one scoped transaction. */
const SCOPED_CALL = /withTenantScope\s*\(/;
const enforced = HANDLERS.filter((f) => SCOPED_CALL.test(src(f))).map(rel);

/**
 * The files that MUST stay on the database-enforced path, and the tenant delegate
 * each one brings inside the scope. Named rather than counted, because a count is
 * a number and a name is a diagnosis.
 */
const ENFORCED_CONTRACTS: { file: string; delegates: string[] }[] = [
  { file: "src/app/api/console/documents/route.ts", delegates: ["document"] },
  { file: "src/app/api/auth/export/route.ts", delegates: ["case"] },
  { file: "src/app/api/console/audit/route.ts", delegates: ["auditLog"] },
  { file: "src/app/api/console/settings/route.ts", delegates: ["userProfile"] },
];

/**
 * Tenant-owned Prisma delegates — `TENANTED_MODELS` in src/lib/tenancy/guard.ts
 * plus `Document`, which carries a non-nullable `orgId` and is the table the
 * already-converted knowledge-base route scopes by.
 */
const TENANT_DELEGATES = [
  "case",
  "auditLog",
  "customer",
  "producerKey",
  "userProfile",
  "notification",
  "outboxEvent",
  "usageLedger",
  "paymentRecord",
  "paddleCustomer",
  "paddleSubscription",
  "document",
];

/** A tenant table reached with no scope of any kind: the hole this ratchet closes. */
function bareTenantCalls(file: string): string[] {
  const text = src(file);
  return TENANT_DELEGATES.filter((d) => new RegExp(`\\bdb\\.${d}\\.`).test(text));
}

/**
 * Handlers that read or write a tenant-owned table without a scope.
 *
 * The predicate is a text scan for a bare `db.` Prisma call, which over-reports:
 * some of those calls are legitimately cross-tenant (worker-facing routes, the
 * outbox replay, the dead-letter console) or touch a table that carries no
 * `orgId` at all. It is used here only as a ceiling that may not grow, never as a
 * claim that every listed file is a defect.
 */
const unscoped = HANDLERS.filter(
  (f) => /\bdb\.[a-zA-Z]+\./.test(src(f)) && !SCOPED_CALL.test(src(f)),
)
  .map(rel)
  .sort();

/**
 * The routes in this conversion's scope that are NOT convertible, and the marker
 * text of the decision each one carries. They stay on the application client
 * because the tenant role cannot see their tables at all — `organization` and
 * `account` are given row security with NO policy by
 * `9zzzzzzzzzzzzzzzzzzzzzzz_tenant_rls_coverage`, and `EmailInbound` rows are
 * written without an `orgId`. Each reason is asserted live in
 * tests/tenancy/rls-enforcement.test.ts; here the gate is that the REASON STAYS
 * WRITTEN DOWN, so a future reader cannot mistake the omission for an oversight
 * (or "fix" it by wrapping a query that would then return nothing).
 */
const DOCUMENTED_REFUSALS: { file: string; says: string }[] = [
  { file: "src/app/api/console/me/route.ts", says: "database-enforced path" },
  { file: "src/app/api/console/mail/route.ts", says: "database-enforced path" },
  { file: "src/app/api/auth/step-up/route.ts", says: "database-enforced path" },
];

describe("the database-enforced path", () => {
  test("the scan found the API surface at all", () => {
    expect(HANDLERS.length).toBeGreaterThan(50);
  });

  test("the detectors detect — a gate that cannot fail is not a gate", () => {
    // Every check below is a string scan, so the scans are proved on synthetic
    // input first. Without this, a typo in a regex silently converts the whole
    // file from a gate into a comment.
    expect(SCOPED_CALL.test("await withTenantScope(orgId, (tx) => tx.case.count())")).toBe(true);
    expect(SCOPED_CALL.test("withTenantScope (x, fn)")).toBe(true);
    expect(SCOPED_CALL.test("withTenantScope")).toBe(false);
    expect(
      TENANT_DELEGATES.filter((d) => new RegExp(`\\bdb\\.${d}\\.`).test(`const r = db.${d}.x();`)),
    ).toHaveLength(TENANT_DELEGATES.length);
    // And a real file is classified the way a reader would classify it: the audit
    // route is scoped, the refusal routes are not.
    expect(SCOPED_CALL.test(src(resolve(REPO, "src/app/api/console/audit/route.ts")))).toBe(true);
    for (const r of DOCUMENTED_REFUSALS) {
      expect(SCOPED_CALL.test(src(resolve(REPO, r.file))), `${r.file} is not enforced`).toBe(false);
    }
  });

  test("each named handler is still on the database-enforced path", () => {
    const broken: string[] = [];
    for (const { file, delegates } of ENFORCED_CONTRACTS) {
      const abs = resolve(REPO, file);
      if (!exists(abs)) {
        broken.push(`${file}: file gone`);
        continue;
      }
      const text = src(abs);
      if (!SCOPED_CALL.test(text)) broken.push(`${file}: no withTenantScope() call`);
      if (!/from "@\/lib\/tenancy\/db-scope"/.test(text))
        broken.push(`${file}: does not import the enforcement module`);
      for (const d of delegates) {
        // The tenant table has to be reached THROUGH the transaction client…
        if (!new RegExp(`\\btx\\.${d}\\b`).test(text))
          broken.push(`${file}: ${d} is not touched inside the tenant scope`);
        // …and not beside it.
        if (new RegExp(`\\bdb\\.${d}\\.`).test(text))
          broken.push(`${file}: bare db.${d}. left the enforced path`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("the enforced set grows rather than silently shrinking", () => {
    expect(enforced.length).toBeGreaterThanOrEqual(ENFORCED_CONTRACTS.length);
    // Counted AND named: a count that still clears the floor while a file quietly
    // reverts is the failure this exists to catch.
    for (const { file } of ENFORCED_CONTRACTS) {
      expect(enforced, `${file} is no longer database-enforced`).toContain(file);
    }
  });

  test("the converted audit route left the unscoped list entirely", () => {
    // `console/audit` has no bare `db.` call left; if one comes back, the scan
    // notices before a reviewer has to.
    expect(unscoped).not.toContain("src/app/api/console/audit/route.ts");
  });

  test("the refusals are refusals with a reason, not gaps", () => {
    const missing: string[] = [];
    for (const { file, says } of DOCUMENTED_REFUSALS) {
      const abs = resolve(REPO, file);
      if (!exists(abs)) {
        missing.push(`${file}: file gone`);
        continue;
      }
      const text = src(abs);
      if (!text.includes(says)) missing.push(`${file}: no longer explains why it is unscoped`);
      // A refusal must not have quietly acquired a bare tenant-delegate read:
      // `organization` / `account` / `EmailInbound` are not tenant delegates, and
      // if one of these routes starts reading a real tenant table unscoped, that
      // is a different decision and belongs in `ENFORCED_CONTRACTS`.
      const bare = bareTenantCalls(abs);
      if (bare.length > 0) missing.push(`${file}: bare db.${bare.join("/")} with no scope`);
    }
    expect(missing).toEqual([]);
  });

  test("the unscoped list is reported, not hidden", () => {
    // Ceiling rather than a zero-tolerance floor, on purpose: a worker-facing
    // route legitimately crosses tenants today. Measured 24 after the conversion
    // of `console/audit` and `console/settings`; the bound stays at the 26 seen
    // BEFORE it, so concurrent work in the tree is not blamed for a number it did
    // not move — and growth past that is the thing a reviewer has to explain.
    //
    // IT IS NOW 28, and the two additions are named here because a number that
    // moves silently is the thing this ratchet exists to prevent:
    //
    //   · `console/pilot/approvals` — a human approves a dial. It reads
    //     `db.case` with an explicit `{ caseRef, orgId }` predicate, so it is
    //     scoped; the scan is a TEXT scan and cannot see a predicate written
    //     inline. It is the same shape as the other console routes that carry
    //     their own org clause.
    //   · `twilio/recording` — a carrier callback about a recording. It is
    //     worker-facing by construction: the carrier names a recording, not a
    //     tenant, and the row it resolves carries its own org.
    //
    // Anything past 28 has to be argued for, not assumed.
    expect(unscoped.length).toBeLessThanOrEqual(28);
    console.log(
      `[tenancy] database-enforced handlers: ${enforced.length} (${enforced.join(", ")}); still application-scoped only: ${unscoped.length}`,
    );
  });
});
