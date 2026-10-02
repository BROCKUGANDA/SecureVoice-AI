import "server-only";
/**
 * Per-organisation spend circuit breaker (WP-13).
 *
 * Three rules the implementation exists to enforce:
 *
 *   1. **Hard stop at 100% of the cap.** An organisation may spend exactly up
 *      to its hourly and daily cap; the first request that would take it PAST
 *      the cap is refused. No third-party spend is ever authorised in the same
 *      tick that the cap is reached, because the check and the write that
 *      follows it are separated by exactly one transaction (the ledger write
 *      in `reserve`).
 *   2. **Alerts at 60 / 80 / 95%.** The caller is told the exact percentage so
 *      an operator can be paged before the money is gone, not after.
 *   3. **A global kill switch that needs no deploy.** `BILLING_KILL_SWITCH` is
 *      read from `process.env` on EVERY call — not cached at module load — so
 *      flipping it in the platform's env store takes effect on the next
 *      request. This is the incident lever: when a metered provider starts
 *      charging for something we did not ask for, the whole platform stops
 *      spending within one request.
 *
 * ## Never throws
 *
 * `assertWithinBudget` is called from request handlers. It returns a typed
 * decision and NEVER rejects: a database outage resolves to `stop` with
 * `reason: "metering_unavailable"`. Failing OPEN here would mean a broken
 * database authorises unbounded third-party spend, which is the exact failure
 * this module exists to prevent — so it fails closed, loudly, and `stopReason`
 * is on the response for the operator.
 *
 * ## Money
 *
 * Every limit and every spend figure is an INTEGER minor unit. Floats are
 * rejected at the boundary by `assertMinor()`.
 */

import { db } from "@/lib/db";

/** Alert thresholds as whole percents of the cap. */
export const ALERT_THRESHOLDS = [60, 80, 95] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];

/** Past this percentage of the cap, nothing further may be spent. */
export const HARD_STOP_PERCENT = 100;

export const KILL_SWITCH_ENV = "BILLING_KILL_SWITCH";
export const HOURLY_LIMIT_ENV = "BILLING_HOURLY_LIMIT_MINOR";
export const DAILY_LIMIT_ENV = "BILLING_DAILY_LIMIT_MINOR";

const KILL_SWITCH_TRUE = new Set(["1", "true", "on", "yes", "stop", "halt"]);

/** AED minor-unit fallbacks: 10,000.00 and 100,000.00. */
const DEFAULT_HOURLY_MINOR = 1_000_000;
const DEFAULT_DAILY_MINOR = 10_000_000;

export type BudgetWindow = "hourly" | "daily";
export const BUDGET_WINDOWS: readonly BudgetWindow[] = ["hourly", "daily"] as const;

export type OrgBudget = {
  hourlyMinor: number;
  dailyMinor: number;
};

export type WindowState = {
  window: BudgetWindow;
  limitMinor: number;
  spentMinor: number;
  /** (spent + requested) / limit * 100, capped for display at 999. */
  projectedPercent: number;
  /** What is already spent, before this request. */
  currentPercent: number;
  /** Hour-window start / UTC-midnight, whichever applies. */
  windowStart: Date;
  windowEnd: Date;
};

export type StopReason =
  | "kill_switch"
  | "hard_stop"
  | "zero_limit"
  | "invalid_units"
  | "invalid_budget"
  | "metering_unavailable";

export type BreakerDecision =
  | { decision: "allow"; percent: number; threshold: null; window: BudgetWindow | null; windows: WindowState[] }
  | { decision: "warn"; percent: number; threshold: AlertThreshold; window: BudgetWindow; windows: WindowState[] }
  | {
      decision: "stop";
      reason: StopReason;
      percent: number;
      window: BudgetWindow | null;
      windows: WindowState[];
    };

// ── budget registry ───────────────────────────────────────────────────────────

/**
 * Per-org caps. There is no `OrgBudget` table in the schema this WP ships
 * against, so the override lives in process memory: it is set from the
 * operator console at boot / on change, and re-seeded on restart. Defaults come
 * from the environment, so an operator CAN change a cap without a code deploy
 * (the documented path for the production rollout).
 */
const ORG_BUDGETS = new Map<string, OrgBudget>();

export function setOrgBudget(orgId: string, budget: Partial<OrgBudget>): OrgBudget {
  const current = ORG_BUDGETS.get(orgId);
  const next: OrgBudget = {
    hourlyMinor: budget.hourlyMinor ?? current?.hourlyMinor ?? defaultBudget().hourlyMinor,
    dailyMinor: budget.dailyMinor ?? current?.dailyMinor ?? defaultBudget().dailyMinor,
  };
  ORG_BUDGETS.set(orgId, assertBudget(orgId, next));
  return next;
}

