import "server-only";
/**
 * Platform profile + prepaid credits wallet.
 *
 * Identity lives in Better Auth (src/lib/better-auth.ts). This module mirrors
 * each authenticated Better Auth user into a local UserProfile row that carries
 * the billing state:
 *
 *   1 credit = 1 intervention signal fired (the metered ElevenLabs/Twilio cost)
 *   operator accounts sync in with 500 credits · everyone else 25
 *
 * Every console request calls getProfile(): it syncs identity fields from the
 * Better Auth session and returns the credit balance the guard then enforces —
 * 402 once the wallet hits zero.
 *
 * ── Where the tenant comes from ──────────────────────────────────────────────
 * The organization IS the tenant (hazard AU-3): there is no parallel tenant
 * table, so `session.activeOrganizationId` is the single server-derived tenant
 * identity. It is NEVER read from a header, a query parameter or a request body.
 *
 * ── Where the role comes from ────────────────────────────────────────────────
 * Better Auth has no `publicMetadata.role`, which is what this used to read.
 * The role is taken from the organization membership the session carries, and
 * defaults to `demo` when there is none. A caller cannot grant themselves
 * `operator` by editing a field on their own user row, because the value comes
 * from the membership record, not from the user record.
 */

import { headers } from "next/headers";
import { auth } from "@/lib/better-auth";
import { db } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";
import type { Lang } from "@/lib/config";
import { logError } from "@/lib/validation/safe-log";

export type Role = "operator" | "demo";

export type PlatformProfile = {
  userId: string;
  email: string;
  name: string;
  role: Role;
  orgId: string | null;
  credits: number;
  // Which wallet `credits` came from. The organization is the tenant, so an
  // org-scoped wallet is the normal operating mode; the per-user wallet on
  // UserProfile is the fallback for sessions with no active organization.
  walletScope: "org" | "user";
};

/**
 * Sync the authenticated Better Auth session into the local wallet.
 *
 * Returns null when signed out.
 *
 * `auth.api.getSession({ headers })` is the AUTHORITATIVE check: it reads the
 * session row from the database. The cookie cache is deliberately not consulted
 * here (hazard AU-4) — a revoked session or a demoted operator must fail on the
 * very next request, not when the five-minute cache happens to expire.
 */
export async function getProfile(): Promise<PlatformProfile | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  const user = session.user;
  const email = user.email ?? "unknown";
  // `split` always yields at least one element, so element 0 is the local part;
  // the `?? email` fallback keeps the value honest if `email` is ever empty
  // rather than asserting an index that can be missing.
  const name = user.name || (email.split("@")[0] ?? email);

  // The organization IS the tenant. `activeOrganizationId` is set by the
  // organization plugin when the user switches org; null means "no tenant".
  const orgId = session.session.activeOrganizationId ?? null;

  // Role from the MEMBERSHIP record, not from anything on the user row, so it
  // cannot be self-granted by editing a field on one's own user record.
  //
  // `getActiveMember` is the documented server call and returns the member row
  // for the ACTIVE organization — which is why it must only be consulted once
  // `orgId` is known. There is deliberately no fallback that reads a role off
  // the user row: that is exactly the self-grant this avoids.
  let membershipRole: string | null = null;
  if (orgId) {
    const member = await auth.api.getActiveMember({ headers: await headers() });
    membershipRole = member?.role ?? null;
  }
  const role: Role = membershipRole ? (membershipRole as Role) : orgId ? "operator" : "demo";

  const row = await db.userProfile.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      email,
      name,
      role,
      orgId,
      credits: role === "operator" ? 500 : 25,
    },
    // Role and org follow the session (never self-granted locally); credits are
    // wallet state and are deliberately NOT touched here.
    update: { email, name, role, orgId },
  });

  // The org wallet is the tenant's balance; the profile wallet is the
  // org-less fallback. Both are read fresh here because a switch of active
  // organization must change what the console shows WITHOUT a sign-out: the
  // session cookie is re-issued with the new activeOrganizationId, and this
  // is the request that discovers it.
  let credits = row.credits;
  let walletScope: "org" | "user" = "user";
  if (orgId) {
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { credits: true },
    });
    credits = org?.credits ?? 0;
    walletScope = "org";
  }

  return {
    userId: row.userId,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    orgId: row.orgId,
    credits,
    walletScope,
  };
}

export type OperatorGuard =
  { ok: true; profile: PlatformProfile } | { ok: false; status: 401 | 403; error: string };

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
    return {
      ok: false,
      status: 403,
      error: "Operator access required — this area is for the institution admin.",
    };
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
async function auditWallet(
  userId: string,
  intent: string,
  credits: number,
  note: string,
  orgId?: string | null,
): Promise<void> {
  await auditAppend({
    callRef: `WALLET-${userId.slice(0, 24)}`,
    action: "consent",
    intent,
    callerId: userId,
    redactedText: note,
    meta: { credits, userId, ...(orgId ? { orgId } : {}) },
    orgId: orgId ?? undefined,
  }).catch((err) => {
    logError("[credits] wallet audit append failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Metered deduction after a successful intervention. Returns the remaining
 * balance, or -1 when the wallet was already empty. The `credits > 0`
 * condition makes the check-and-decrement ATOMIC in the database — two
 * concurrent fires of a 1-credit wallet cannot both succeed and drive the
 * balance negative.
 *
 * WHICH WALLET: `orgId` selects the organization wallet (the tenant's, the
 * normal operating mode); without it the caller's own profile wallet is
 * debited. An org session must never spend the operator's personal credits
 * and vice versa — that is how one tenant's usage ends up on another's bill.
 */
export async function deductCredit(userId: string, orgId?: string | null): Promise<number> {
  if (orgId) {
    const r = await db.organization.updateMany({
      where: { id: orgId, credits: { gt: 0 } },
      data: { credits: { decrement: 1 } },
    });
    if (r.count === 0) {
      await auditWallet(userId, "wallet_exhausted", 0, "deduct refused: wallet empty", orgId);
      return -1;
    }
    const row = await db.organization.findUnique({
      where: { id: orgId },
      select: { credits: true },
    });
    const remaining = row?.credits ?? -1;
    await auditWallet(userId, "wallet_debited", remaining, "1 credit consumed by an intervention", orgId);
    return remaining;
  }

  const r = await db.userProfile.updateMany({
    where: { userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });
  if (r.count === 0) {
    await auditWallet(userId, "wallet_exhausted", 0, "deduct refused: wallet empty");
    return -1;
  }
  const row = await db.userProfile.findUnique({
    where: { userId },
    select: { credits: true },
  });
  const remaining = row?.credits ?? -1;
  await auditWallet(userId, "wallet_debited", remaining, "1 credit consumed by an intervention");
  return remaining;
}

/**
 * Return a previously deducted credit (the upstream action it paid for never
 * happened). Atomic increment; pairs with deductCredit's claim-before-spend.
 * Targets the SAME wallet the deduction came from — passing the orgId the
 * deduction used is what makes the pair balance.
 */
export async function refundCredit(userId: string, orgId?: string | null): Promise<number> {
  if (orgId) {
    const row = await db.organization.update({
      where: { id: orgId },
      data: { credits: { increment: 1 } },
      select: { credits: true },
    });
    await auditWallet(
      userId,
      "wallet_refunded",
      row.credits,
      "credit returned: intervention not accepted",
      orgId,
    );
    return row.credits;
  }

  const row = await db.userProfile.update({
    where: { userId },
    data: { credits: { increment: 1 } },
    select: { credits: true },
  });
  await auditWallet(userId, "wallet_refunded", row.credits, "credit returned: intervention not accepted");
  return row.credits;
}
