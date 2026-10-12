import "server-only";
import { db } from "@/lib/db";
import { logWarn } from "@/lib/validation/safe-log";

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
 * The read is filtered by `orgId`, and `orgId` comes from the session at every
 * call site — never from a request body. `subscriptionId` is globally unique, so
 * a lookup by id alone would resolve another tenant's row; going org-first is what
 * keeps the id unguessable from the outside.
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

/**
 * May this tenant place a NEW outbound intervention call?
 *
 * A DIFFERENT question from `decideAccess` above, which asks whether they may use
 * the product they paid for. The two deliberately disagree on `paused`, and one
 * module owns both so the disagreement is visible rather than accidental:
 *
 *   `paused` blocks dialling. A pause is the customer turning the dialler off as
 *     well as the invoice: nothing else in the system knows that decision, the
 *     credits are still in the ledger, consent is still valid, and the calling-hour
 *     gate would happily place the call. Without this the tenant keeps calling
 *     their own customers on a carrier account that stopped billing them.
 *   `past_due` does NOT block. Paddle's dunning ladder runs for up to about two
 *     weeks, and cutting off a bank mid-incident because a card expired on a Friday
 *     night is a worse outcome than an invoice that may still be collected. That
 *     is the same call `decideAccess` makes, for the same reason.
 *   `canceled` does NOT block either: a tenant who cancelled at period end keeps
 *     the prepaid credits they already bought, and stranding paid-for credits to
 *     punish a cancellation is not a wallet policy a bank will trust. They spend
 *     down, then stop.
 *   No subscription row at all does NOT block. The reference deployment, a
 *     self-hosted pilot and a manual bank-transfer tenant have no Paddle mirror row
 *     by definition, so absence cannot mean revocation — the ledger and the budget
 *     breaker are the authority for them.
 *
 * Read-only, and the conservative direction on failure is the one that keeps
 * protecting customers: an unreadable billing state allows the dial and is logged,
 * which is safe precisely because `paused` is a preference and not a security
 * boundary.
 */
const BLOCKS_DIALLING: ReadonlySet<string> = new Set(["paused"]);

export type DiallingAccess =
  { allowed: true; status: string | null } | { allowed: false; status: string; reason: string };

export async function diallingBlockedFor(orgId: string | null): Promise<DiallingAccess> {
  if (!orgId) return { allowed: true, status: null };
  try {
    const sub = await currentSubscription(orgId);
    if (!sub) return { allowed: true, status: null };
    if (BLOCKS_DIALLING.has(sub.status)) {
      return {
        allowed: false,
        status: sub.status,
        reason: "this organisation's subscription is paused",
      };
    }
    return { allowed: true, status: sub.status };
  } catch (err) {
    logWarn("[billing-access] subscription state unreadable — allowing the dial", {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: true, status: null };
  }
}

/** Boolean form, for the `if (...) refuse(thisSignal)` call site in the gate. */
export async function mayDialFor(orgId: string | null): Promise<boolean> {
  return (await diallingBlockedFor(orgId)).allowed;
}
