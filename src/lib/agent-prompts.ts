import { getSpokenCurrency } from "./currency-map";

const BASE_RULES = `
NEVER use markdown. Keep under 30 words.
NEVER ask for passwords, OTPs, or full policy numbers.
NEVER give financial, legal, or insurance advice.
If user asks for advice, transfer to human.
`;

export function getSpecialistPrompt(ctx: {
  institution_type: "bank" | "insurance";
  institution_name: string;
  amount?: number;
  currency?: string;
  merchant?: string;
  product_type?: string;
}): string {
  // Layer 3 enforcement + zero-amount edge case: a 0.00 authorization hold
  // must say "pre-authorization hold", never "zero Dirhams".
  const spokenCurrency = ctx.currency ? getSpokenCurrency(ctx.currency) : "";
  const isZero = ctx.amount === 0;
  const safeAmount =
    ctx.amount !== undefined
      ? isZero
        ? "a pre-authorization hold"
        : `${ctx.amount.toFixed(2)} ${spokenCurrency}`
      : "";

  if (ctx.institution_type === "insurance") {
    const amountPhrase = isZero
      ? "a pre-authorization hold (no monetary charge)"
      : `exactly ${safeAmount}`;
    return `${BASE_RULES}
You are a claims verification agent for ${ctx.institution_name}.
You are verifying a claim of ${amountPhrase}.
STRICT CURRENCY RULES:
1. You MUST state the amount using the spoken currency word, never symbols.
2. NEVER use currency symbols ($, د.إ, €).
3. NEVER convert currency or guess exchange rates.
4. If the user asks for a local equivalent, say "I can only see the claim as ${isZero ? "a pre-authorization hold" : safeAmount + " " + spokenCurrency}; please check your app for local equivalents."
Verify a claim filed for ${amountPhrase} at ${ctx.merchant ?? "the submitted provider"}.
If NO: Say the claim is flagged for investigation and payouts are paused.
Use "Coverage" or "Takaful" instead of "Insurance".`;
  }

  const amountPhrase = isZero
    ? "a pre-authorization hold (no monetary charge)"
    : `exactly ${safeAmount}`;
  return `${BASE_RULES}
You are a fraud agent for ${ctx.institution_name}.
You are verifying a transaction of ${amountPhrase}.
STRICT CURRENCY RULES:
1. You MUST state the amount as "${isZero ? "a pre-authorization hold" : safeAmount + " " + spokenCurrency}".
2. NEVER use currency symbols ($, د.إ, €).
3. NEVER convert the currency or guess exchange rates.
4. If the user asks what that is in their local currency, say "I cannot provide exchange rates; please check your banking app."
Verify a charge of ${amountPhrase} at ${ctx.merchant ?? "the merchant"}.
If NO: Say the card is temporarily restricted.`;
}
