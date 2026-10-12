import "server-only";
/**
 * Policy gate — the deterministic authorization layer between a risk signal
 * and a dial. Every check runs in order and fails fast with a typed reason.
 * The decision is written to the audit chain either way (WP-2 step 4).
 *
 * Order (fail-fast):
 *   1. a consent reference is present and well-formed (4–64 characters)
 *   2. destination country on the org allowlist
 *   3. destination not in cooldown
 *   4. org concurrency below cap
 *   5. org spend ceiling not breached
 *   6. credits reserved
 *
 * Step 1 is a REFERENCE check, not a lookup, and the distinction is load-bearing
 * for anything said about consent anywhere in this product. There is no consent
 * table in this schema — `consentRecordId` is a plain string on `Customer` and on
 * `Case` — because the record itself lives in the institution's system of record.
 * What this layer can and does enforce is that every signal carries a reference
 * before anything is dialled, that the reference lands in the case and the audit
 * chain so a call is attributable to a consent record, and that a number whose
 * stored row says opted-out is never dialled. The wording this replaces promised a
 * verification nobody could run, and docs/INTEGRATION.md §2 passed that promise on
 * to customers.
 *
 * No model is in this path. A signal that fails any check is rejected with a
 * typed reason and never reaches the conversation plane.
 */

import { append as auditAppend, type AuditEntry } from "@/lib/audit-chain";
import { db } from "@/lib/db";
import { assertWithinBudget, maySpend } from "@/lib/billing/breaker";
import { reserve as reserveCredits, balance as ledgerBalance } from "@/lib/billing/ledger";
import { diallingBlockedFor } from "@/lib/payments/access";
import { asCallCategory, type CallCategory } from "@/lib/call-categories";
import { isAfterHours } from "@/lib/abuse/velocity";

export type PolicyGateInput = {
  orgId: string | null;
  phone: string;
  consentRecordId: string;
  caseRef: string;
  callerId: string;
  /**
   * The bank's own transaction identifier. Used to refuse a repeat.
   *
   * Idempotency-Key only protects against the SAME request being retried. It
   * does nothing when a bank sends one transaction twice under two different
   * keys — a retry storm with a fresh key per attempt, two fraud engines racing,
   * or an integration bug that regenerates the header. Both then pass the
   * idempotency claim and both reach the dial path, and a fraud victim gets two
   * "your card is frozen" calls about one transaction. That is the exact failure
   * this product exists to prevent, so the transaction identity is checked
   * independently of the request identity.
   */
  transactionRef?: string;
  /**
   * WHY the institution is calling (src/lib/call-categories.ts). Absent reads
   * as the audited default (time_critical_fraud). The category is what turns
   * the two regulatory preconditions below on: the do-not-call registry blocks
   * every non-critical category, and routine calls are lawful only inside the
   * permitted calling window. Both are re-checked at the authoritative dial
   * moment by the worker — this is the fast, typed refusal at the edge.
   */
  callCategory?: string | null;
};

export type PolicyGateResult = { ok: true } | { ok: false; reason: string; code: string };

