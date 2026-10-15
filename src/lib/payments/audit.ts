import "server-only";
/**
 * The audit record for every movement of money.
 *
 * ## Why this file exists
 *
 * `src/lib/audit-chain.ts` is the tamper-evident record this product's
 * regulators are shown, and `WP-13` proves it covers the manual-invoice path —
 * but the settlement path that actually mints prepaid units
 * (`settlePayment`, "the ONLY writer of a successful PaymentRecord and the only
 * bridge from money to prepaid units") wrote a `PaymentRecord`, a `UsageLedger`
 * row and an `Organization.credits` increment and NOTHING in the chain. So the
 * most consequential money action in the product was the one action an auditor
 * could not ask for evidence of, while the least consequential (an operator
 * recording a bank transfer) was fully chained.
 *
 * That is the inverse of what an audit surface should be, and it is why the
 * money path gets its own writer instead of each caller choosing a `callRef`
 * shape: every one of these rows must be findable by the same key an operator
 * already has — the payment reference.
 *
 * ## The invariants this holds
 *
 *   - **One `callRef` scheme: `PAY-${reference}`.** `verifyChain("PAY-…")` is
 *     the entry point WP-13 and the console both use; a second scheme would put
 *     half the money evidence behind a lookup nobody performs.
 *   - **Awaited, never fire-and-forget.** A settlement that returns before its
 *     record is written is a settlement whose record may not exist, and the
 *     caller cannot tell. Callers get a boolean and decide; the money paths in
 *     this repository answer "credited but not recorded" with a retryable 500.
 *   - **Never throws.** An audit outage must not roll back committed money.
 *     One bounded retry, then `false`.
 *   - **No customer text in `meta`.** Amounts, ids, currencies and outcomes —
 *     the facts a reconciliation needs. `redactedText` carries a short,
 *     already-redacted summary because the column is capped at 500 chars.
 */

import { createHash } from "node:crypto";
import { append as auditAppend } from "@/lib/audit-chain";
import { logError } from "@/lib/validation/safe-log";

/** `audit-chain`'s `safeKey(entry.callRef, 64)` ceiling. Not a suggestion. */
const CALL_REF_MAX = 64;

/**
 * The `callRef` a money record is filed under — and the ONLY correct way to
 * look one up.
 *
 * `append()` truncates `callRef` to 64 characters rather than rejecting it, and
 * `buildReference()` produces `org_<orgId>_<purpose>_<ULID>` which for a UUID
 * tenant is 66+ characters. So `PAY-<reference>` silently loses its ULID tail
 * on the way in. A caller that then verifies with the string it *thinks* it
 * wrote — `verifyChain("PAY-" + reference)` — matches zero rows, and
 * `verifyChain` reports `{ ok: true, rows: 0 }` for an empty chain.
 *
 * That is the precise failure mode this whole file exists to close: money
 * moving with no evidence, and a green checkmark saying otherwise. Two payments
 * for the same org and purpose also collapse onto one truncated ref, sharing a
 * chain head.
 *
 * So the truncation is done here, deliberately, by hashing the overflow instead
 * of lopping it: `PAY-<60 hex>` for long references, verbatim for short ones so
 * the `PAY-<bankRef>` scheme WP-13 already asserts keeps working unchanged.
 */
export function moneyChainRef(reference: string): string {
  const raw = `PAY-${reference}`;
  if (raw.length <= CALL_REF_MAX) return raw;
  return `PAY-${createHash("sha256")
    .update(raw)
    .digest("hex")
    .slice(0, CALL_REF_MAX - 4)}`;
}

/** Bounded retry: the failure mode this survives is a transient pool timeout,
 *  not an outage — an outage is reported and counted centrally by audit-chain. */
const RETRIES = 2;
const RETRY_BACKOFF_MS = 250;

export type MoneyAudit = {
  /** Our payment reference, or the gateway event id when there is no reference. */
  reference: string;
  intent: string;
  /** Who moved the money: the operator id, or the literal `"gateway"`. */
  actor: string;
  detail: string;
  meta: Record<string, unknown>;
  orgId?: string | null;
};

/**
 * Append one money-movement record. Resolves `true` only when the row is in the
 * chain — a `false` is the caller's signal that the money fact and the money
 * evidence have diverged.
 */
export async function auditMoney(input: MoneyAudit): Promise<boolean> {
  const entry = {
    callRef: moneyChainRef(input.reference),
    // `consent` is the action the money path already files under (WP-13 pins it
    // for `payment_recorded` / `payment_verified`). The union in audit-chain has
    // no `payment` member, and inventing one here would split the money evidence
    // across two action values for no benefit.
    action: "consent" as const,
    intent: input.intent,
    callerId: input.actor,
    redactedText: input.detail.slice(0, 500),
    meta: input.meta,
    ...(input.orgId === undefined || input.orgId === null ? {} : { orgId: input.orgId }),
  };

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      await auditAppend(entry, { fast: true });
      return true;
    } catch (err) {
      if (attempt === RETRIES - 1) {
        logError("[payments-audit] money record NOT chained", {
          reference: input.reference,
          intent: input.intent,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
      await sleep(RETRY_BACKOFF_MS);
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
