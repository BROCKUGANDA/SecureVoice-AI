/**
 * Institution types - pure, importable from both server and client code.
 *
 * A bank and an insurer are both TENANTS of this platform (an organization with
 * members), both OPERATORS (their analysts run the console) and both VENDORS in
 * the supply-chain sense (their own vendors - TPAs, brokers, collections
 * agencies - can be given scoped producer keys). What differs is only how the
 * institution is spoken about to ITS customers: "your card" is wrong for a
 * policyholder whose claim payout was redirected.
 *
 * Keeping the vocabulary in one place means the SMS, the voicemail, the agent's
 * dynamic variables and the console all say the same thing.
 */

export const INSTITUTION_TYPES = ["bank", "insurer"] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

export function isInstitutionType(v: unknown): v is InstitutionType {
  return typeof v === "string" && (INSTITUTION_TYPES as readonly string[]).includes(v);
}

/** Anything unrecognised is a bank: the default every existing tenant has. */
export function asInstitutionType(v: unknown): InstitutionType {
  return isInstitutionType(v) ? v : "bank";
}

/**
 * What kind of risk signal opened the case. `card_transaction` is the original
 * (and default) kind; the others are the insurer-side equivalents and the
 * account-takeover signal both institution types raise.
 */
export const SIGNAL_KINDS = [
  "card_transaction",
  "claim_payout",
  "policy_change",
  "account_takeover",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export function isSignalKind(v: unknown): v is SignalKind {
  return typeof v === "string" && (SIGNAL_KINDS as readonly string[]).includes(v);
}

/** Default kind when the producer does not say: by institution. */
export function defaultSignalKind(inst: InstitutionType): SignalKind {
  return inst === "insurer" ? "claim_payout" : "card_transaction";
}

/** English vocabulary the agent receives as dynamic variables. */
export const VOCAB: Record<
  InstitutionType,
  { institution: string; account: string; protectiveAction: string }
> = {
  bank: {
    institution: "bank",
    account: "card",
    protectiveAction: "temporary hold on the card",
  },
  insurer: {
    institution: "insurer",
    account: "policy",
    protectiveAction: "temporary hold on the claim payout or policy change",
  },
};
