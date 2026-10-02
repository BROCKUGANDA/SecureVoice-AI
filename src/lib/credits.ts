import "server-only";
/**
 * Clerk-backed platform profile + prepaid credits wallet.
 *
 * Identity lives in Clerk (operator+clerk_test@securevoice.ae /
 * demo+clerk_test@securevoice.ae and any self-serve sign-up). This module
 * mirrors each Clerk user into a local
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
import { append as auditAppend } from "@/lib/audit-chain";
import type { Lang } from "@/lib/config";

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

/** Route-handler guard: any authenticated session (single-app strategy —
 *  demo-role users share the Command Center under a Demo Mode badge). */
export async function requireSignedIn(): Promise<OperatorGuard> {
  const profile = await getProfile();
  if (!profile) {
    return { ok: false, status: 401, error: "Sign in required — open the sign-in page." };
  }
  return { ok: true, profile };
}

/** Route-handler guard: operator role only (settings, billing, seats). */
export async function requireOperator(): Promise<OperatorGuard> {
  const profile = await getProfile();
  if (!profile) {
    return { ok: false, status: 401, error: "Sign in required — open the sign-in page." };
  }
  if (profile.role !== "operator") {
    return { ok: false, status: 403, error: "Operator access required — this area is for the institution admin." };
  }
  return { ok: true, profile };
}

/**
 * Record a wallet movement in the audit chain.
 *
 * Credits are money: every decrement and every refund is a balance change, and
 * "the balance went down and nobody can say why" is the first question any
 * auditor asks about a metered system. Fire-and-forget by design — a failing
 * audit write must never block the intervention it describes — but it is
 * written on every path, including the failed-wallet path.
 */
async function auditWallet(clerkUserId: string, intent: string, credits: number, note: string): Promise<void> {
  await auditAppend({
    callRef: `WALLET-${clerkUserId.slice(0, 24)}`,
    action: "consent",
    intent,
    callerId: clerkUserId,
    redactedText: note,
    meta: { credits, clerkUserId },
  }).catch((err) => {
    console.error("[credits] wallet audit append failed:", err instanceof Error ? err.message : err);
  });
}

/**
 * Metered deduction after a successful intervention. Returns the remaining
 * balance, or -1 when the wallet was already empty. The `credits > 0`
 * condition makes the check-and-decrement ATOMIC in the database — two
 * concurrent fires of a 1-credit wallet cannot both succeed and drive the
 * balance negative.
 */
export async function deductCredit(clerkUserId: string): Promise<number> {
  const r = await db.userProfile.updateMany({
    where: { clerkUserId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  if (r.count === 0) {
    await auditWallet(clerkUserId, "wallet_exhausted", 0, "deduct refused: wallet empty");
    return -1;
  }
  const row = await db.userProfile.findUnique({
    where: { clerkUserId },
    select: { credits: true },
  });
  const remaining = row?.credits ?? -1;
  await auditWallet(clerkUserId, "wallet_debited", remaining, "1 credit consumed by an intervention");
  return remaining;
}

/**
 * Return a previously deducted credit (the upstream action it paid for never
 * happened). Atomic increment; pairs with deductCredit's claim-before-spend.
 */
export async function refundCredit(clerkUserId: string): Promise<number> {
  const row = await db.userProfile.update({
    where: { clerkUserId },
    data: { credits: { increment: 1 } },
    select: { credits: true },
  });
  await auditWallet(clerkUserId, "wallet_refunded", row.credits, "credit returned: intervention not accepted");
  return row.credits;
}
