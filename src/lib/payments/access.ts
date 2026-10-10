import "server-only";
import { db } from "@/lib/db";

/**
 * Does this subscription currently grant paid access?
 *
 * THE RULE, stated once so no caller re-derives it:
 *
 *   `active` and `trialing` grant access.
 *   `past_due` and `paused` are OPERATOR decisions — see below.
 *   `canceled` does not.
 *
 * ## A SCHEDULED CHANGE IS NOT A CHANGE
 *
 * This is the behaviour the brief asks for explicitly, and it is the one most
 * likely to be got wrong. A subscription whose status is `active` but which
 * carries `scheduledChangeAction: "cancel"` and a `scheduledChangeAt` in the
 * future is STILL PAID FOR. The customer has asked to stop at the end of the
 * period; they have not stopped, and they have paid through the end of it.
 *
 * Revoking on the scheduled change would take the product away from a customer
 * mid-period they already funded — and it would do so silently, at the moment
 * they exercised exactly the self-service right the portal exists to give them.
 * `hasPaidAccess` therefore reads `status` and ignores the scheduled fields
 * entirely. They are mirrored for display and for the portal, never for access.
 *
 * ## `past_due` and `paused`
 *
 * Both are treated as granting access for now, which is a deliberate commercial
 * choice rather than an oversight:
 *
 *   `past_due` — a failed renewal. Paddle will retry with its dunning ladder;
 *      cutting off a bank's fraud-intervention line on a declined card while
 *      retries are still running would interrupt live voice work. Access stays
 *      on and the operator is warned.
 *   `paused`  — a Pause, which the customer invoked. Same reasoning: they asked
 *      to stop being billed, not necessarily to stop using the product, and the
 *      distinction is theirs to make.
 *
 * Both are LOUD rather than silent: `isAtRisk` and `needsAttention` exist so a
 * caller cannot accidentally treat them as plain `active`. Change these two
 * deliberately — they are the difference between "the card failed" and
 * "the customer left".
 */

/** Paddle subscription statuses that grant access. */
const GRANTING: ReadonlySet<string> = new Set(["active", "trialing"]);

/** Gracious access — live, but something needs an operator's attention. */
const GRACEFUL: ReadonlySet<string> = new Set(["past_due", "paused"]);

export type AccessDecision = {
  granted: boolean;
  /** Why. Stable string, safe to log and to show a customer. */
  reason: AccessReason;
  /** True when access is granted but something is wrong. Never ignore this. */
  needsAttention: boolean;
};

export type AccessReason =
  "no_subscription" | "canceled" | "unknown_status" | "active" | "trialing" | "past_due" | "paused";

/**
 * Decide access from a subscription STATUS alone.
 *
 * Deliberately takes no `scheduledChange*` argument: accepting one would invite a
 * caller to pass it in and revoke on it, which is the bug this function exists to
 * make unrepresentable.
 */
export function decideAccess(status: string | null | undefined): AccessDecision {
  if (!status) return { granted: false, reason: "no_subscription", needsAttention: false };
  if (status === "canceled") return { granted: false, reason: "canceled", needsAttention: false };
  if (GRANTING.has(status)) {
    return { granted: true, reason: status as AccessReason, needsAttention: false };
  }
  if (GRACEFUL.has(status)) {
    return { granted: true, reason: status as AccessReason, needsAttention: true };
  }
  // An UNKNOWN status fails closed. Paddle adding a status this build has never
  // seen must not become "grant everything" by falling through a default.
  return { granted: false, reason: "unknown_status", needsAttention: false };
}

/** Boolean form, for the common `if (hasPaidAccess(...))` call site. */
export function hasPaidAccess(status: string | null | undefined): boolean {
  return decideAccess(status).granted;
}

/** True when access is granted but the subscription needs an operator's eye. */
export function isAtRisk(status: string | null | undefined): boolean {
  return decideAccess(status).needsAttention;
}

/**
 * The newest mirror row for an org, or null.
 *
 * Scoped through `scopedDb`, so it cannot resolve another org's subscription —
 * `subscriptionId` is globally unique and an unscoped read would happily return
 * anyone's row from the id alone.
 */
export async function currentSubscription(orgId: string): Promise<{
  subscriptionId: string;
  status: string;
  priceId: string;
  productId: string;
  scheduledChangeAction: string | null;
  scheduledChangeAt: Date | null;
  currentPeriodEnd: Date | null;
} | null> {
  const rows = await db.paddleSubscription.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      subscriptionId: true,
      status: true,
      priceId: true,
      productId: true,
      scheduledChangeAction: true,
      scheduledChangeAt: true,
      currentPeriodEnd: true,
    },
  });
  return rows[0] ?? null;
}

/** Access AND the row that decided it, so a caller can show why. */
export async function accessFor(orgId: string): Promise<
  AccessDecision & {
    subscription: {
      subscriptionId: string;
      status: string;
      priceId: string;
      productId: string;
      scheduledChangeAt: Date | null;
      currentPeriodEnd: Date | null;
    } | null;
  }
> {
  const sub = await currentSubscription(orgId);
  if (!sub)
    return { granted: false, reason: "no_subscription", needsAttention: false, subscription: null };
  const decision = decideAccess(sub.status);
  return { ...decision, subscription: sub };
}
