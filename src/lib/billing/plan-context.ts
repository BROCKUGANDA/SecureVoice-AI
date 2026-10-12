import "server-only";
/**
 * The one place that answers "what is this organisation actually on?"
 *
 * ── Why a resolver and not a column ─────────────────────────────────────────
 * Three things already claim to know the answer, and none of them can see the
 * other two:
 *
 *   · `PaddleSubscription.priceId` — what the bank actually paid for, mirrored
 *     from Paddle by the webhook (`src/lib/payments/paddle-events.ts`). This is
 *     the only one of the three that a customer's money moved.
 *   · `Organization.planTier` (prisma/schema.prisma:881) — an operator's
 *     statement about the tenant, in the ABUSE vocabulary (`demo|standard|
 *     enterprise`), not the billing one (`starter|growth|enterprise`). Its own
 *     comment promises it overrides the deployment default; until this module
 *     existed, nothing selected it.
 *   · `abuse/tiers.ts`'s `planTierFor()` — an in-process registry and env
 *     defaults, deliberately sync, because the dial gate calls it seven times
 *     per signal and cannot await a database.
 *
 * Before this module the console read none of them: `Settings.tsx` rendered
 * `<PolicyForPlan planTier={null} />`, which told a paying bank it had no
 * refunds, and `CreditWidget` was never given an `allowance`, so its progress
 * bar divided by a number it made up for itself.
 *
 * This is the read that resolves them, in the order the evidence is worth:
 * money, then the operator's record, then the deployment, then `demo`.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * It does not change what the DIAL gate evaluates. `assertDialAllowed` still
 * calls the sync `planTierFor()`, whose behaviour `tests/abuse/abuse.test.ts`
 * pins, and `planTierFor` is a HIGH-blast-radius symbol (4 affected symbols,
 * 2 execution flows) that this change deliberately does not touch. A tenant
 * whose subscription says `starter` sees the Starter policy here while the abuse
 * gate still follows its own configured default — a deliberate seam, not an
 * oversight: making the hot dial path await a billing read to decide whether it
 * may place a call is a different change with a different risk.
 */

import { db } from "@/lib/db";
import { subMonths } from "date-fns";
import { planById, type Plan } from "@/lib/commercial";
import { hasPaidAccess } from "@/lib/payments/access";
import { includedUnitsFromEnv, planFromPriceId } from "@/lib/payments/plans";
import { planTierFor, type PlanTier } from "@/lib/abuse/tiers";
import { logWarn } from "@/lib/validation/safe-log";

export type PlanSource =
  /** An entitlement-granting Paddle subscription named the plan. */
  | "subscription"
  /** No usable subscription; `Organization.planTier` decided the tier. */
  | "organizationColumn"
  /** No subscription and no column value; the deployment default decided it. */
  | "deploymentDefault"
  /** Nothing readable answered. The console is showing the demo policy. */
  | "none";

export type OrgPlanContext = {
  orgId: string | null;
  /** Catalog plan id (`starter|growth|enterprise`), or null when no money names one. */
  plan: string | null;
  /** The plan row, when `plan` resolved. Lets a caller read every published fact at once. */
  catalog: Plan | null;
  /** Tier the CONSOLE speaks in. Billing-derived whenever billing can derive it. */
  tier: PlanTier;
  /** Interventions included per period. `0` means "nothing has published one". */
  allowanceUnits: number;
  /** Seats this plan allows. `null` = unlimited — see the fail-open note below. */
  seats: number | null;
  /** True when the mirrored subscription grants access (`active`/`trialing`/grace). */
  paid: boolean;
  /**
   * The billing period to measure usage against, or null when nothing has
   * published one.
   *
   * Derived from the mirrored `currentPeriodEnd` because a subscription period is
   * not a calendar month, and a usage bar measuring the wrong window tells a
   * customer they are inside their allowance in the week they are over it. Null
   * when there is no mirrored subscription — the console then shows the balance
   * without a percentage rather than inventing a window.
   */
  period: { from: Date; to: Date } | null;
  source: PlanSource;
};

/** `organization.id` is a uuid; every real tenant id is one. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Billing plan id → abuse tier vocabulary.
 *
 * Starter and Growth are both "a paying tenant that may dial real numbers",
 * which is exactly what `standard` means in `tiers.ts`. Enterprise maps to
 * itself. Unknown plans return null so the caller falls through to the column
 * rather than inventing a tier.
 */
export function planToTier(plan: string | null | undefined): PlanTier | null {
  if (!plan) return null;
  if (plan === "enterprise") return "enterprise";
  if (plan === "starter" || plan === "growth") return "standard";
  return null;
}

/**
 * The window the mirrored subscription is actually billing, if there is one.
 *
 * `PaddleSubscription` carries the period END (that is what a renewal moves), so
 * the window is `[end - 1 month, min(now, end)]`. A period that has already
 * closed is not reported as the current one.
 */