export function clearOrgBudget(orgId: string): void {
  ORG_BUDGETS.delete(orgId);
}

/** The effective cap for an org, override first, environment second. */
export function budgetFor(orgId: string): OrgBudget {
  const override = ORG_BUDGETS.get(orgId);
  if (override) return override;
  return defaultBudget();
}

function defaultBudget(): OrgBudget {
  return {
    hourlyMinor: envMinor(HOURLY_LIMIT_ENV, DEFAULT_HOURLY_MINOR),
    dailyMinor: envMinor(DAILY_LIMIT_ENV, DEFAULT_DAILY_MINOR),
  };
}

function envMinor(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    // A malformed cap must not silently become "unlimited" (or "always stop").
    throw new Error(`${name} must be a non-negative integer number of minor units (got "${raw}")`);
  }
  return n;
}

/**
 * The platform kill switch. Read from `process.env` at call time on purpose:
 * caching it at module scope would require a redeploy to stop the bleeding,
 * which is the one thing an incident lever must not do.
 */
export function killSwitchEngaged(): boolean {
  const raw = process.env[KILL_SWITCH_ENV];
  if (!raw) return false;
  return KILL_SWITCH_TRUE.has(raw.trim().toLowerCase());
}

// ── boundaries ────────────────────────────────────────────────────────────────