/** Extract the ISO country code from an E.164 phone number. */
function countryFromE164(phone: string): string | null {
  // E.164: + followed by 1-15 digits. The country code is the first 1-3 digits
  // after +. We use a small lookup for the common cases.
  const m = /^\+(\d{1,3})/.exec(phone);
  if (!m) return null;
  // Required capture group (1-3 digits), so it cannot actually be undefined.
  const cc = m[1]!;
  // 1-digit codes
  if (cc === "1") return "US"; // +1 — US/CA (treated as one NANP zone)
  if (cc === "7") return "RU";
  if (cc === "2") return "EG"; // +20 Egypt — wait, +20 is Egypt
  // 2-digit codes
  const twoDigit: Record<string, string> = {
    "20": "EG",
    "27": "ZA",
    "30": "GR",
    "31": "NL",
    "32": "BE",
    "33": "FR",
    "34": "ES",
    "36": "HU",
    "39": "IT",
    "40": "RO",
    "41": "CH",
    "43": "AT",
    "44": "GB",
    "45": "DK",
    "46": "SE",
    "47": "NO",
    "48": "PL",
    "49": "DE",
    "51": "PE",
    "52": "MX",
    "53": "CU",
    "54": "AR",
    "55": "BR",
    "56": "CL",
    "57": "CO",
    "58": "VE",
    "60": "MY",
    "61": "AU",
    "62": "ID",
    "63": "PH",
    "64": "NZ",
    "65": "SG",
    "66": "TH",
    "81": "JP",
    "82": "KR",
    "84": "VN",
    "86": "CN",
    "90": "TR",
    "91": "IN",
    "92": "PK",
    "93": "AF",
    "94": "LK",
    "95": "MM",
    "98": "IR",
  };
  if (twoDigit[cc]) return twoDigit[cc];
  // 3-digit codes — UAE is +971
  const threeDigit: Record<string, string> = {
    "971": "AE",
    "972": "IL",
    "973": "BH",
    "974": "QA",
    "975": "BT",
    "976": "MN",
    "977": "NP",
  };
  if (threeDigit[cc]) return threeDigit[cc];
  return null;
}

