import "server-only";
/**
 * Seat caps — the commercial limit on how many people a plan may hold.
 *
 * ## What a seat is counted against
 *
 * `listOrgMembers()` from `src/lib/auth/identity.ts`, which is the SAME read
 * `GET /api/auth/invites` answers with. One counter, one list: if the cap were
 * computed from a different source than the members table the operator is
 * looking at, the refusal would read as a bug to the person receiving it.
 *
 * The Owner counts. Starter publishes "One named seat", which therefore means
 * one person total — not one more person after the owner. A cap that excluded
 * the owner would silently sell one seat more than the page advertises.
 *
 * ## Enforced at both ends, on purpose
 *
 *   · at ISSUE — an operator who has filled the plan cannot mint an invitation
 *     that will be refused. This is the legible place to say "upgrade".
 *   · at REDEMPTION — the case issuance cannot catch: a tenant on Growth (5
 *     seats) can be downgraded to Starter (1) while invitations sit unconsumed
 *     for their full 72-hour TTL. Without this second check, every invite already
 *     in an email would still create an account, and the cap would be a display
 *     limit rather than a limit.
 *
 * The redemption check runs BEFORE the invite is consumed, so a refused
 * invitation is not destroyed: it stays usable and becomes redeemable the moment
 * a seat frees. Burning a credential because of the TENANT's billing state would
 * make an unrecoverable thing out of a recoverable one.
 *
 * ## It fails open, and that is the right direction
 *
 * No resolvable plan means no cap (`seats: null`), and a billing read that
 * throws means no cap. A seat limit is a commercial ceiling, not a security
 * boundary: the failure mode being protected against is an unpaid tenant
 * employing more analysts than they bought, and the failure mode caused by
 * enforcing it blindly is a bank's administrator locked out of their own console
 * because a webhook mirror is behind. Security controls in this codebase fail
 * closed (`planTierFor`, `requireOperator`, RLS); this one deliberately does not,
 * and `seatFacts()` returns the source so an operator can tell "unlimited" from
 * "we could not tell".
 */

import { listOrgMembers } from "@/lib/auth/identity";
import { orgPlanContext } from "./plan-context";

export type SeatFacts = {
  orgId: string | null;
  /** Seats the plan allows. `null` = unlimited, including "no plan resolved". */
  seats: number | null;
  /** Current member count, from the same list the console shows. */
  members: number;
  /** The plan the cap came from, or null when nothing named one. */
  plan: string | null;
  /** `seats - members`, or null when unlimited. Can be negative — see `atOrOverCap`. */
  remaining: number | null;
  /**
   * True when an organisation ALREADY has more members than its plan allows.
   *
   * A downgrade leaves tenants here. Nobody is removed because of it — the cap
   * refuses NEW invitations and never revokes an existing account — but the
   * console must be able to say "you are over your plan's seats" rather than
   * "0 seats remaining", which would read like a bug.
   */
  atOrOverCap: boolean;
};

/** The cap for one organisation, read from the live member list. */
export async function seatFacts(orgId: string | null | undefined): Promise<SeatFacts> {
  const unlimited = { seats: null, remaining: null, atOrOverCap: false } as const;

  // An org-less session has no tenant that bought a plan, so there is nothing to
  // cap it by. `NO_ORG` shares the identity namespace with seeded org-less rows,
  // and a limit there would be a limit on nobody's subscription.
  if (!orgId) return { orgId: null, members: 0, plan: null, ...unlimited };

  // Neither read depends on the other's RESULT, so they run together: the plan
  // read touches the Paddle mirror and the tenant row, the member read touches
  // the identity store.
  const [ctx, members] = await Promise.all([orgPlanContext(orgId), listOrgMembers(orgId)]);

  if (ctx.seats === null) {
    return { orgId, members: members.length, plan: ctx.plan, ...unlimited };
  }
  return {
    orgId,
    members: members.length,
    seats: ctx.seats,
    plan: ctx.plan,
    remaining: ctx.seats - members.length,
    atOrOverCap: members.length >= ctx.seats,
  };
}

export type SeatGate =
  | { ok: true; facts: SeatFacts }
  | { ok: false; facts: SeatFacts; code: "seat_limit_reached"; message: string };

/**
 * May this organisation add one more member?
 *
 * The message is written for the person being refused: what the plan is, what it
 * allows, how many are already there, and that the way forward is a bigger plan
 * rather than a retry.
 */
export async function seatGate(orgId: string | null | undefined): Promise<SeatGate> {
  const facts = await seatFacts(orgId);
  if (facts.seats === null) return { ok: true, facts };
  if (facts.members < facts.seats) return { ok: true, facts };

  const planLabel = facts.plan ? facts.plan : "this plan";
  const seats = facts.seats;
  return {
    ok: false,
    facts,
    code: "seat_limit_reached",
    message:
      facts.members > seats
        ? `This organization has ${facts.members} members, which is more than ${planLabel} allows (${seats}). No invitation will be issued or redeemed until it is back inside its plan — existing members keep their access.`
        : `${planLabel} allows ${seats} seat${seats === 1 ? "" : "s"} and all ${facts.members} are used. Upgrade the plan to invite more people.`,
  };
}
