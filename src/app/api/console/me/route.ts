import { NextResponse } from "next/server";
import { getProfile } from "@/lib/credits";
import { db } from "@/lib/db";

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
  return NextResponse.json(
    { profile, setupCompleted },
    { headers: { "Cache-Control": "no-store" } },
  );
}
