import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * AA-1.1 — request-scoped database query counter.
 *
 * ── The defect class ───────────────────────────────────────────────────────
 * An N+1 is the most common way a correct-looking query layer becomes slow:
 * a loop that runs the same query once per row. It passes every functional test,
 * because every answer is still correct. It only shows up under production row
 * counts, where 12 queries become 12,000.
 *
 * The reason it survives review is that nobody counts. `SELECT` correctness is
 * asserted; `SELECT` *count* is not. So this module makes the count observable
 * and per-request, which is the granularity that matters: a global counter
 * cannot tell a slow route from a fast one.
 *
 * ── Why AsyncLocalStorage and not a global ──────────────────────────────────
 * The counter has to survive `await`. A module-level mutable counter cannot:
 * two concurrent requests in one Node process would interleave into the same
 * number, and whichever finished last would win. `runWithQueryCounter()` wraps
 * a request in a context that stays attached to that call chain across every
 * await, so concurrent requests are counted independently and correctly.
 *
 * Bun and Node both implement this; the store is a plain object so the counter
 * has no framework dependency and can be unit-tested without Next.js.
 *
 * ── Deliberate limits ──────────────────────────────────────────────────────
 * Counting is OFF unless something asks for it. Wiring a counter into a hot
 * production path for no consumer would tax every request to satisfy a test.
 * `runWithQueryCounter()` is opt-in, so the cost is paid only by the tests and
 * by any future production telemetry that opts in deliberately.
 */

/** What a single request's query activity looks like once measured. */
export type QueryCountReport = {
  /** Total queries issued inside the context. */
  readonly count: number;
  /**
   * The query text of every observed query, in order.
   *
   * Kept so a failure can name WHICH query repeated. A bare count tells you
   * something is wrong; the shape tells you what.
   */
  readonly queries: readonly string[];
  /**
   * Query text repeated more than once, with its occurrence count, descending.
   *
   * This is the N+1 signature: one query appearing N times where a single
   * `IN (...)` would do.
   */
  readonly repeated: readonly { readonly query: string; readonly count: number }[];
};

type QueryStore = { queries: string[] };

const storage = new AsyncLocalStorage<QueryStore>();

/**
 * Prisma's `log: ["query"]` event.
 *
 * Declared structurally rather than imported from Prisma so this module can be
 * loaded by a unit test without the generated client — and so a Prisma version
 * bump that reorders the event shape surfaces as a type error here rather than
 * as a silently-zero counter.
 */
export type PrismaQueryEvent = { query: string };

/**
 * The function handed to Prisma's `log: [{ emit, level }]` config.
 *
 * A no-op unless a query counter is active for the current request. Cheap
 * enough to leave permanently installed: one `getStore()` on a path that Prisma
 * is already logging to an array.
 */
export function recordQuery(event: PrismaQueryEvent): void {
  const store = storage.getStore();
  // Outside any counted context (a boot-time query, a background worker, a
  // migration) there is nothing to attribute the query to. Recording it into a
  // global would be the concurrency bug this module exists to avoid.
  if (!store) return;
  store.queries.push(event.query);
}

/**
 * Run `fn` with a fresh query counter attached to its call chain.
 *
 * The returned report is a snapshot taken when `fn` settles, so the count
 * covers exactly the queries issued by this call and nothing else.
 */
export async function runWithQueryCounter<T>(
  fn: () => Promise<T>,
): Promise<{ readonly result: T; readonly report: QueryCountReport }> {
  const store: QueryStore = { queries: [] };
  const result = await storage.run(store, fn);
  return { result, report: summarize(store.queries) };
}

/**
 * The counter for the request currently in flight, or `null` when counting is
 * not enabled.
 *
 * This is what a route handler reads to assert its own budget from inside the
 * request, which is how the per-route budgets below stay honest: the assertion
 * runs against the same counter the test measured.
 */
export function currentQueryCount(): number {
  return storage.getStore()?.queries.length ?? 0;
}

function summarize(queries: readonly string[]): QueryCountReport {
  const tally = new Map<string, number>();
  for (const q of queries) tally.set(q, (tally.get(q) ?? 0) + 1);
  const repeated = [...tally.entries()]
    .filter(([, count]) => count > 1)
    .map(([query, count]) => ({ query, count }))
    // Highest repetition first, then alphabetical, so the report is stable
    // across runs and a diff means a real change rather than ordering noise.
    .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query));
  return { count: queries.length, queries: [...queries], repeated };
}
