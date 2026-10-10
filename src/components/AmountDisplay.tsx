"use client";

export interface AmountDisplayProps {
  amount: number;
  currency: string;
}

export default function AmountDisplay({ amount, currency }: AmountDisplayProps) {
  // Layer 4: native Intl formatting — never invents currency display
  // currencyDisplay: "code" forces "AED 2,500.00" rather than symbol form
  // minimumFractionDigits: 2 ensures .50 is shown (not rounded to .5)
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "AED",
    currencyDisplay: "code",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);

  return <span className="font-bold text-red-600">{formatted}</span>;
}
