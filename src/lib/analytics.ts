import "server-only";

/**
 * Server-side product analytics.
 *
 * WHY A SEPARATE MODULE AND NOT `captureServerEvent` DIRECTLY
 *
 * `src/lib/posthog.ts` is the transport. This module is the POLICY that decides
 * what may cross it. The gap matters because the transport has no opinion: it
 * captures whatever properties it is handed, and the only place that opinion
 * could live is in the discipline of whoever calls it. On a fraud platform for
 * banks, "whoever called it" is not a control — a single new call site that
 * forwards a `signal` object wholesale ships transaction amounts, merchant
 * names and phone numbers to a third-party vendor.
 *
 * So every event here is built from an explicit allowlist of values that are
 * already non-identifying, and `emit` takes that prebuilt object rather than an
 * arbitrary payload. There is no code path from a `signal` to this module that
 * is not a deliberate, reviewable property-by-property decision.
 *
 * ── WHAT MUST NEVER BE SENT, AND WHY ────────────────────────────────────────
 *
 * The platform's promise (`docs/PILOT-BRIEF.md`) is that the model never asks for
 * a PIN, password, one-time passcode, CVV or full card number, and that the
 * agent never reads a balance. The analytics boundary is downstream of that
 * promise, so the following are refused here, not merely avoided by convention:
 *
 *   · `phone`, `ref_last4`, `verificationToken` — reach the customer directly.
 *   · `transaction_ref` — a bank's own transaction identifier. In a fraud
 *     context it is a join key back to a customer's disputed transaction, which
 *     makes it personal data the moment a bank has linked it to a person.
 *   · `amount` / `currency` — transaction value. Combined with a risk score and
 *     a timestamp this is a fingerprint of a specific customer's specific
 *     payment, which is the kind of data that turns an analytics vendor into a
 *     processor a bank must negotiate a DPA with.
 *   · `merchant` — a third party's name, attached to a suspected fraud event.
 *   · `consentRecordId`, `caseRef` — case refs are quoted to customers and appear
 *     in audit views; a case ref in an analytics property is an enumeration aid.
 *   · free-form text of any kind, including `notes` and the redacted transcript.
 *
 * `orgId` IS sent, and deliberately. It is our own tenant identifier, not a
 * personal one, and PostHog needs it as the distinct id to compute per-org
 * funnel and retention. The events below are all org-level or plan-level facts
 * that describe the PLATFORM's behaviour, not the CUSTOMER's data — "the abuse
 * gate refused this dial" is a fact about our code; "Mr. X was called about
 * transaction 4471 for AED 12,000 at Merchant Y" is data about a person.
 *
 * ── FAILURE POSTURE ─────────────────────────────────────────────────────────
 *
 * `emit` cannot throw, cannot reject, and is never awaited by a caller on a
 * request path. Analytics observes; it does not gate. This mirrors
 * `captureServerEvent`, and the reason it matters is that a fraud intervention
 * has a sixty-to-ninety second window: a PostHog 5xx must not be able to delay
 * or fail a customer's fraud call.
 */

/** The plan ids in `src/views/Pricing.tsx`. */
export type AnalyticsPlan = "starter" | "growth" | "enterprise" | "demo" | "unknown";

/**
 * Org-level facts. Every key is optional so a caller that genuinely does not
 * know a value can omit it — an absent key is `unknown` in PostHog, which is
 * honest, whereas a defaulted-to-zero key is a fabricated measurement.
 */
type OrgEventProps = {
  /** Our tenant id. The PostHog distinct id. */
  orgId: string;
  plan?: AnalyticsPlan;
  /** `planTierFor()`'s tier — the abuse gate's view, may differ from billing. */
  planTier?: string;
};

/**
 * Emitted when a bank's risk signal clears the policy, compliance and abuse
 * gates and a case row is written. This is the platform's core value action —
 * the moment a fraud alert became a real intervention.
 *
 * `outcome` distinguishes the three paths the handler can take after the gates
 * pass, which is the only place in the product that knows whether a call will
 * actually be placed:
 *   `queued`        a dial job is enqueued and a call will happen
 *   `sms_only`      the customer is deaf/HH; the voice path is skipped entirely
 *   `degraded`      capacity shed the voice path to an async channel
 */
export function interventionAccepted(
  props: OrgEventProps & {
    outcome: "queued" | "sms_only" | "degraded";
    language: string;
    signalKind?: string | null;
    callCategory?: string | null;
    /** `0..1` band, NOT the exact score — a band is not re-identifiable. */
    riskBand: "low" | "medium" | "high";
    hearingImpaired: boolean;
  },
): void {
  emit("intervention_accepted", props.orgId, {
    plan: props.plan,
    plan_tier: props.planTier,
    outcome: props.outcome,
    language: props.language,
    signal_kind: props.signalKind ?? undefined,
    call_category: props.callCategory ?? undefined,
    risk_band: props.riskBand,
    hearing_impaired: props.hearingImpaired,
  });
}

