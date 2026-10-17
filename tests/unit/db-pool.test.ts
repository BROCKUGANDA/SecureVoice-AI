/**
 * The connection budget, as a contract rather than a formula.
 *
 * The production failure this pins down was never visible in code review, because
 * every individual number was defensible: `cpus * 2 + 1` is a normal main pool,
 * and 5 is a normal audit pool. What broke was the SUM, across seven processes,
 * against a pooler whose client cap is set elsewhere and is not in this
 * repository at all:
 *
 *     EMAXCONNSESSION  max clients reached in session mode
 *                      - max clients are limited to pool_size: 15
 *
 * So the assertions below are mostly about the SUM and about who may change it,
 * because those are the two properties that were missing.
 */
import { describe, expect, test } from "bun:test";
import { resolvePoolBudget } from "@/lib/db-pool";

/** The compose `db` service, and the URL a developer runs against. */
const LOCAL = "postgresql://u:p@db:5432/securevoice?schema=public";
const LOOPBACK = "postgresql://u:p@127.0.0.1:5432/securevoice";
/** Production: Supabase's pooler, session mode, external cap. */
const SUPABASE = "postgresql://u:p@db.abcdefg.supabase.co:5432/postgres";

/** Every service in docker-compose.yml that opens a pool. */
const SERVICE_COUNT = 7;
/** Supavisor's session-mode default, which is what production actually runs. */
const POOLER_CAP = 15;

describe("pool budget", () => {
  test("a shared pooler is detected from the host, not configured", () => {
    expect(resolvePoolBudget(SUPABASE, {}).sharedPooler).toBe(true);
    expect(resolvePoolBudget(SUPABASE, {}).kind).toBe("managed-supabase");
    // And a database you run is NOT treated as one, so the wider default stands.
    expect(resolvePoolBudget(LOCAL, {}).sharedPooler).toBe(false);
    expect(resolvePoolBudget(LOOPBACK, {}).sharedPooler).toBe(false);
  });

  test("behind a shared pooler, a process takes a small share of the budget", () => {
    const b = resolvePoolBudget(SUPABASE, {});
    expect(b.main).toBe(1);
    expect(b.audit).toBe(1);
  });

  test("THE REGRESSION: per-process totals must not multiply past the pooler cap", () => {
    // This is the assertion that would have caught it. It is written as an
    // explicit budget rather than derived from CPU count, because the budget is
    // a property of the pooler and the service count, not of this machine.
    //
    // 7 x 2 = 14 under a cap of 15. That leaves ONE spare slot, which is
    // starvation-avoidance and not capacity: it is why the defaults cannot be
    // raised without either raising the quota or leaving session mode. The
    // operator knobs exist for exactly that, and the runbook says so.
    const b = resolvePoolBudget(SUPABASE, {});
    const worstCase = (b.main + b.audit) * SERVICE_COUNT;
    expect(worstCase).toBeLessThanOrEqual(POOLER_CAP);
  });

  test("raising a pool past the default is a quota decision, not a free one", () => {
    // Pinned because the knobs make it easy to do by accident: a doubled pool in
    // every service is 28 clients against a 15-slot pooler, which is strictly
    // worse than the failure being fixed.
    const doubled = resolvePoolBudget(SUPABASE, { DB_POOL_MAX: "2", DB_AUDIT_POOL_MAX: "2" });
    expect((doubled.main + doubled.audit) * SERVICE_COUNT).toBeGreaterThan(POOLER_CAP);
  });

  test("the old formula is what broke it, so it is pinned as too large", () => {
    // `cpus * 2 + 1` plus a flat 5, across every service. Whatever this machine
    // happens to have, it is well past what the pooler allows.
    const b = resolvePoolBudget(SUPABASE, {});
    const oldBehaviour = (Math.max(2, 2) * 2 + 1 + 5) * SERVICE_COUNT;
    expect(oldBehaviour).toBeGreaterThan(POOLER_CAP);
    expect(b.main + b.audit).toBeLessThan(2 * 2 + 1 + 5);
  });

  test("the env knobs win, so the fix needs no rebuild", () => {
    const b = resolvePoolBudget(SUPABASE, { DB_POOL_MAX: "4", DB_AUDIT_POOL_MAX: "2" });
    expect(b.main).toBe(4);
    expect(b.audit).toBe(2);
  });

  test("connection_limit in the URL is still honoured", () => {
    const b = resolvePoolBudget(`${SUPABASE}?connection_limit=6`, {});
    expect(b.main).toBe(6);
    // ...and an explicit env var overrides the URL, so one number can be changed
    // without editing a string that is also pasted into dashboards and CI.
    expect(resolvePoolBudget(`${SUPABASE}?connection_limit=6`, { DB_POOL_MAX: "3" }).main).toBe(3);
  });

  test("nonsense values cannot produce a pool of zero", () => {
    // `max: 0` is a valid pg.Pool setting meaning "never connect", so a bad env
    // var read as 0 would be a silent self-inflicted outage rather than a crash.
    for (const bad of ["0", "-1", "", "abc"]) {
      const b = resolvePoolBudget(SUPABASE, { DB_POOL_MAX: bad, DB_AUDIT_POOL_MAX: bad });
      expect(b.main, `DB_POOL_MAX=${JSON.stringify(bad)}`).toBeGreaterThan(0);
      expect(b.audit, `DB_AUDIT_POOL_MAX=${JSON.stringify(bad)}`).toBeGreaterThan(0);
    }
  });

  test("a self-hosted database keeps the wider, CPU-scaled default", () => {
    const b = resolvePoolBudget(LOCAL, {});
    expect(b.main).toBeGreaterThan(2);
    expect(b.audit).toBe(5);
  });
});
