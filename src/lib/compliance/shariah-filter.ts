const SHARIAH_WORD_MAP: Record<string, string> = {
  interest: "profit rate",
  loan: "financing",
  premium: "contribution",
  insurance: "takaful",
  borrow: "finance",
  lender: "provider",
  debtor: "customer",
  "credit card": "financing card",
  apr: "profit rate",
  usury: "profit rate",
  gambling: "speculation",
  "claim payout": "fund disbursement",
};

export function sanitizeShariah(text: string): string {
  let sanitized = text;
  for (const [nonShariah, shariah] of Object.entries(SHARIAH_WORD_MAP)) {
    const regex = new RegExp(nonShariah, "gi");
    sanitized = sanitized.replace(regex, shariah);
  }
  return sanitized;
}