function billingPeriod(
  currentPeriodEnd: Date | null | undefined,
  paid: boolean,
): { from: Date; to: Date } | null {
  if (!paid || !currentPeriodEnd) return null;
  const from = subMonths(currentPeriodEnd, 1);
  const now = new Date();
  const to = now < currentPeriodEnd ? now : currentPeriodEnd;
  return to.getTime() > from.getTime() ? { from, to } : null;
}

/**
 * The newest mirrored subscription for an org, whatever its status.
 *
 * STATUS IS NOT A FILTER HERE. The caller decides what a status means through
 * `hasPaidAccess`, the tested gate for "active, trialing, or in the past-due
 * grace". Filtering to `active|trialing` in the query would make this resolver
 * and `access.ts` two definitions of "entitled", and the row a canceled
 * subscription left behind would still be the newest thing we know about the
 * tenant — it must be SEEN and then refused, not hidden.
 */
async function readSubscription(
  orgId: string,
): Promise<{ priceId: string; status: string; currentPeriodEnd: Date | null } | null> {
  try {
    return await db.paddleSubscription.findFirst({
      where: { orgId },
      orderBy: { updatedAt: "desc" },
      select: { priceId: true, status: true, currentPeriodEnd: true },
    });
  } catch (err) {
    logWarn("[billing] subscription read failed", {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The operator's own statement on the tenant row.
 *
 * `organization` is the tenant table: it has row security with NO policy by
 * design (see src/app/api/console/settings/route.ts:37-45), so this read stays on
 * the application client. There is no tenant predicate to forget — `orgId` comes
 * from the session, never from a request field.
 *
 * The uuid shape is checked before the query because a non-uuid org id is a real
 * input on this codebase (`"unscoped"`, which
 * src/app/api/v1/interventions/route.ts passes the tier resolver): Postgres
 * rejects it with `invalid input syntax for type uuid`, and an expected failure
 * logged on every request trains everyone to ignore the log.
 */
async function readColumnTier(orgId: string): Promise<string | null> {
  if (!UUID_RE.test(orgId)) return null;
  try {
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { planTier: true },
    });
    return org?.planTier ?? null;
  } catch (err) {
    logWarn("[billing] organization planTier read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The organisation's plan facts, resolved from the durable sources.
 *
 * Never throws. A billing read that fails must not take the console down with it
 * — the caller gets the demo policy, which is the honest answer when the evidence
 * is unreadable, and the same direction `planTierFor()` already fails in.
 *
 * SEAT FAILS OPEN, AND SHOULD. With no resolvable plan, `seats` is `null`
 * (unlimited). A seat cap is a commercial ceiling, not a security boundary: a
 * broken billing mirror must not lock an operator out of inviting their own
 * staff, and the failure a closed-by-default cap would cause here is an outage
 * for a customer, not a breach. Security controls in this codebase fail closed;
 * this one does not, and `source` says why.
 */
export async function orgPlanContext(orgId: string | null | undefined): Promise<OrgPlanContext> {
  const base: OrgPlanContext = {
    orgId: orgId ?? null,
    plan: null,
    catalog: null,
    tier: "demo",
    allowanceUnits: 0,
    seats: null,
    paid: false,
    period: null,
    source: "none",
  };
  if (!orgId) return { ...base, tier: planTierFor(null), source: "deploymentDefault" };

  // The two reads are separated so neither can mask the other. Bundling them in
  // one try block meant a failure in the `organization` read reported "no
  // subscription" for a tenant that has one.
  const subscription = await readSubscription(orgId);
  const columnTier = await readColumnTier(orgId);

  const paid = subscription ? hasPaidAccess(subscription.status) : false;
  // A canceled subscription keeps its price id, so the STATUS decides whether the
  // plan is still the tenant's. Reading the plan off the newest row regardless
  // would hand an expired Enterprise unlimited seats and a 10,000 allowance.
  const plan = paid ? planFromPriceId(subscription?.priceId) : null;
  const catalog = planById(plan);

  if (catalog) {
    return {
      orgId,
      plan: catalog.id,
      catalog,
      tier: planToTier(catalog.id) ?? planTierFor(orgId, columnTier),
      allowanceUnits: catalog.includedPerMonth ?? includedUnitsFromEnv(),
      seats: catalog.seats,
      paid,
      period: billingPeriod(subscription?.currentPeriodEnd, paid),
      source: "subscription",
    };
  }

  const tierFromColumn =
    columnTier === "demo" || columnTier === "standard" || columnTier === "enterprise"
      ? columnTier
      : null;

  return {
    orgId,
    plan: null,
    catalog: null,
    tier: tierFromColumn ?? planTierFor(orgId),
    allowanceUnits: includedUnitsFromEnv(),
    seats: null,
    paid,
    // No resolvable plan means no published allowance to measure against, so
    // there is no honest period either. The widget shows the balance alone.
    period: null,
    source: tierFromColumn ? "organizationColumn" : "deploymentDefault",
  };
}