/** Default country allowlist — overridable per org via env. */
function allowedCountries(orgId: string | null): Set<string> {
  const raw =
    process.env.ALLOWED_COUNTRIES ?? "AE,US,GB,IN,EG,SA,QA,BH,KW,OM,JO,LB,PK,PH,SG,NG,KE,GH,ZA";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Cooldown: minimum seconds between calls to the same destination. */
const COOLDOWN_SECONDS = Number(process.env.DIAL_COOLDOWN_SECONDS ?? 300);

/** Org concurrency cap — max simultaneous active calls. */
const CONCURRENCY_CAP = Number(process.env.ORG_CONCURRENCY_CAP ?? 10);

/** Org spend ceiling in minor units (default 100 AED = 10000 fils). */
const SPEND_CEILING_MINOR = Number(process.env.ORG_SPEND_CEILING_MINOR ?? 10_000);

// ── In-memory cooldown + concurrency state ──
// These are per-org, per-destination guards that must be fast on the hot
// path. A DB query per signal would add ~1.2 s of remote round-trip latency
// — the difference between meeting the 1.5 s p95 and missing it. The state
// is eventually consistent (a replica restart resets it) which is acceptable
// for a demo guard; production moves these to Redis.
const lastCallByPhone = new Map<string, number>();
const activeCallsByOrg = new Map<string, number>();

/** Record a call placement (called after the dial succeeds). */
export function recordCallPlacement(orgId: string | null, phone: string): void {
  lastCallByPhone.set(phone, Date.now());
  if (orgId) {
    activeCallsByOrg.set(orgId, (activeCallsByOrg.get(orgId) ?? 0) + 1);
  }
}

/** Release a call slot (called when the case reaches a terminal state). */
export function releaseCallPlacement(orgId: string | null): void {
  if (orgId) {
    const n = (activeCallsByOrg.get(orgId) ?? 1) - 1;
    if (n <= 0) activeCallsByOrg.delete(orgId);
    else activeCallsByOrg.set(orgId, n);
  }
}

export async function runPolicyGate(input: PolicyGateInput): Promise<PolicyGateResult> {
  const { orgId, phone, consentRecordId, caseRef, callerId } = input;
  const audit = (action: string, intent: string, meta: Record<string, unknown>) =>
    auditAppend({
      callRef: caseRef,
      action: action as AuditEntry["action"],
      intent,
      callerId,
      meta,
      orgId: orgId ?? undefined,
    }).catch(() => {});

  // 0. Transaction repeat, BEFORE any spend is reserved.
  //
  //    Placed first because every later step costs something: the budget check
  //    below reserves a unit from the append-only ledger, and refusing a repeat
  //    after that would need a compensating release to avoid burning a customer's
  //    credits on a signal we were always going to reject.
  //
  //    This read is a fast path, not the guarantee. Two signals with DIFFERENT
  //    idempotency keys can pass it simultaneously, so the atomic backstop is a
  //    unique index on (orgId, transactionRef) — the second Case insert fails at
  //    the database, which is the only place a race can actually be settled.
  if (input.transactionRef) {
    const prior = await db.case.findFirst({
      where: {
        transactionRef: input.transactionRef,
        ...(orgId ? { orgId } : {}),
      },
      select: { caseRef: true, state: true },
    });
    if (prior) {
      await audit("freeze", "policy_transaction_repeat", {
        transactionRef: input.transactionRef,
        existingCaseRef: prior.caseRef,
        existingState: prior.state,
      });
      return {
        ok: false,
        reason: `transaction ${input.transactionRef} already has case ${prior.caseRef}`,
        code: "transaction_repeat",
      };
    }
  }

  // 1. Consent record format. The opted-out check runs in the route's
  //    combined query (one round-trip); here we only validate the shape.
  if (!consentRecordId || consentRecordId.length < 4 || consentRecordId.length > 64) {
    await audit("freeze", "policy_consent_invalid", {
      reason: "consent_record_id missing or malformed",
    });
    return {
      ok: false,
      reason: "consent_record_id is required and must be 4-64 characters",
      code: "consent_invalid",
    };
  }

  // 1b. Do-not-call registry. A number here must not receive routine or
  //     non-critical outbound calls, whatever the fraud score says — the
  //     customer's standing instruction outranks our triage. Time-critical
  //     fraud verification carries a required consent reference (step 1 above)
  //     and is in the customer's interest, so it is deliberately not gated on
  //     the registry.
  const category: CallCategory = asCallCategory(input.callCategory);
  if (category !== "time_critical_fraud") {
    const dnc = await db.doNotCall.findUnique({ where: { phone } });
    if (dnc) {
      await audit("freeze", "policy_do_not_call", {
        reason: dnc.reason,
        category,
        phone: phone.replace(/\d(?=\d{4})/g, "*"),
      });
      return {
        ok: false,
        reason: "destination is on the do-not-call registry",
        code: "do_not_call",
      };
    }
  }

  // 1c. Routine calls are lawful only inside the permitted calling window
  //     (measured on the clock of the person being called — see isAfterHours).
  //     The ingest-time check is the fast rejection; the worker re-checks at
  //     the dial moment and parks the job until the window opens.
  if (category === "routine" && isAfterHours(Date.now())) {
    await audit("freeze", "policy_outside_calling_hours", { category });
    return {
      ok: false,
      reason: "routine calls are only permitted inside the calling window",
      code: "outside_calling_hours",
    };
  }

  // 2. Destination country on the org allowlist.
  const country = countryFromE164(phone);
  if (!country) {
    await audit("freeze", "policy_country_unparseable", {
      phone: phone.replace(/\d(?=\d{4})/g, "*"),
    });
    return {
      ok: false,
      reason: "could not determine destination country from phone number",
      code: "country_unparseable",
    };
  }
  const allowlist = allowedCountries(orgId);
  if (!allowlist.has(country)) {
    await audit("freeze", "policy_country_not_allowed", { country });
    return {
      ok: false,
      reason: `destination country ${country} is not on the org allowlist`,
      code: "country_not_allowed",
    };
  }

  // 3. Destination not in cooldown (in-memory — see recordCallPlacement).
  const lastCall = lastCallByPhone.get(phone);
  if (lastCall && Date.now() - lastCall < COOLDOWN_SECONDS * 1000) {
    await audit("freeze", "policy_cooldown", { phone: phone.replace(/\d(?=\d{4})/g, "*") });
    return {
      ok: false,
      reason: `destination in cooldown (${COOLDOWN_SECONDS}s)`,
      code: "cooldown",
    };
  }

  // 4. Org concurrency below cap (in-memory — see recordCallPlacement).
  if (orgId) {
    const active = activeCallsByOrg.get(orgId) ?? 0;
    if (active >= CONCURRENCY_CAP) {
      await audit("freeze", "policy_concurrency_cap", { active, cap: CONCURRENCY_CAP });
      return {
        ok: false,
        reason: `org concurrency cap reached (${CONCURRENCY_CAP})`,
        code: "concurrency_cap",
      };
    }
  }

  // 5. Org spend ceiling not breached.
  //
  //    Enforced against the append-only UsageLedger via the spend breaker
  //    (WP-13). One intervention attempt is the billable SKU, so the estimate
  //    reserved here is exactly one unit; the actual call duration is reconciled
  //    on the post-call webhook, which releases the remainder.
  const orgKey = orgId ?? "unscoped";
  const budget = await assertWithinBudget({ orgId: orgKey, units: 1 });
  if (!maySpend(budget)) {
    const reason = budget.decision === "stop" ? budget.reason : "spend_ceiling";
    await audit("freeze", "policy_spend_ceiling", {
      percent: budget.percent,
      decision: budget.decision,
      window: budget.window,
    });
    return {
      ok: false,
      reason: `org spend ceiling reached (${budget.percent}% of ${budget.window ?? "window"})`,
      code: "spend_ceiling",
    };
  }
  if (budget.decision === "warn") {
    // 60/80/95 are alerts, not stops: the call still proceeds, but the breach
    // is on the record before it becomes an invoice.
    await audit("freeze", "policy_spend_alert", {
      percent: budget.percent,
      threshold: budget.threshold,
    });
  }

  // 5b. The tenant's own billing state, after every SAFETY gate and before any
  //     credit is reserved. Consent, do-not-call, calling hours, geography,
  //     cooldown and concurrency are all legal-or-abuse preconditions and none of
  //     them is a customer's preference — a pause is. So it is checked here, and
  //     only `paused` blocks (see `diallingBlockedFor` in
  //     src/lib/payments/access.ts, which explains why `past_due` and `canceled`
  //     deliberately do not, and why this differs from `decideAccess`).
  const billing = await diallingBlockedFor(orgId);
  if (!billing.allowed) {
    await audit("freeze", "policy_subscription_paused", { status: billing.status });
    return { ok: false, reason: billing.reason, code: "subscription_paused" };
  }

  // 6. Credits reserved.
  //
  //    A real reservation in the append-only ledger, not a decrement of a
  //    mutable counter: the unique idempotency key {caseRef}:1:reserve means a
  //    retried signal cannot reserve twice, and the balance remains the sum of
  //    the ledger (invariant I-8). Reconciled on the post-call webhook.
  //
  //    The balance read above is a fast path, not the authority. The ledger
  //    serialises every writer per organisation on an advisory lock and refuses
  //    the movement itself when the pool is short — which is the only way two
  //    concurrent signals against one remaining credit stay at one paid call.
  //    Refusal comes back as a VALUE ({ ok: false }), never a throw, so
  //    treating the await as the decision would let the loser sail through:
  //    the bank would be told a customer is being called that nobody paid for.
  //    The reservation result IS the decision.
  const available = await ledgerBalance(orgKey);
  if (available < 1) {
    await audit("freeze", "policy_credits_exhausted", { available });
    return {
      ok: false,
      reason: "no credits remaining for this organisation",
      code: "credits_exhausted",
    };
  }
  const reservation = await reserveCredits({
    orgId: orgKey,
    caseRef: input.caseRef,
    unitsEstimate: 1,
    reason: "intervention_attempt",
  });
  if (!reservation.ok) {
    // A lost race for the last credit, a closed window, an unknown org: a typed
    // refusal, never a 500 on the dial path. `duplicate: true` is a success —
    // the ledger answered a retried signal with the movement it already stored.
    await audit("freeze", "policy_credits_exhausted", { reason: reservation.reason });
    return {
      ok: false,
      reason: "no credits remaining for this organisation",
      code: "credits_exhausted",
    };
  }

  // The success audit entry is written by the route handler (combined with
  // signal_received) to keep the hot path to two appends total.
  return { ok: true };
}
