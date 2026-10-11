import { asInstitutionType, type InstitutionType } from "./institution-types";

/**
 * Dynamic UI labels keyed by institution type.
 *
 * A bank sees "Transaction" / "Freeze Card"; an insurer sees "Claim" /
 * "Pause Payout". A takaful insurer additionally sees "Contribution"
 * instead of "Premium" and "Takaful" instead of "Insurance".
 *
 * This is the single source of truth for operator-facing vocabulary in the
 * Console — the signal form, the case list, the runbook, and the delivery
 * card all read from here so the UI never hardcodes a banking term that
 * would be wrong for an insurer.
 */

export type InstitutionLabels = {
  /** "Transaction" | "Claim" */
  productNoun: string;
  /** "Merchant" | "Provider / Repair Shop" */
  merchantLabel: string;
  /** "Freeze Card" | "Pause Payout" */
  actionLabel: string;
  /** "Charge Amount" | "Claim Amount" */
  amountLabel: string;
  /** "Verified" | "Claim Validated" */
  statusLabel: string;
  /** "Fraud Confirmed" | "Claim Flagged" */
  fraudLabel: string;
  /** "Premium" | "Contribution" (takaful) */
  premiumNoun: string;
  /** "Insurance" | "Takaful" */
  institutionNoun: string;
  /** "Card" | "Policy" */
  accountNoun: string;
};

const BANK_LABELS: InstitutionLabels = {
  productNoun: "Transaction",
  merchantLabel: "Merchant",
  actionLabel: "Freeze Card",
  amountLabel: "Charge Amount",
  statusLabel: "Verified",
  fraudLabel: "Fraud Confirmed",
  premiumNoun: "Premium",
  institutionNoun: "Bank",
  accountNoun: "Card",
};

const INSURER_LABELS: InstitutionLabels = {
  productNoun: "Claim",
  merchantLabel: "Provider / Repair Shop",
  actionLabel: "Pause Payout",
  amountLabel: "Claim Amount",
  statusLabel: "Claim Validated",
  fraudLabel: "Claim Flagged",
  premiumNoun: "Premium",
  institutionNoun: "Insurance",
  accountNoun: "Policy",
};

const TAKAFUL_LABELS: InstitutionLabels = {
  ...INSURER_LABELS,
  premiumNoun: "Contribution",
  institutionNoun: "Takaful",
  actionLabel: "Pause Disbursement",
  statusLabel: "Claim Validated",
};

/**
 * Resolve the label set for an institution. `shariahCompliant` promotes an
 * insurer to takaful vocabulary. Unknown types fall back to bank labels.
 */
export function getInstitutionLabels(
  type: InstitutionType | string | undefined | null,
  shariahCompliant?: boolean,
): InstitutionLabels {
  const t = asInstitutionType(type ?? "bank");
  if (t === "insurer") {
    return shariahCompliant ? TAKAFUL_LABELS : INSURER_LABELS;
  }
  return BANK_LABELS;
}

/**
 * The signal kind that matches an institution type — what a producer's
 * `signalKind` should default to when the institution hasn't declared one.
 */
export function defaultProductType(
  type: InstitutionType | string | undefined | null,
): string {
  const t = asInstitutionType(type ?? "bank");
  return t === "insurer" ? "claim_payout" : "card_transaction";
}
