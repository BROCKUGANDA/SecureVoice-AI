/**
 * Clerk-backed platform profile + prepaid credits wallet.
 *
 * Identity lives in Clerk (operator@securevoice.ae / demo@securevoice.ae and
 * any self-serve sign-up). This module mirrors each Clerk user into a local
 * UserProfile row that carries the billing state:
 *
 *   1 credit = 1 intervention signal fired (the metered ElevenLabs/Twilio cost)
 *   operator accounts sync in with 500 credits · everyone else 25
 *
 * Every console request calls getProfile(): it syncs identity fields from the
 * Clerk session (role follows Clerk publicMetadata.role) and returns the
 * credit balance the guard then enforces — 402 once the wallet hits zero.
 */

import { auth, currentUser } from "@clerk/nextjs/server";
import { db } from "@/lib/db";

export type Role = "operator" | "demo";

export type PlatformProfile = {
  clerkUserId: string;
  email: string;
  name: string;
  role: Role;
  orgId: string | null;
  credits: number;
};

/** Sync the Clerk session user into the local wallet. Returns null when signed out. */
export async function getProfile(): Promise<PlatformProfile | null> {
  const user = await currentUser();
  if (!user) return null;

  const email =
    user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "unknown";
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || email.split("@")[0];
  const role: Role =
    (user.publicMetadata as { role?: string } | undefined)?.role === "operator"
      ? "operator"
      : "demo";
  // Active Clerk organization (multi-tenant key) from the session claims
  const { sessionClaims } = await auth();
  const orgId =
    (sessionClaims as { o?: { id?: string } } | undefined)?.o?.id ?? null;

  const row = await db.userProfile.upsert({
    where: { clerkUserId: user.id },
    create: { clerkUserId: user.id, email, name, role, orgId, credits: role === "operator" ? 500 : 25 },
    // role follows Clerk metadata (never self-granted locally); credits are wallet state
    update: { email, name, role, orgId },
  });

  return { clerkUserId: row.clerkUserId, email: row.email, name: row.name, role: row.role as Role, orgId: row.orgId, credits: row.credits };
}

export type OperatorGuard =
  | { ok: true; profile: PlatformProfile }
  | { ok: false; status: 401 | 403; error: string };

/** Route-handler guard: signed in AND operator role. */
export async function requireOperator(): Promise<OperatorGuard> {
  const profile = await getProfile();
  if (!profile) {
    return { ok: false, status: 401, error: "Sign in required — open the sign-in page." };
  }
  if (profile.role !== "operator") {
    return { ok: false, status: 403, error: "Operator access required — demo accounts cannot run the platform." };
  }
  return { ok: true, profile };
}

/** Metered deduction after a successful intervention. Returns the remaining balance. */
export async function deductCredit(clerkUserId: string): Promise<number> {
  const row = await db.userProfile.update({
    where: { clerkUserId },
    data: { credits: { decrement: 1 } },
    select: { credits: true },
  });
  return row.credits;
}
