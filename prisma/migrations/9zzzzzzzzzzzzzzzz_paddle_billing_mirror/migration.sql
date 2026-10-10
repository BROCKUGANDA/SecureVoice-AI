-- Paddle billing mirror: the local copy of what the gateway told us.
--
-- Two tables and nothing else. Both are TENANTED (`orgId` is OUR organization,
-- not Paddle's) which is why `src/lib/tenancy/guard.ts` registers them in
-- TENANTED_MODELS and `src/lib/tenancy/isolation-matrix.ts` promises a read path
-- for each. The fail-closed matrix caught the registration without the promise,
-- which is exactly what it is for.
--
-- WHY MIRROR AT ALL
--
-- Paddle's own records are the billing truth, but they are not queryable with the
-- org context this app answers to, and a checkout that grants access must work
-- with the webhook queue down. The mirror is a local, org-scoped cache of the
-- two facts access decisions need: who the customer is, and what the
-- subscription's state is.
--
-- IDS ARE PADDLE'S NAMESPACE
--
-- `customerId` (`ctm_...`) and `subscriptionId` (`sub_...`) are Paddle's ids, not
-- ours, and both are globally UNIQUE. That is what makes them the right upsert
-- key — a re-sent webhook is an upsert, not an insert — and simultaneously what
-- makes an UNSCOPED read dangerous: `findUnique({ customerId })` resolves
-- anyone's billing identity from the id alone. Hence the TENANTED_MODELS
-- registration and the promised read path, not a comment.
--
-- `id` stays ours and is a cuid: Prisma generates it client-side, so it needs no
-- database default and cannot collide with anything Paddle assigns.
CREATE TABLE IF NOT EXISTS "PaddleCustomer" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaddleCustomer_pkey" PRIMARY KEY ("id")
);

-- The upsert key. ON CONFLICT on this is what makes a re-delivered
-- `customer.created` idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS "PaddleCustomer_customerId_key" ON "PaddleCustomer"("customerId");
CREATE INDEX IF NOT EXISTS "PaddleCustomer_orgId_idx" ON "PaddleCustomer"("orgId");

-- A subscription is NOT a copy of Paddle's subscription: `status` collapses to
-- five strings, and `scheduledChangeAction` / `scheduledChangeAt` exist as
-- SEPARATE columns rather than new status values because a SCHEDULED change is
-- not a change. An `active` subscription with `scheduledChangeAction = 'cancel'`
-- still grants access — the buyer asked to stop paying at period end, not now.
-- Collapsing that into `status = 'canceling'` would revoke a paying customer the
-- day they asked to cancel, so `hasPaidAccess` in src/lib/payments/access.ts is
-- explicit about it.
--
-- ON DELETE CASCADE on `customerId` is deliberate: a Paddle customer row this app
-- no longer mirrors makes its subscriptions meaningless rather than orphaned, and
-- the mirror is rebuilt from webhooks either way.
CREATE TABLE IF NOT EXISTS "PaddleSubscription" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "priceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "scheduledChangeAction" TEXT,
    "scheduledChangeAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaddleSubscription_pkey" PRIMARY KEY ("id")
);

-- The upsert keys. `subscriptionId` for re-delivered events; `customerId` because
-- every read of a subscription starts from a customer.
CREATE UNIQUE INDEX IF NOT EXISTS "PaddleSubscription_subscriptionId_key" ON "PaddleSubscription"("subscriptionId");
CREATE INDEX IF NOT EXISTS "PaddleSubscription_orgId_idx" ON "PaddleSubscription"("orgId");
CREATE INDEX IF NOT EXISTS "PaddleSubscription_customerId_idx" ON "PaddleSubscription"("customerId");

-- Enforced in Postgres rather than in application code: the mirror is written from
-- a webhook handler, and an invariant only the writer remembers is not an
-- invariant.
ALTER TABLE "PaddleSubscription" DROP CONSTRAINT IF EXISTS "PaddleSubscription_customerId_fkey";
ALTER TABLE "PaddleSubscription"
    ADD CONSTRAINT "PaddleSubscription_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "PaddleCustomer"("customerId")
    ON DELETE CASCADE ON UPDATE CASCADE;
