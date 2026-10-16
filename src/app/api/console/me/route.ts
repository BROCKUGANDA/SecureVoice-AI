import { NextResponse } from "next/server";
import { getProfile } from "@/lib/credits";
import { db } from "@/lib/db";
import { orgPlanContext } from "@/lib/billing/plan-context";
import { resolveChargeMode } from "@/lib/billing/charge-mode";
import { netUsageUnits } from "@/lib/payments/overage";

export const dynamic = "force-dynamic";

/**
 * The signed-in operator's profile + prepaid credits balance (wallet).
 *
 * Also carries `setupCompleted`. The Command Center uses it to offer the setup
 * wizard to a tenant that has never completed one — read from the ORGANIZATION
 * because the wizard configures the institution, not the person. A tenant-less
 * session has nothing to set up, so the field is null and the banner stays
 * hidden rather than offering a wizard with nowhere to save to.
 *
 * Also carries `plan`, which is what makes the usage bar honest. `CreditWidget`
 * used to divide by a number it invented for itself: the `allowance` prop had
 * exactly one caller in the whole tree and it was never passed, so the bar's
 * denominator was whatever balance the widget first saw. The plan is resolved
 * server-side here (`src/lib/billing/plan-context.ts`) — mirrored subscription,
 * then the `Organization.planTier` column, then the deployment default — because
 * a browser-supplied allowance is a customer telling us what they bought.
 *
 * Seat facts are deliberately NOT here. `GET /api/auth/invites` already answers
 * "who is in this organization" and carries the cap next to that list; a second
 * counter on a second route is a second number that can disagree with the first.
 *
 * Why this read is NOT on the database-enforced path (`withTenantScope`,
 * src/lib/tenancy/db-scope.ts), and is not convertible:
 *
 *   · `organization` is the tenant table. It has no `orgId` column — its own `id`
 *     IS the tenant — so the RLS discovery loop in migration
 *     `9zzzzzzzzzzzzzzzzzzzzzz_tenant_rls` never attached a `tenant_scope` policy
 *     to it, and `..._tenant_rls_coverage` then enables row security on it with
 *     NO policy on purpose (an organisation row is what RESOLVES a tenant, so a
 *     policy keyed to `app.org_id` could only be evaluated after the tenant was
 *     already known). Entering `sv_tenant` therefore makes this table empty: the
 *     read returns null and every tenant's `setupCompleted` reports false. That is
 *     a behaviour change, not a security win — asserted against the live database
 *     in tests/tenancy/rls-enforcement.test.ts.
 *   · There is no tenant predicate to forget here either: the id looked up is
 *     `profile.orgId`, derived from the session by `getProfile()` and never taken
 *     from a request field, so this read can only ever name the caller's own
 *     organisation.
 *   · The application guard is not an option for this table: `Organization` is in
 *     neither `TENANTED_MODELS` nor `PLATFORM_MODELS` (src/lib/tenancy/guard.ts),
 *     so `scopedDb()` refuses it with `unregistered_model`.
 */
export async function GET() {
  const profile = await getProfile();
  const setupCompleted = profile?.orgId
    ? Boolean(
        (
          await db.organization.findUnique({
            where: { id: profile.orgId },
            select: { setupCompletedAt: true },
          })
        )?.setupCompletedAt,
      )
    : null;
  const plan = await orgPlanContext(profile?.orgId ?? null);
  // The numerator of the usage bar, measured by the SAME aggregate the invoice
  // rater runs (`netUsageUnits`) — a screen that says 2,480 used while the
  // invoice says 2,510 is a dispute waiting to happen. Computed only when a plan
  // published an allowance AND a mirrored period bounds the window; with no
  // mirrored subscription there is no period to measure, and the widget falls
  // back to showing the balance without a percentage.
  const usage =
    plan.period && plan.orgId && plan.allowanceUnits > 0
      ? {
          usedUnits: await netUsageUnits(plan.orgId, plan.period.from, plan.period.to),
          includedUnits: plan.allowanceUnits,
          periodFrom: plan.period.from.toISOString(),
          periodTo: plan.period.to.toISOString(),
        }
      : null;
  // Whether this session's runs are billed at all, resolved by the same function
  // the metered paths use (`src/lib/billing/charge-mode.ts`). Sent so the UI can
  // stop rendering a SPENDABLE BALANCE to somebody who cannot spend one — the demo
  // seat used to show a credit count that looked like money and was not, and the
  // fix has to be visible on the surface or it is only true in the database.
  //
  // Server-resolved on purpose. A client-supplied "am I in demo mode" is a value
  // the browser asserts about what it is allowed to do.
  const charge = await resolveChargeMode({
    email: profile?.email,
    orgId: profile?.orgId,
  });
  return NextResponse.json(
    {
      profile,
      setupCompleted,
      chargeMode: charge.mode,
      chargeReason: charge.reason,
      plan: {
        tier: plan.tier,
        plan: plan.plan,
        allowanceUnits: plan.allowanceUnits,
        /** null = unlimited. Read from the plan, never guessed by the client. */
        seats: plan.seats,
        paid: plan.paid,
        /** Which evidence answered. `none` means the console is showing the demo policy. */
        source: plan.source,
        usage,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