/**
 * Emitted when a signal is refused by a gate.
 *
 * These are the highest-value events in the whole dataset: a gate that starts
 * refusing more than it used to is either a policy change, an attack, or a bug,
 * and all three are invisible without this. `reason` is a machine reason CODE
 * (`consent_opted_out`, `demo_tier_requires_test_number`, …), never free text.
 */
export function interventionRefused(
  props: OrgEventProps & {
    /** Which gate refused: `policy`, `compliance`, `abuse`, or `consent`. */
    stage: "policy" | "compliance" | "abuse" | "consent";
    /** The gate's own typed reason code. Never a message. */
    reason: string;
  },
): void {
  emit("intervention_refused", props.orgId, {
    plan: props.plan,
    plan_tier: props.planTier,
    stage: props.stage,
    reason: props.reason,
  });
}

/**
 * Usage against the included allowance, emitted when an overage invoice is
 * raised. This is the trigger for the overage workflow that protects gross
 * margin, and it is emitted from `raiseOverageInvoice` — on the non-duplicate
 * branch only — rather than from a read path, because `summariseOverage` is
 * documented as safe to call from quote screens, scheduled jobs and tests, and
 * a pure read function must not have an analytics side effect. A quote-screen
 * lookup would otherwise emit an event every time an operator previewed a
 * number.
 *
 * The pre-ceiling variant of this workflow (firing while usage is still inside
 * the allowance) needs a scheduled caller that summarises open periods
 * periodically — that job does not exist yet, and when it is written it should
 * emit this event itself rather than moving the emit into `summariseOverage`.
 *
 * The allowance percentages are the payload. `netUsedUnits` alone is not useful
 * without them, and they are non-identifying: a plan allowance is our own
 * published number, not the customer's data.
 */
export function usageSummarised(props: {
  orgId: string;
  plan?: AnalyticsPlan;
  /** Net billable units consumed in the period, after returns. */
  netUsedUnits: number;
  /** Units included in the customer's plan. */
  includedUnits: number;
  /** Units billable as overage. */
  billableOverageUnits: number;
}): void {
  const allowancePct =
    props.includedUnits > 0
      ? Math.round((props.netUsedUnits / props.includedUnits) * 1000) / 10
      : null;

  emit("usage_summarised", props.orgId, {
    plan: props.plan,
    net_used_units: props.netUsedUnits,
    included_units: props.includedUnits,
    billable_overage_units: props.billableOverageUnits,
    // null, not 0: an org whose plan has no allowance genuinely has an unknown
    // percentage, and reporting 0% would read as "used none of nothing".
    allowance_pct: allowancePct,
    over_included: props.netUsedUnits > props.includedUnits,
  });
}

/**
 * Paddle subscription lifecycle, mirrored from `handlePaddleEvent`.
 *
 * `scheduled` is the field that matters most and is the easiest to get wrong:
 * Paddle reports a subscription that will cancel at period end as still
 * `active` with a pending `scheduled_change`. A workflow that reads `status`
 * alone sees an active subscription and misses the churn entirely. Both are
 * carried separately so a Slack alert can distinguish "cancelling" from
 * "cancelled" — the distinction `paddle-events.ts` already insists on.
 *
 * No Paddle customer id is sent. It identifies the buyer, and PostHog does not
 * need it: the org is the distinct id and the join happens server-side.
 */
export function subscriptionChanged(props: {
  orgId: string;
  /** Paddle's status verbatim (`active`, `past_due`, `canceled`, …). */
  status: string;
  /** Resolved plan id, not the price id. */
  plan: AnalyticsPlan;
  /** True when a future `scheduled_change` is pending. */
  scheduled: boolean;
  /** The scheduled action (`cancel`, `pause`), when one is pending. */
  scheduledAction?: string | null;
  /** The Paddle event that produced this: `subscription.created` etc. */
  source: "created" | "updated" | "canceled";
}): void {
  emit("subscription_changed", props.orgId, {
    status: props.status,
    plan: props.plan,
    scheduled: props.scheduled,
    scheduled_action: props.scheduledAction ?? undefined,
    source: props.source,
    // A past-due subscription is the one state that is both a billing problem
    // and a churn problem, so it gets its own boolean rather than making every
    // workflow parse the status string.
    past_due: props.status === "past_due",
  });
}

