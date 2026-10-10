export const SpokenCurrencyMap: Record<string, string> = {
  AED: "UAE Dirhams",
  USD: "US Dollars",
  EUR: "Euros",
  GBP: "British Pounds",
  KES: "Kenyan Shillings",
  UGX: "Ugandan Shillings",
  SAR: "Saudi Riyals",
  PKR: "Pakistani Rupees",
};

export function getSpokenCurrency(isoCode: string): string {
  return SpokenCurrencyMap[isoCode] || isoCode.split("").join(" ");
}
