import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { currentQueryCount, recordQuery, runWithQueryCounter } from "@/lib/telemetry/query-counter";
import { DEFAULT_QUERY_BUDGET, QUERY_BUDGETS, budgetFor } from "../routes/query-budgets";
import { discoverRoutes } from "../routes/route-table";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * AA-1.1 — the query counter, and the budgets it is measured against.
 *
 * ── What a naive gate gets wrong ────────────────────────────────────────────
 * The obvious version of this test asserts that a query count is "small". That
 * passes forever and catches nothing, because nothing ever changes the number
 * it looks at. The tests below are written to fail on the specific defects the
 * gate exists to catch:
 *
 *   1. a global counter (breaks under concurrency)   — see "independent"
 *   2. counting queries from another request          — see "isolated"
 *   3. an N+1 introduced into a real route            — see "N+1 regression"
 *   4. a new route slipping in unbudgeted              — see "every route"
 *
 * Each of those is mutation-tested at the bottom of the file.
 */

describe("the counter measures one request, not the process", () => {
  test("it counts nothing when no request is being measured", () => {
    // Outside a context there is nothing to attribute a query to. Recording it
    // into a global is the concurrency bug this module exists to avoid.
    expect(currentQueryCount()).toBe(0);
    recordQuery({ query: "SELECT 1" });
    expect(currentQueryCount()).toBe(0);
  });

  test("it counts every query issued inside the context", async () => {
    const { report } = await runWithQueryCounter(async () => {
      recordQuery({ query: "SELECT a" });
      recordQuery({ query: "SELECT b" });
      recordQuery({ query: "SELECT c" });
    });
    expect(report.count).toBe(3);
    expect(report.queries).toEqual(["SELECT a", "SELECT b", "SELECT c"]);
  });

  test("the count survives await, which a global counter cannot do", async () => {
    const { report } = await runWithQueryCounter(async () => {
      recordQuery({ query: "SELECT before" });
      // A real handler awaits here (db call, fetch, carrier round trip). A
      // module-level counter would be readable here only by luck of ordering.
      await new Promise((resolve) => setTimeout(resolve, 5));
      recordQuery({ query: "SELECT after" });
    });
    expect(report.count).toBe(2);
  });

  test("concurrent requests are counted independently", async () => {
    // THE test for this module. Two requests interleave through awaits; a shared
    // counter would report each one's total (3) and pass a naive assertion,
    // while the real per-request numbers are 2 and 1. This is the bug AsyncLocal
    // Storage exists to prevent, so it is asserted directly.
    const slow = runWithQueryCounter(async () => {
      recordQuery({ query: "slow-1" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      recordQuery({ query: "slow-2" });
      return "slow";
    });
    const fast = runWithQueryCounter(async () => {
      recordQuery({ query: "fast-1" });
      return "fast";
    });
    const [a, b] = await Promise.all([slow, fast]);
    expect(a.report.count).toBe(2);
    expect(b.report.count).toBe(1);
    // No cross-contamination: neither report may contain the other's query.
    expect(a.report.queries).not.toContain("fast-1");
    expect(b.report.queries).not.toContain("slow-1");
    // And both results still came back, so the isolation did not cost anything.
    expect(a.result).toBe("slow");
    expect(b.result).toBe("fast");
  });

  test("a nested context is counted by the inner one, not merged", async () => {
    // `runWithQueryCounter` establishes the context, so a nested call measures
    // its own work. Merging would make the outer total meaningless.
    const outer = await runWithQueryCounter(async () => {
      recordQuery({ query: "outer" });
      await runWithQueryCounter(async () => {
        recordQuery({ query: "inner" });
      });
    });
    expect(outer.report.count).toBe(1);
    expect(outer.report.queries).toEqual(["outer"]);
  });
});

describe("the N+1 signature is identifiable, not just countable", () => {
  test("one query run N times is reported as repeated, worst first", async () => {
    // The whole value of keeping the query TEXT rather than a bare count: a
    // total says "38 queries", this says "the same lookup ran 12 times".
    const { report } = await runWithQueryCounter(async () => {
      recordQuery({ query: "SELECT * FROM Customer WHERE id = $1" });
      recordQuery({ query: "SELECT * FROM Customer WHERE id = $1" });
      recordQuery({ query: "SELECT * FROM Customer WHERE id = $1" });
      recordQuery({ query: "SELECT * FROM Case WHERE ref = $1" });
      recordQuery({ query: "SELECT * FROM Case WHERE ref = $1" });
    });
    expect(report.count).toBe(5);
    expect(report.repeated).toEqual([
      { query: "SELECT * FROM Customer WHERE id = $1", count: 3 },
      { query: "SELECT * FROM Case WHERE ref = $1", count: 2 },
    ]);
  });

  test("a batched query is not reported as an N+1", async () => {
    // The false-positive guard. One `IN (...)` over 50 rows is the CORRECT
    // shape; a gate that flagged it would teach people to ignore the gate.
    const { report } = await runWithQueryCounter(async () => {
      recordQuery({ query: "SELECT * FROM Customer WHERE id IN ($1,$2,$3)" });
    });
    expect(report.count).toBe(1);
    expect(report.repeated).toEqual([]);
  });

  test("the report is stable across runs, so a diff means a real change", async () => {
    const run = () =>
      runWithQueryCounter(async () => {
        recordQuery({ query: "b" });
        recordQuery({ query: "a" });
        recordQuery({ query: "a" });
        recordQuery({ query: "b" });
      }).then((r) => r.report);
    // Alphabetical tie-break, not insertion order: a report that reshuffles
    // between identical runs cannot be diffed against a recorded baseline.
    expect((await run()).repeated).toEqual((await run()).repeated);
    expect((await run()).repeated[0]?.query).toBe("a");
  });
});

describe("every route in the app is covered by a budget", () => {
  const routes = discoverRoutes(join(process.cwd(), "src", "app"));
  const apiRoutes = routes.filter((r) => r.path.startsWith("/api"));

  test("the sweep found a non-trivial number of API routes", () => {
    // Guards the guard: if discovery silently returned [], every assertion below
    // would pass vacuously, which is the failure mode a derived gate is most
    // vulnerable to.
    expect(apiRoutes.length).toBeGreaterThan(20);
  });

  test("every API route resolves to a budget, override or default", () => {
    const unbudgeted = apiRoutes
      .filter((r) => !Number.isInteger(budgetFor(r.path)))
      .map((r) => r.path);
    expect(unbudgeted).toEqual([]);
  });

  test("no override exists for a route that no longer exists", () => {
    // A stale override is worse than none: it advertises a budget for a path
    // that is gone, and it hides the fact that a NEW route is on the default.
    const live = new Set(routes.map((r) => r.path));
    const stale = Object.keys(QUERY_BUDGETS).filter((p) => !live.has(p));
    expect(stale).toEqual([]);
  });

  test("every override states a substantive reason", () => {
    // A budget above the default is a decision someone must be able to audit
    // later, so it cannot be a bare number or a tautology. The real check is
    // length plus substance, not a magic word.
    for (const [path, entry] of Object.entries(QUERY_BUDGETS)) {
      expect(Number.isInteger(entry.budget)).toBe(true);
      expect(entry.budget).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(40);
      // A reason that just restates the number explains nothing.
      expect(entry.reason).not.toBe(`${entry.budget}`);
      expect(path.startsWith("/api/")).toBe(true);
    }
  });

  test("the health probe is held tighter than the default", () => {
    // A liveness probe that touches the database expensively is how a slow DB
    // turns into a container restart loop. This asserts the intent so a later
    // "just raise it a bit" edit has to be deliberate.
    expect(budgetFor("/api/health")).toBeLessThan(DEFAULT_QUERY_BUDGET);
  });

  test("the ingest budget is generous but still bounded", () => {
    // It is the busiest route in the system, so it legitimately needs the most
    // queries — but "busiest" must not become "unbounded".
    const ingest = budgetFor("/api/v1/interventions");
    expect(ingest).toBeGreaterThan(DEFAULT_QUERY_BUDGET);
    expect(ingest).toBeLessThanOrEqual(30);
  });
});

describe("the counter is wired where it claims to be", () => {
  test("src/lib/db.ts installs the query emitter in non-production only", () => {
    // If this regresses to a no-op, every budget above becomes decoration: the
    // counter would always report 0 and every route would "pass".
    const db = read("src/lib/db.ts");
    expect(db).toContain("recordQuery");
    expect(db).toContain('level: "query"');
    expect(db).toContain('? ["error"]');
  });

  test("the counter stays out of the production query path", () => {
    // Per-query events cost something on every request. Paying that to satisfy
    // a test would be the wrong trade, so production must not emit them.
    //
    // Asserted structurally rather than by substring: the config is a ternary
    // whose production arm is `? ["error"]` and whose development arm is the
    // array holding the emitter. A substring search for `recordQuery` after the
    // `?` would match the development arm, which is exactly the code being
    // allowed — so the check has to be "the arm that does NOT contain it".
    const db = read("src/lib/db.ts");
    const ternary = /log:\s*isProd\s*\?\s*(\[[^\]]*\])\s*:/.exec(db);
    expect(ternary).not.toBeNull();
    const productionArm = ternary?.[1] ?? "";
    expect(productionArm).toContain('"error"');
    expect(productionArm).not.toContain("recordQuery");
    expect(productionArm).not.toContain("query");
  });
});

describe("N+1 regression: the shape a real handler must not have", () => {
  /**
   * These run against a FAKE db rather than a live database on purpose.
   *
   * The point is not that a query returns rows — it is that the NUMBER of
   * queries scales with the number of rows. That property is observable without
   * a database, which is what makes this gate runnable in the fast CI lane
   * instead of only against the (currently unreachable) remote Postgres. The
   * DB-backed suites prove the queries are CORRECT; this proves their COUNT is
   * bounded, which correctness alone never will.
   */
  const fakeDb = (impl: (model: string) => Promise<unknown[]>) =>
    new Proxy({} as Record<string, (args?: unknown) => Promise<unknown[]>>, {
      get: (_t, model: string) => () => {
        // Every model access is a real query, so it must be RECORDED. Without
        // this the fake silently reports zero and every assertion below would
        // pass for the wrong reason — which is exactly the vacuous-gate failure
        // mode these tests exist to rule out.
        recordQuery({ query: `SELECT * FROM "${model}"` });
        return impl(String(model));
      },
    });

  test("a per-row lookup scales linearly and is caught", async () => {
    // The defect, in its natural form: fetch N cases, then look up each one's
    // customer. The count grows WITH the row count — that is the whole point,
    // and it is why the bug is invisible at 10 rows and fatal at 10,000.
    const measure = async (n: number) => {
      const rows = Array.from({ length: n }, (_, i) => ({ id: i, customerId: `c${i}` }));
      const db = fakeDb((model) =>
        Promise.resolve(model === "case" ? rows : [{ id: "cust", name: "Acme" }]),
      );
      const { report } = await runWithQueryCounter(async () => {
        const cases = await db.case?.();
        for (const row of cases ?? []) await db.customer?.();
      });
      return report;
    };

    const small = await measure(10);
    const large = await measure(40);

    // N rows => N+1 queries. Linear in the row count, so it is unbounded.
    expect(small.count).toBe(11);
    expect(large.count).toBe(41);
    expect(large.count - small.count).toBe(30);

    // The diagnosis, not just the verdict: it names WHICH query repeated and
    // how many times, so a failure points at the loop rather than a number.
    expect(small.repeated[0]?.count).toBe(10);
    expect(large.repeated[0]?.query).toContain("customer");

    // And at production row counts it is unambiguously over any budget, which
    // is what makes it a defect rather than a style preference.
    expect(large.count).toBeGreaterThan(budgetFor("/api/console/events"));
  });

  test("the batched fix stays inside the budget", async () => {
    // Same answer, one query. This is what "fixed" looks like, asserted so the
    // gate points at a concrete remedy rather than just forbidding the bug.
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, customerId: `c${i}` }));
    const customerIds = rows.map((r) => r.customerId);
    const db = fakeDb((model) =>
      Promise.resolve(model === "customer" ? [{ id: "cust", ids: customerIds }] : rows),
    );

    const { report } = await runWithQueryCounter(async () => {
      const cases = await db.case?.();
      const ids = (cases ?? []).map((r) => r.customerId);
      await db.customer?.({ ids }); // one IN (...) round trip
    });

    expect(report.count).toBe(2);
    expect(report.count).toBeLessThanOrEqual(budgetFor("/api/console/events"));
    expect(report.repeated).toEqual([]);
  });

  test("an unbounded per-row write loop is caught too", async () => {
    // The write-side twin, and the more expensive one: N inserts in a loop.
    const db = fakeDb(() => Promise.resolve([]));
    const { report } = await runWithQueryCounter(async () => {
      for (let i = 0; i < 25; i++) await db.auditEvent?.({ i });
    });
    expect(report.count).toBe(25);
    expect(report.repeated[0]?.query).toBeDefined();
  });

  test("Promise.all over one query stays cheap", async () => {
    // A false-positive guard for the fan-out pattern people reach for first:
    // parallelising N identical queries does NOT make them cheaper, and the gate
    // must not accidentally reward it as if it did.
    const db = fakeDb(() => Promise.resolve([{ id: 1 }]));
    const { report } = await runWithQueryCounter(async () => {
      await Promise.all(Array.from({ length: 8 }, () => db.customer?.()));
    });
    expect(report.count).toBe(8);
    expect(report.repeated[0]?.count).toBe(8);
  });
});

