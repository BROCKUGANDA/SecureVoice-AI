/**
 * Wallet-empty detection for the console's fire response.
 *
 * The fire endpoint refuses with a wallet-empty body (HTTP 402) when an org's
 * prepaid credits run out; the console turns that into a top-up dialog rather
 * than a raw error line — the "we understand SaaS unit economics" moment in a
 * demo, and the correct operator prompt in production.
 *
 * Detection is from the RESPONSE SHAPE (error text + credit fields), not the
 * HTTP status: the console's fire handler reads the JSON body, and a proxy or
 * an error page can normalise a 402 into a 200-shaped envelope. The one thing
 * it must NOT do is fire on a SUCCESS that merely emptied the wallet — a fire
 * that claimed the last credit and went through carries `creditsRemaining: 0`
 * with a `caseRef` and no `error`, and must not raise a top-up dialog.
 */

export type WalletResponse = {
  error?: string;
  credits?: number;
  creditsRemaining?: number;
  caseRef?: string;
};

const WALLET_EMPTY = /insufficient credits|wallet is empty|out of credits|top up/i;

export function walletEmptyNotice(res: WalletResponse | null | undefined): boolean {
  // A refusal always carries an error; a success that emptied the wallet does not.
  if (!res || !res.error) return false;
  // The 402 body is `{ error, credits: 0 }`; a delivery failure keeps credits > 0.
  if (res.credits === 0) return true;
  // Belt and braces: the vendor's refusal text is the same in every phrasing.
  return WALLET_EMPTY.test(res.error);
}