function assertMinor(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer minor-unit value (got ${String(value)})`);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function assertBudget(orgId: string, budget: OrgBudget): OrgBudget {
  assertMinor(budget.hourlyMinor, `${orgId}.hourlyMinor`);
  assertMinor(budget.dailyMinor, `${orgId}.dailyMinor`);
  return budget;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function windowBounds(window: BudgetWindow, now: Date): { start: Date; end: Date } {
  const ms = now.getTime();
  if (window === "hourly") {
    const start = Math.floor(ms / HOUR_MS) * HOUR_MS;
    return { start: new Date(start), end: new Date(start + HOUR_MS) };
  }
  // UTC day. A local-midnight day would move the reset boundary twice a year
  // and make two operators looking at the same number disagree.
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

function percent(spent: number, limit: number): number {
  if (limit <= 0) return Number.POSITIVE_INFINITY;
  return (spent / limit) * 100;
}

function displayPercent(p: number): number {
  return Number.isFinite(p) ? Math.min(999, Math.round(p * 100) / 100) : 999;
}

/**
 * Money already spent inside the window. Spend is the POSTED quantity, i.e. the
 * kinds that represent delivered value or money moved: `consume` (billed usage)
 * and `topup` (prepaid purchase), net of `refund`. `reserve` is a HOLD and is
 * deliberately excluded — a dial in progress has not cost money yet, and
 * counting holds twice (once here, once in the ledger) would trip the breaker
 * on intent rather than on spend.
 */
async function spentSince(orgId: string, since: Date): Promise<number> {
  const row = await db.$queryRaw<{ total: number }[]>`
    SELECT COALESCE(SUM("units"), 0)::int AS "total"
      FROM "UsageLedger"
     WHERE "orgId" = ${orgId}
       AND "kind" IN ('consume', 'topup', 'refund')
       AND "createdAt" >= ${since}
  `;
  return row[0]?.total ?? 0;
}

// ── the decision ──────────────────────────────────────────────────────────────

/**
 * May this organisation spend `units` more minor units right now?
 *
 * Never rejects. Returns `allow`, `warn` (with the threshold crossed) or
 * `stop` (with the reason). Both windows are always evaluated and both are
 * returned, so an operator can see the daily cap that is about to bite even
 * when the hourly one tripped first.
 */
export async function assertWithinBudget(input: {
  orgId: string;
  units: number;
  /** Injectable for deterministic tests; defaults to wall clock. */
  now?: Date;
}): Promise<BreakerDecision> {
  const now = input.now ?? new Date();
  const orgId = typeof input.orgId === "string" ? input.orgId.trim() : "";

  if (!orgId) {
    return { decision: "stop", reason: "invalid_units", percent: 999, window: null, windows: [] };
  }

  const units = input.units;
  if (typeof units !== "number" || !Number.isInteger(units) || units < 0 || !Number.isSafeInteger(units)) {
    // Never throw into a request handler, and never round a float into money.
    return { decision: "stop", reason: "invalid_units", percent: 999, window: null, windows: [] };
  }

  // Kill switch first: it must work even when the ledger is unreachable.
  if (killSwitchEngaged()) {
    return { decision: "stop", reason: "kill_switch", percent: 999, window: null, windows: [] };
  }

  let budget: OrgBudget;
  try {
    budget = budgetFor(orgId);
  } catch {
    // A malformed cap in the environment must not become "unlimited", and this
    // function promises never to throw. Fail closed.
    return { decision: "stop", reason: "invalid_budget", percent: 999, window: null, windows: [] };
  }

  const states: WindowState[] = [];
  try {
    for (const window of BUDGET_WINDOWS) {
      const { start, end } = windowBounds(window, now);
      const limitMinor = window === "hourly" ? budget.hourlyMinor : budget.dailyMinor;
      const spentMinor = await spentSince(orgId, start);
      const projected = spentMinor + units;
      states.push({
        window,
        limitMinor,
        spentMinor,
        projectedPercent: displayPercent(percent(projected, limitMinor)),
        currentPercent: displayPercent(percent(spentMinor, limitMinor)),
        windowStart: start,
        windowEnd: end,
      });
    }
  } catch {
    // Fail CLOSED. An unmeasurable spend history must not become an
    // authorisation to spend without limit.
    return { decision: "stop", reason: "metering_unavailable", percent: 999, window: null, windows: states };
  }

  // Hard stop, evaluated in the order the windows bind. A limit of 0 means
  // "spend nothing", not "unlimited".
  for (const state of states) {
    if (state.limitMinor === 0) {
      return { decision: "stop", reason: "zero_limit", percent: 999, window: state.window, windows: states };
    }
  }
  for (const state of states) {
    if (percent(state.spentMinor, state.limitMinor) >= HARD_STOP_PERCENT) {
      return { decision: "stop", reason: "hard_stop", percent: state.currentPercent, window: state.window, windows: states };
    }
  }
  for (const state of states) {
    if (state.projectedPercent > HARD_STOP_PERCENT) {
      return { decision: "stop", reason: "hard_stop", percent: state.projectedPercent, window: state.window, windows: states };
    }
  }

  // Alert on the HIGHEST threshold crossed by the tightest window, so the pager
  // says "80% of your hourly cap" rather than the first rung we happened to
  // evaluate. Scanning descending and breaking on the first hit gives that.
  let worst: { threshold: AlertThreshold; percent: number; window: BudgetWindow } | null = null;
  for (const state of states) {
    for (let i = ALERT_THRESHOLDS.length - 1; i >= 0; i--) {
      const threshold = ALERT_THRESHOLDS[i]!;
      if (state.projectedPercent < threshold) continue;
      const candidate = { threshold, percent: state.projectedPercent, window: state.window };
      if (
        !worst ||
        candidate.threshold > worst.threshold ||
        (candidate.threshold === worst.threshold && candidate.percent > worst.percent)
      ) {
        worst = candidate;
      }
      break;
    }
  }

  if (worst) {
    return {
      decision: "warn",
      percent: worst.percent,
      threshold: worst.threshold,
      window: worst.window,
      windows: states,
    };
  }

  const percentAllow = states.reduce((acc, s) => Math.max(acc, s.projectedPercent), 0);
  return { decision: "allow", percent: percentAllow, threshold: null, window: null, windows: states };
}

/** Convenience wrapper for request handlers: `ok === true` means "spend it". */
export function maySpend(decision: BreakerDecision): boolean {
  return decision.decision === "allow" || decision.decision === "warn";
}

/**
 * The worst case of every window, for a health panel. Never throws: an
 * unreachable ledger reports `unknown` rather than a fabricated zero.
 */
export async function breakerStatus(
  orgId: string,
  now: Date = new Date(),
): Promise<
  | { ok: true; windows: WindowState[]; killSwitch: boolean }
  | { ok: false; reason: "metering_unavailable" | "invalid_budget"; killSwitch: boolean }
> {
  let budget: OrgBudget;
  try {
    budget = budgetFor(orgId);
  } catch {
    return { ok: false, reason: "invalid_budget", killSwitch: killSwitchEngaged() };
  }
  const windows: WindowState[] = [];
  try {
    for (const window of BUDGET_WINDOWS) {
      const { start, end } = windowBounds(window, now);
      const limitMinor = window === "hourly" ? budget.hourlyMinor : budget.dailyMinor;
      const spentMinor = await spentSince(orgId, start);
      windows.push({
        window,
        limitMinor,
        spentMinor,
        projectedPercent: displayPercent(percent(spentMinor, limitMinor)),
        currentPercent: displayPercent(percent(spentMinor, limitMinor)),
        windowStart: start,
        windowEnd: end,
      });
    }
  } catch {
    return { ok: false, reason: "metering_unavailable", killSwitch: killSwitchEngaged() };
  }
  return { ok: true, windows, killSwitch: killSwitchEngaged() };
}