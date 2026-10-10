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
