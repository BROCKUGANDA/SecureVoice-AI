import "server-only";
import { db } from "@/lib/db";

/**
 * Mirror verified Paddle events into `PaddleCustomer` / `PaddleSubscription`.
 *
 * ## Idempotency is the whole design
 *
 * Paddle deliveries are AT-LEAST-ONCE and may arrive OUT OF ORDER. Every write
 * here is an UPSERT keyed on the Paddle id (`ctm_...` / `sub_...`), never an
 * insert. Three properties follow from that and they are the point:
 *
 *   - A re-sent event is a no-op rather than a duplicate row or a crash on the
 *     unique index.
 *   - An out-of-order `subscription.updated` arriving before the `.created` is
 *     still correct: the upsert writes the row either way, and the later event
 *     reconciles it. An insert-first design would fail on the constraint.
 *   - A replay after a cancel cannot resurrect a subscription the operator
 *     cancelled, because we only ever move FORWARD on status...
 *
 * ...with one exception, stated explicitly because it is the dangerous case: a
 * `subscription.updated` carrying `status: "active"` arriving LATE, after a
 * `subscription.canceled` was already applied, WILL overwrite `canceled` with
 * `active`. That is Paddle's own ordering answer — a later event means a later
 * state — and it is why `updatedAt` is recorded. If that resurrection is wrong
 * for this business, the fix is a monotonic-status rule, not a blind upsert, and
 * it is a decision for whoever owns the billing lifecycle.
 *
 * ## `scheduledChange*` is mirrored but never collapses into `status`
 *
 * See `src/lib/payments/access.ts` for why a scheduled cancellation must not
 * revoke access.
 */

export type PaddleCustomerInput = {
  customerId: string;
  orgId: string;
  email: string;
  name?: string | null;
};

export type PaddleSubscriptionInput = {
  subscriptionId: string;
  customerId: string;
  orgId: string;
  status: string;
  priceId: string;
  productId: string;
  scheduledChangeAction?: string | null;
  scheduledChangeAt?: Date | null;
  currentPeriodEnd?: Date | null;
};

/** `upsert` on our own generated id, keyed on Paddle's. */
export async function mirrorCustomer(input: PaddleCustomerInput): Promise<void> {
  if (input.customerId === "") throw new TypeError("mirrorCustomer.customerId is required");
  if (input.orgId === "")
    throw new TypeError(
      "mirrorCustomer.orgId is required — a mirror row without an org is an orphan",
    );
  if (input.email === "") throw new TypeError("mirrorCustomer.email is required");

  await db.paddleCustomer.upsert({
    where: { customerId: input.customerId },
    create: {
      customerId: input.customerId,
      orgId: input.orgId,
      email: input.email,
      ...(input.name == null ? {} : { name: input.name }),
    },
    update: {
      // Deliberately does NOT update orgId: the org that bought is the org that
      // owns it, and a later event naming a different one is a bug, not an update.
      email: input.email,
      ...(input.name == null ? {} : { name: input.name }),
    },
  });
}

/**
 * Mirror a subscription, creating its customer first if the event carries one.
 *
 * `customer` is optional because Paddle's `subscription.*` payloads do carry the
 * customer object, and mirroring it here means a `subscription.created` arriving
 * before its `customer.created` still produces a resolvable row.
 */
export async function mirrorSubscription(input: PaddleSubscriptionInput): Promise<void> {
  if (input.subscriptionId === "")
    throw new TypeError("mirrorSubscription.subscriptionId is required");
  if (input.customerId === "") throw new TypeError("mirrorSubscription.customerId is required");
  if (input.orgId === "") throw new TypeError("mirrorSubscription.orgId is required");

  const existing = await db.paddleCustomer.findUnique({
    where: { customerId: input.customerId },
    select: { id: true },
  });
  if (!existing) {
    // The customer row is absent, which means the `customer.created` event has
    // not arrived (or was missed). Writing a placeholder rather than failing:
    // the subscription itself is the fact that matters, and the placeholder is
    // reconciled by the next `customer.updated` that carries a real email.
    await db.paddleCustomer.create({
      data: {
        customerId: input.customerId,
        orgId: input.orgId,
        email: "",
        name: null,
      },
    });
  }

  await db.paddleSubscription.upsert({
    where: { subscriptionId: input.subscriptionId },
    create: {
      subscriptionId: input.subscriptionId,
      customerId: input.customerId,
      orgId: input.orgId,
      status: input.status,
      priceId: input.priceId,
      productId: input.productId,
      ...(input.scheduledChangeAction == null
        ? {}
        : { scheduledChangeAction: input.scheduledChangeAction }),
      ...(input.scheduledChangeAt == null ? {} : { scheduledChangeAt: input.scheduledChangeAt }),
      ...(input.currentPeriodEnd == null ? {} : { currentPeriodEnd: input.currentPeriodEnd }),
    },
    update: {
      status: input.status,
      priceId: input.priceId,
      productId: input.productId,
      // Nulls are written as nulls, not skipped: clearing a scheduled change is
      // exactly what a `subscription.updated` after a resumed subscription does,
      // and `undefined` would leave the stale value in place.
      scheduledChangeAction: input.scheduledChangeAction ?? null,
      scheduledChangeAt: input.scheduledChangeAt ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
    },
  });
}

/** The customer's Paddle id for an org, or null. Used by the portal route. */
export async function paddleCustomerIdFor(orgId: string): Promise<string | null> {
  const row = await db.paddleCustomer.findFirst({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    select: { customerId: true },
  });
  return row?.customerId ?? null;
}
