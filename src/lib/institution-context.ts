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
 * The Arabic vocabulary for the same label set.
 *
 * WHY THIS EXISTS, AND WHY IT IS A SEPARATE MAP RATHER THAN A `{en, ar}` pair
 *
 * `getInstitutionLabels()` predates the Arabic surface and returns English
 * strings. The Console then called `t(labels.amountLabel, labels.amountLabel,
 * lang)` — the SAME string in both language slots — so `t()` dutifully returned
 * it unchanged and every Arabic-speaking bank operator read "Charge Amount" and
 * "Merchant" in English, inside an otherwise fully translated screen.
 *
 * That is the worst kind of translation defect: `t(x, x, lang)` is
 * indistinguishable from working code, it fails silently, and no lint rule flags
 * it. It also meant the institution-aware vocabulary — the feature that makes an
 * insurer see "Claim" instead of "Transaction" — was the one part of the Console
 * with no Arabic at all.
 *
 * Kept parallel rather than restructured so the three existing English consumers
 * (`labels.productNoun === "Claim"`, `.toLowerCase()` interpolation) keep working
 * untouched; changing the type to pairs would have forced a rewrite of every
 * call site for no translation benefit.
 *
 * REGISTER: Modern Standard Arabic, matching the rest of the Arabic surface in
 * this codebase. These are standard banking and insurance terms and are NOT
 * dialectal, but they have not been reviewed by a native-speaking reviewer — see
 * the note in tests/translations.test.ts, which asserts the two maps stay in step.
 */
export type InstitutionLabelsAr = {
  productNoun: string;
  merchantLabel: string;
  actionLabel: string;
  amountLabel: string;
  statusLabel: string;
  fraudLabel: string;
  premiumNoun: string;
  institutionNoun: string;
  accountNoun: string;
};

const BANK_LABELS_AR: InstitutionLabelsAr = {
  productNoun: "معاملة",
  merchantLabel: "التاجر",
  actionLabel: "تجميد البطاقة",
  amountLabel: "مبلغ الخصم",
  statusLabel: "تم التحقق",
  fraudLabel: "تم تأكيد الاحتيال",
  premiumNoun: "القسط",
  institutionNoun: "المصرف",
  accountNoun: "البطاقة",
};

const INSURER_LABELS_AR: InstitutionLabelsAr = {
  productNoun: "مطالبة",
  merchantLabel: "مزود / ورشة إصلاح",
  actionLabel: "إيقاف الصرف",
  amountLabel: "مبلغ المطالبة",
  statusLabel: "تم التحقق من المطالبة",
  fraudLabel: "تم تعليم المطالبة",
  premiumNoun: "القسط",
  institutionNoun: "التأمين",
  accountNoun: "وثيقة التأمين",
};

const TAKAFUL_LABELS_AR: InstitutionLabelsAr = {
  ...INSURER_LABELS_AR,
  premiumNoun: "الاشتراك",
  institutionNoun: "التكافل",
  actionLabel: "إيقاف الصرف",
};

/**
 * The Arabic counterpart of `getInstitutionLabels`, resolved by the same
 * institution type and the same shariah promotion, so the two cannot disagree
 * about WHICH vocabulary applies — only about how it is spelled.
 */
export function getInstitutionLabelsAr(
  type: InstitutionType | string | undefined | null,
  shariahCompliant?: boolean,
): InstitutionLabelsAr {
  const t = asInstitutionType(type ?? "bank");
  if (t === "insurer") {
    return shariahCompliant ? TAKAFUL_LABELS_AR : INSURER_LABELS_AR;
  }
  return BANK_LABELS_AR;
}

/**
 * The signal kind that matches an institution type — what a producer's
 * `signalKind` should default to when the institution hasn't declared one.
 */
export function defaultProductType(type: InstitutionType | string | undefined | null): string {
  const t = asInstitutionType(type ?? "bank");
  return t === "insurer" ? "claim_payout" : "card_transaction";
}
