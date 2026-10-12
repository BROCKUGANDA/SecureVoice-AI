# ADR-005: Paddle as Merchant of Record, our own metering ledger

## Context

Usage-based billing for a regulated product in more than one country forces the same
three questions every time: who is liable for the tax, in what currency, and who can
produce the invoice. The metering question is ours regardless of the answer, because
"one verified call = one credit" is a domain rule, not a billing-platform concept.

The constraint that removed the obvious default: the payment methods available to this
business do not include the ones most US documentation assumes. Merchant of Record is
not a preference here, it is the only way to sell into the Gulf and Africa without
becoming the entity responsible for local tax registration in each of them.

## Decision

**Paddle is the Merchant of Record.** It is the seller of record on the invoice, so
VAT and FX are its liability, not ours. Paddle is a
[Hosted Payment Page](https://developer.paypal.com/braintree/docs/guides/paypal/overview),
not a card-on-file vault, and the consequence is accepted explicitly: overage billing
is a **Net-30 manual-collection invoice**, never an automatic charge, because there is
no stored authorisation to charge against. The code says so in the place that would be
expensive to learn otherwise.

**Metering is ours, and it is a ledger, not a column.** `UsageLedger` is append-only
with kinds `topup | reserve | consume | release | refund`, a unique idempotency key
per movement, an advisory transaction lock so two appends cannot interleave, and a
`balanceAfter` on every row. The invariant is that the balance **is** the sum of the
ledger. `Organization.credits` is a mutable wallet floored at zero, and the two
disagreeing numbers are reconciled by a gate, not by trust.

**The refusal a caller can act on is 402, and the one they cannot is 409.**
Out-of-credits is `payment_required`: paying clears it. Consent, geography,
do-not-call and cooldown are `policy_precondition`: retrying and paying both change
nothing. Lumping them means either retrying a refusal forever or giving up on one a
top-up fixes. Overage rating resolves against the tenant's **own plan** (Starter 15¢,
Growth 12¢, Enterprise negotiated) and the invoicing worker writes nothing until
`OVERAGE_INVOICING_ENABLED=1`, so a deployment can check the arithmetic against a real
closed period before any of it reaches a bank's accounts team.

**Plan entitlements are enforced, not displayed.** BYOK and signed webhooks to the
institution's own endpoint are Growth features and refuse with 402 below that. What
is deliberately _not_ tiered: compliance. Redaction, vishing refusal, prayer-window
deferral and the Shariah terminology engine run for every paying tenant, because a
guardrail that switches off under a pricing plan is not a guardrail. Removing a
feature is never gated either — a downgraded tenant must always be able to delete the
callback URL its data was going to.

## Consequences

**Positive.** Tax liability sits with an entity built to hold it. Every credit
movement is attributable, so a refund or a failed-call credit is a ledger row rather
than an edit to a number. The sandbox/live guard (`pdl_sdbx_` requires an explicit
opt-in for live keys) means a mis-set secret cannot bill a real customer.

**Negative, stated plainly.** No stored card authorisation, so overage is an
invoice someone chases, and the reconciliation between Paddle's view of money and the
ledger's view of credits is ours to keep honest — mirrored
`PaddleSubscription`/`PaddleCustomer` rows are written by webhook and can lag.
Low-balance alerting and credit-granting are custom code with no vendor equivalent.
Live state is the honest caveat, recorded rather than hidden: the mirrored member
table is empty and subscriptions are zero, so the seat, plan and overage controls are
correct and unexercised by real money.

## Evidence

`src/lib/payments/paddle.ts` · `src/lib/payments/plans.ts` · `src/lib/payments/overage.ts` ·
`src/lib/payments/overage-run.ts` · `src/worker/overage.ts` · `src/lib/billing/ledger.ts` ·
`src/lib/billing/plan-context.ts` · `src/lib/billing/entitlements.ts` ·
`src/lib/billing/seats.ts` · `src/lib/failures/envelope.ts` (`payment_required`) · `docs/INTEGRATION-CONTRACT.md`