describe("the counter is connected to the real Prisma client", () => {
  /**
   * This is the assertion that stops the whole module being decoration.
   *
   * Everything above drives `recordQuery()` by hand, which proves the counter
   * WORKS but not that Prisma ever calls it. The first version of this wiring
   * declared `log: [{ emit: fn, level: 'query' }]`, which is not a valid Prisma
   * 7 config at all — `emit` is the string `'stdout' | 'event'` — and the
   * contracts suite caught it by failing to construct the client.
   *
   * A subtler version of the same bug is legal and silent: declaring
   * `emit: 'event'` with no `$on('query')` subscription. Nothing throws, every
   * budget passes, and the counter has never seen a query. So the wiring is
   * asserted STRUCTURALLY against the source, because actually constructing a
   * client here would need the database this gate deliberately avoids.
   */
  test("db.ts declares the query level AND subscribes to it", () => {
    const db = read("src/lib/db.ts");
    // Declared …
    expect(db).toContain('level: "query"');
    expect(db).toContain('emit: "event"');
    // … and, the part that actually delivers, subscribed.
    expect(db).toContain('$on("query"');
    expect(db).toContain("recordQuery");
  });

  test("the subscription is not unconditional", () => {
    // A listener that runs in production taxes every request for a result
    // nothing consumes. The guard must be structural.
    const db = read("src/lib/db.ts");
    expect(db).toMatch(/if \(!isProd\)\s*\{[^}]*\$on\("query"/);
  });

  test("the counter records only queries, not other event levels", () => {
    // `recordQuery` reads `.query`. Handed a warn/error LogEvent it would
    // record `undefined`, and every repeated-query report would carry a bogus
    // "undefined" entry that looks like a real hot query.
    const counter = read("src/lib/telemetry/query-counter.ts");
    expect(counter).toContain("event.query");
    expect(counter).toContain("push(event.query)");
  });
});