/** Coarse risk band. The exact score is a per-customer fingerprint. */
export function riskBand(score: number): "low" | "medium" | "high" {
  if (!Number.isFinite(score)) return "low";
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  return "low";
}

/**
 * Money in, from a settled Paddle transaction.
 *
 * ── Why this event carries an amount when the module header forbids one ───────
 * The header refuses `amount` / `currency` because, in context, they mean a
 * FRAUD TRANSACTION value: what the bank lost on a disputed card payment. That
 * plus a risk score and a timestamp is a fingerprint of a specific customer's
 * specific payment, which is what turns an analytics vendor into a processor a
 * bank has to negotiate a DPA with.
 *
 * `revenue_minor` is a different number in a different direction. It is money
 * the CUSTOMER PAID US for a subscription — our own revenue, a figure already
 * public on the pricing page. It describes our business, not theirs. Losing the
 * ability to see revenue would mean the past-due, plan-change and MRR workflows
 * have nothing to trigger on, which is the opposite failure and the reason this
 * event exists.
 *
 * The distinction is only defensible while the following stay out, so they are
 * named rather than left to convention:
 *
 *   · the Paddle CUSTOMER id (`ctm_…`) — identifies the buyer. `orgId` is the
 *     distinct id and the join happens server-side, which the module header
 *     already relies on for `subscription_changed`.
 *   · the Paddle TRANSACTION id (`txn_…`) — a purchase record identifier.
 *   · `items` / line-item detail — names what was bought at what quantity.
 *   · any proration or tax component — `revenue_minor` is the settled total,
 *     already net of both, so a workflow never has to reconstruct it.
 *
 * Minor units, never a float. A float revenue figure is a rounding bug waiting
 * for the invoice that lands exactly on a half-cent.
 */
export function revenueRecognised(props: {
  orgId: string;
  /** Settled total in MINOR units (cents, fils). Paddle's own convention. */
  revenueMinor: number;
  /** ISO-4217 uppercase. `USD`, `AED`, … */
  currency: string;
  /** Resolved plan id at the time of the transaction, not the price id. */
  plan?: AnalyticsPlan;
  /**
   * What kind of money this is, so a workflow can separate a new sale from a
   * renewal without inspecting dates. `proration` is a real case: an upgrade
   * mid-cycle settles a partial-period charge that must not be counted as a
   * fresh sale.
   */
  kind: "new_sale" | "renewal" | "proration" | "adjustment";
  /** The Paddle event that produced it — `transaction.completed` today. */
  source: "transaction_completed";
}): void {
  // A negative or non-finite total is not a measurement, and passing one to a
  // revenue workflow would silently corrupt MRR. Refuse at the boundary rather
  // than emitting a figure nobody can reconcile against an invoice.
  if (!Number.isFinite(props.revenueMinor) || props.revenueMinor < 0) return;

  emit("revenue_recognised", props.orgId, {
    revenue_minor: Math.trunc(props.revenueMinor),
    currency: props.currency,
    plan: props.plan,
    kind: props.kind,
    source: props.source,
    // Zero-dollar checkouts (the 100%-off live verification run) are real
    // transactions that prove the flow works. They must be countable without
    // being counted as revenue, or a verification run shows up as negative MRR.
    zero_value: props.revenueMinor === 0,
  });
}

/** The subset of `AbortSignal`/promise semantics we need to be non-blocking. */
function emit(
  event: string,
  distinctId: string,
  // `null` is a first-class value here and is DELIBERATELY distinct from
  // `undefined`. `undefined` means "we do not know this", and is dropped so the
  // property is simply absent. `null` means "we know this, and it is nothing" —
  // an org whose plan carries no allowance has an unknown percentage, and
  // reporting 0% would read as "used none of nothing". Collapsing the two
  // would fabricate a measurement, so the type admits `null` and the emit path
  // below preserves it.
  properties: Record<string, string | number | boolean | null | undefined>,
): void {
  // Imported lazily and behind a guard: `src/lib/posthog.ts` is `server-only`
  // and constructs a network client at module scope. A static import would make
  // this module unimportable from any non-server context and would couple the
  // analytics policy to the transport's construction cost.
  void (async () => {
    try {
      const { captureServerEvent } = await import("@/lib/posthog");
      // Drop undefined keys so a PostHog property is absent rather than null:
      // absent is "unknown", null reads as "known to be nothing". A null that
      // was supplied on purpose is kept — it already carries that meaning.
      const clean: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries(properties)) {
        if (v !== undefined) clean[k] = v;
      }
      captureServerEvent(distinctId, event, clean);
    } catch {
      // Analytics must never break the request path. See the module docblock.
    }
  })();
}
