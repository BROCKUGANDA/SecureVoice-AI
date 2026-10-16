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
import { isDemoAccount } from "@/lib/demo-account";
import { logError } from "@/lib/validation/safe-log";

export type Role = "operator" | "demo";

/**
 * Better Auth's membership role, resolved into this module's two values.
 *
 * This used to be `membershipRole as Role` — a cast that turned "owner" into
 * "operator" by assertion. It was not wrong, it was unchecked: TypeScript accepted
 * a string from another vocabulary, every member row written by Better Auth is
 * `owner`/`admin`/`member`, and the next line of the program is
 * `requireOperator()`'s `profile.role !== "operator"` — so the day a real
 * membership exists, EVERY institution admin starts answering 403 on settings,
 * billing, seats, documents and the guardrail surface, and the console shows a
 * paying bank "Operator access required" while it is signed in as the Owner.
 *
 * It has stayed invisible because this deployment's `member` table is empty: the
 * fallback branch below has been the only one ever taken. An unexercised branch
 * of an authorisation check is not a low-risk branch, it is an untested one.
 *
 * ── The mapping, and why it goes this way ────────────────────────────────────
 * `operator` is "this person administers the institution" (the 403 message says
 * exactly that), so it maps to the roles that can change an organisation:
 * `owner` and `admin`. A plain `member` is a console user who is not the
 * institution's administrator, and an unknown or empty role gets the least
 * privileged answer rather than the convenient one — a typo'd role in the
 * provider must not read as an admin. `ServiceAccount` is a machine identity
 * authenticated by a producer key; honouring it on a browser session is refused
 * by the same reasoning in `src/lib/identity/session-role-map.ts`.
 *
 * The name `demo` is legacy and is kept because 45 call sites read it. It means
 * "signed in, not an institution administrator", and the console renders a Demo
 * Mode badge for it — see `requireSignedIn`.
 */
