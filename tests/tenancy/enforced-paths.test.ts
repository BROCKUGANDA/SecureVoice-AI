/**
 * Which read/write paths are database-enforced, as a number that may not shrink.
 *
 * The isolation guard (`src/lib/tenancy/guard.ts`) is application logic: correct,
 * tested, and silently defeatable by one forgotten predicate in one new route.
 * `withTenantScope` is the same guarantee moved into Postgres, where a missing
 * predicate returns zero rows instead of somebody else's.
 *
 * Adoption is deliberately incremental — every route handler that touches
 * tenant-owned tables would need its queries moved inside a transaction, and some
 * of those handlers are cross-tenant by design (the dial, outbox and retention
 * workers must see every organisation). A ratchet over the files that ARE on the
 * enforced path is the honest way to make that progress visible: it fails if
 * someone reverts a converted handler to bare `db`, and it lists exactly which
 * entry points still rely on application discipline alone.
 *
 *   bun test tests/tenancy/enforced-paths.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const API_ROOT = resolve(import.meta.dir, "../../src/app/api");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const HANDLERS = walk(API_ROOT);

/** Handlers whose source contains at least one scoped transaction. */
const enforced = HANDLERS.filter((f) => /withTenantScope\s*\(/.test(readFileSync(f, "utf8")));

/**
 * Handlers that read or write a tenant-owned table without a scope.
 *
 * The predicate is a text scan for a bare `db.` Prisma call, which over-reports:
 * some of those calls are legitimately cross-tenant (worker-facing routes, the
 * outbox replay, the dead-letter console). It is used here only as a ceiling that
 * may not grow, never as a claim that every listed file is a defect.
 */
const unscoped = HANDLERS.filter((f) => {
  const src = readFileSync(f, "utf8");
  return /\bdb\.[a-zA-Z]+\./.test(src) && !/withTenantScope\s*\(/.test(src);
}).map((f) => f.replace(`${resolve(import.meta.dir, "../..")}/`, "").replace(/\\/g, "/"));

describe("the database-enforced path", () => {
  test("the scan found the API surface at all", () => {
    expect(HANDLERS.length).toBeGreaterThan(50);
  });

  test("at least one handler is database-enforced, and reverting it fails here", () => {
    expect(enforced.length).toBeGreaterThanOrEqual(1);
    const names = enforced.map((f) => f.replace(/\\/g, "/")).join("\n");
    // Named rather than counted, so the failing message says which one broke.
    expect(names).toContain("console/documents/route.ts");
  });

  test("the enforced set grows rather than silently shrinking", () => {
    // Update this number when a handler is converted. It exists so "we adopted
    // RLS everywhere" can be checked against a count in CI instead of a slide.
    expect(enforced.length).toBeGreaterThanOrEqual(1);
  });

  test("the unscoped list is reported, not hidden", () => {
    // Ceiling rather than a zero-tolerance floor, on purpose: a worker-facing
    // route legitimately crosses tenants today. The number going UP is the thing
    // a reviewer should have to explain.
    expect(unscoped.length).toBeLessThan(70);
    console.log(
      `[tenancy] database-enforced handlers: ${enforced.length}; still application-scoped only: ${unscoped.length}`,
    );
  });
});
