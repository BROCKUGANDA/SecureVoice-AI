"use client";

import { useSession, authClient } from "@/lib/auth-client";
import { seatForSession, type Seat } from "@/lib/auth/seat";

/**
 * The signed-in seat, read from the ORGANIZATION MEMBERSHIP.
 *
 * ## Why the membership and not `activeOrganizationId`
 *
 * The expression this replaces was `activeOrganizationId ? "operator" : undefined`,
 * which is a null check on the tenant pointer rather than a role check. It called
 * every seat with a tenant an operator — including an `Analyst`, whose server
 * routes reject the Settings writes the nav was offering — and called a tenant-less
 * session nobody at all. `seatFromMembershipRole` reads the membership row instead,
 * which is the same record `getProfile()` (src/lib/credits.ts) resolves on the
 * server, so the nav and the API now answer from one source.
 *
 * ## Why this is a UI AFFORDANCE, not a gate
 *
 * Every route re-checks server-side (`requireSignedIn` / `requireOperator`, and
 * `roleHas()` against the matrix in src/lib/auth/roles.ts). A seat computed in the
 * browser can therefore only ever HIDE a control — it can never grant one. That is
 * the only safe direction for a client-side decision, and it is why this hook may
 * be optimistic while loading without becoming a vulnerability.
 *
 * ## While it resolves
 *
 * `seat` is `null` until the membership has been read, and callers must treat that
 * as "not known yet" rather than "not permitted". Two reasons:
 *
 *  · Flicker. Defaulting to `judge` during the load hides the operator nav for a
 *    frame and then reveals it, which reads as a glitch on every navigation.
 *  · The org-switch bounce. `setActive` refetches the session and the membership
 *    together. For the duration, `activeOrganizationId` is briefly absent — and
 *    the old gate read that absence as "signed out" and bounced the operator to
 *    the sign-in screen mid-switch. See the RBAC gate in src/app/page.tsx.
 *
 * So: signed-out is `seat === null && session resolved with no user`, and
 * "still loading" is distinguished from it by `isLoading`.
 */
export interface ViewerSeat {
  /** The audience this session belongs to, or null while unresolved. */
  seat: Seat | null;
  /** True once the session itself has resolved (signed in or definitively out). */
  sessionResolved: boolean;
  /** True until the membership role is known. */
  isLoading: boolean;
  /** Convenience: a confirmed signed-in human. */
  isSignedIn: boolean;
  /** The active organization id, null when the session has no tenant. */
  activeOrganizationId: string | null;
  /**
   * The user object, passed through so a caller does not have to call
   * `useSession()` a second time. Two `useSession()` calls are two subscriptions
   * to the same atom and two chances for the header and the gate to disagree
   * about whether there is a session.
   */
  user: { name?: string | null; email?: string | null; image?: string | null } | undefined;
}

export function useViewerSeat(): ViewerSeat {
  const { data: session, isPending } = useSession();
  // The plugin's own query atom. It refetches on `$activeMemberSignal`, which
  // `organization.setActive` signals — so a tenant switch updates it without any
  // component being responsible for asking.
  const { data: member, isPending: memberPending } = authClient.useActiveMember();

  const user = session?.user;
  const isSignedIn = Boolean(user);
  const activeOrganizationId = session?.session?.activeOrganizationId ?? null;

  // The membership carries `role`, but only once a tenant is active: with no
  // `activeOrganizationId` there is no membership row to read, and the query
  // resolves to null. `seatForSession` maps that null to `judge`, which is
  // the right answer for a tenant-less session (see the doc comment there) —
  // and confines a demo address to `judge` regardless of membership, so the
  // public one-click credential can never borrow a working seat.
  const seat: Seat | null = isPending
    ? null
    : isSignedIn
      ? seatForSession(
          (member as { role?: string | null } | null)?.role ?? null,
          user?.email ?? null,
        )
      : null;

  return {
    seat,
    sessionResolved: !isPending,
    isLoading: Boolean(isPending || (isSignedIn && memberPending && !member)),
    isSignedIn,
    activeOrganizationId,
    user,
  };
}