export function roleFromMembership(membershipRole: string | null, orgId: string | null): Role {
  if (membershipRole === null) {
    // No membership row consulted: an org-less session is the shared demo
    // workspace; a session WITH an active org but no member row is the pre-
    // Better-Auth shape this file was written against, and stays an operator so
    // the existing pilot logins keep working the day memberships are introduced.
    return orgId ? "operator" : "demo";
  }
  switch (membershipRole.toLowerCase()) {
    case "owner":
    case "admin":
      return "operator";
    default:
      return "demo";
  }
}

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
  // Mapped, never cast: see `roleFromMembership`. A value from Better Auth's
  // vocabulary is not a `Role` because the compiler was told to believe it is.
  const role: Role = roleFromMembership(membershipRole, orgId);

  // Demo confinement. The one-click demo credential is PUBLIC by design (it
  // ships in the sign-in bundle), so it must never resolve to anything but the
  // demo seat — even if the address somehow holds an Owner/Admin membership
  // row. The membership is ignored entirely (not downgraded: there is no
  // "demo Owner"), and the org pointer is dropped with it, because an org
  // pointer on a demo session is what would let tenant-scoped reads resolve.
  // Applied BEFORE the mirror upsert so the stored row agrees with what every
  // reader of this function enforces, and before the wallet lookup so a demo
  // session never reads an organisation's balance.
  const demo = isDemoAccount(email);
  const effectiveRole: Role = demo ? "demo" : role;
  const effectiveOrgId: string | null = demo ? null : orgId;

  // Demo sessions are admitted only with a live queue lease HELD BY THIS SESSION.
  // This is what closes the manual-form bypass: signing in with the published
  // password outside `/api/demo/enter` mints a session that never redeemed a
  // seat, and that session resolves to signed-out here — the holder joins the
  // line like everyone else. Returning null (rather than a degraded profile) is
  // what sends the shell to the sign-in view instead of rendering a console with
  // no data.
  //
  // Keyed on `session.session.id`, NOT on the user id. The demo credential is one
  // published account, so every admitted browser shares a single user id and a
  // user-keyed lookup returned whichever seat was live for that account — which
  // meant one judge's seat also admitted every other judge's browser. The capacity
  // bound is N seats, N sessions, and a session with no seat of its own is
  // refused; legitimate concurrency is untouched.
  //
  // A missing DemoSeat table (migration not yet applied) fails OPEN with a loud
  // log: bricking every demo login on a partially-migrated deploy is worse than
  // an unenforced queue, and the condition is self-repairing on the next deploy.
  // Any other store error propagates — a database outage must not silently
  // unbind capacity.
  if (demo) {
    try {
      const { leaseForSession } = await import("@/lib/demo-queue");
      const lease = await leaseForSession(session.session.id);
      if (!lease) return null;
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2021") {
        logError("[auth] DemoSeat table missing — demo queue unenforced until migrated", {});
      } else {
        throw err;
      }
    }
  }

  const row = await db.userProfile.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      email,
      name,
      role: effectiveRole,
      orgId: effectiveOrgId,
      credits: effectiveRole === "operator" ? 500 : 25,
    },
    // Role and org follow the session (never self-granted locally); credits are
    // wallet state and are deliberately NOT touched here.
    update: { email, name, role: effectiveRole, orgId: effectiveOrgId },
  });

  // The org wallet is the tenant's balance; the profile wallet is the
  // org-less fallback. Both are read fresh here because a switch of active
  // organization must change what the console shows WITHOUT a sign-out: the
  // session cookie is re-issued with the new activeOrganizationId, and this
  // is the request that discovers it.
  let credits = row.credits;
  let walletScope: "org" | "user" = "user";
  if (effectiveOrgId) {
    const org = await db.organization.findUnique({
      where: { id: effectiveOrgId },
      select: { credits: true },
    });
    credits = org?.credits ?? 0;
    walletScope = "org";
  }

  return {
    userId: row.userId,
    email: row.email,
    name: row.name,
    // Normalised, not cast. `userProfile.role` is a free-form TEXT column, and a
    // row written by the old `membershipRole as Role` would have stored the
    // literal "owner" — which `requireOperator()` then reads as "not an operator"
    // and 403s forever, with no way to repair it from the console. Anything that
    // is not exactly the operator value is not an operator.
    role: row.role === "operator" ? "operator" : "demo",
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
/**
 * ── DEPRECATED: wallet primitives, no longer on any metered path ─────────────
 * `deductCredit()` and `refundCredit()` below move a wallet balance and nothing
 * else: they do not know whether the run being paid for is one anyone is
 * BILLING for, they write no `UsageLedger` row, and they audit with a fixed
 * `wallet_debited` intent that cannot record why a movement was free.
 *
 * The only production caller of either was `/api/console/fire`, and it no longer
 * uses them — `src/lib/billing/charge-mode.ts`'s `claimRun()` / `refundRun()`
 * replaced it, because a demo session must be metered WITHOUT being charged and a
 * paid run's wallet movement and ledger reservation have to land together.
 *
 * They are kept, exported and tested rather than deleted, for one reason: they are
 * the primitive whose `updateMany({ where: { credits: { gt: 0 } } })` is the
 * atomicity argument that `claimRun`'s identical decrement relies on, and
 * `tests/billing/spend-wallet.test.ts` asserts that behaviour against them
 * directly. If they are being changed, that test is the specification.
 *
 * Do NOT reintroduce them onto a metered path. The rule they cannot express is
 * "this run is free, and here is the record of why".
 */
/**
 * Announce a wallet movement on the realtime org channel.
 *
 * Why this exists: the console's wallet chip only moved when the operator's own
 * `fire()` call returned a balance. So an intervention fired by a COLLEAGUE, by
 * a webhook, or by a queue worker left the on-screen balance stale until the next
 * refetch — which on a multi-analyst desk means two people see different wallets
 * from the same tenant. One credit movement is now an event, so the tenant's own
 * balance is the source of truth for everyone looking at it.
 *
 * Fire-and-forget on purpose: this is a notification about money that has ALREADY
 * moved and been audited. A realtime outage must never fail, delay or roll back a
 * charge, so a publish failure is swallowed rather than propagated.
 */
async function announceCredit(
  userId: string,
  orgId: string | null,
  remaining: number,
  scope: "org" | "user",
  reason: string,
  refunded = false,
): Promise<void> {
  if (!orgId) return; // the org channel is the only subscriber surface
  try {
    const { notifyRealtime } = await import("@/lib/realtime");
    await notifyRealtime({
      orgId,
      // The org channel is what the console joins for tenant-wide activity; an
      // empty callRef keeps the case channels clean of wallet events.
      callRef: "",
      payload: {
        type: "credit.deducted",
        call_id: "",
        ts: Date.now(),
        data: { remaining, scope, reason, ...(refunded ? { refunded: true } : {}) },
      },
    });
  } catch (err) {
    logError("[credits] could not announce the wallet movement", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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
    await auditWallet(
      userId,
      "wallet_debited",
      remaining,
      "1 credit consumed by an intervention",
      orgId,
    );
    // Announced AFTER the balance is read, so a subscriber that repaints from the
    // event sees the same number the row holds. Emitting before the read would let
    // a client render a balance that is one credit optimistic.
    void announceCredit(userId, orgId ?? null, remaining, "org", "intervention_fired");
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
    // A refund is announced too, and flagged as one. The console shows the
    // balance it was actually given, so an operator who fires, gets refused and
    // sees the credit come back has a single, coherent story — rather than a
    // balance that quietly appears wrong for one request.
    void announceCredit(userId, orgId, row.credits, "org", "intervention_refunded", true);
    return row.credits;
  }

  const row = await db.userProfile.update({
    where: { userId },
    data: { credits: { increment: 1 } },
    select: { credits: true },
  });
  await auditWallet(
    userId,
    "wallet_refunded",
    row.credits,
    "credit returned: intervention not accepted",
  );
  return row.credits;
}
