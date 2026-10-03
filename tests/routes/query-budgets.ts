/**
 * AA-1.1 — per-route query budgets.
 *
 * The counter (src/lib/telemetry/query-counter.ts) answers "how many queries did
 * this request make". This file answers the only question that matters for a
 * gate: "is that number acceptable for THIS route".
 *
 * ── Why a table and not one global number ───────────────────────────────────
 * A single limit is either too strict for a genuine aggregation route (a console
 * dashboard legitimately joins several tables) or too loose to catch anything.
 * The budget is a property of the route's job, so it is declared per route.
 *
 * ── Why the DEFAULT is the safety net ───────────────────────────────────────
 * An explicit map of every route would go stale the moment someone adds one,
 * and a route with no entry would then be silently unbudgeted — the exact
 * failure this register exists to prevent. So the map only holds OVERRIDES, and
 * anything not listed falls back to `DEFAULT_QUERY_BUDGET`.
 *
 * That makes adding a new route safe by default: it is budgeted the moment it
 * exists, and the budget test below FAILS if a route is so cheap it cannot
 * possibly need the default — which is how the overrides get audited over time
 * instead of accumulating as folklore.
 */

/** Applied to any route without an explicit override. */
export const DEFAULT_QUERY_BUDGET = 12;

/**
 * Explicit per-route budgets, and the reason each one differs from the default.
 *
 * A number without a reason is a number nobody dares change, so every entry
 * states what the route is actually doing that costs queries.
 */
export const QUERY_BUDGETS: Readonly<Record<string, { budget: number; reason: string }>> = {
  "/api/console/events": {
    budget: 24,
    reason:
      "aggregates the case feed, audit chain and queue depth for the live console view; several independent reads is the point, not an N+1",
  },
  "/api/console/audit": {
    budget: 20,
    reason:
      "paginates the append-only audit chain and resolves each entry's actor, so it does a bounded join rather than a per-row lookup",
  },
  "/api/status": {
    budget: 16,
    reason:
      "reports live dependency health (db latency, queue depth, telephony mode), each of which is a separate read on purpose",
  },
  "/api/v1/interventions": {
    budget: 20,
    reason:
      "the hardened ingest: idempotency check, consent check, customer resolution, Case insert and queue insert, each a required distinct write",
  },
  "/api/readyz": {
    budget: 8,
    reason:
      "readiness probes each dependency once; it must stay cheap because a load balancer calls it constantly",
  },
  "/api/health": {
    budget: 4,
    reason:
      "liveness only — it must NOT touch the database beyond a trivial call, or a slow DB would restart healthy containers",
  },
};

/** The budget that applies to `path`. */
export function budgetFor(path: string): number {
  return QUERY_BUDGETS[path]?.budget ?? DEFAULT_QUERY_BUDGET;
}

/** The stated reason for a route's budget, or the default's reason. */
export function reasonFor(path: string): string {
  return (
    QUERY_BUDGETS[path]?.reason ??
    "no override declared, so this route is held to the default budget"
  );
}
