/**
 * The transaction token Paddle puts in the checkout link it returns.
 *
 * `POST /transactions` answers with `checkout.url`, and the host of that URL is
 * the vendor's configured checkout domain — measured against the sandbox account
 * on 2026-10-14, it handed back
 * `https://<our own domain>/checkout?_ptxn=txn_01m4wg7hx34a4p2j23tzd3rgm4`. Paddle
 * does that because it expects the merchant to serve this page (the documented
 * self-hosted checkout: render a page, read `_ptxn`, open Paddle.js against it).
 * Until now nothing in the app answered that path, so the link the platform gave
 * a buyer — in an email, in an operator's copy-paste, in a manual invoice — landed
 * on a 404 while the transaction sat `draft` in Paddle.
 *
 * The validation lives here rather than inside the page because the page is a
 * React component and this decision is not: what may be opened is a rule, and a
 * rule with no caller is a rule with no test.
 */

/** Paddle transaction ids: `txn_` plus a base32-ish body. Bounded so a hostile
 *  query string cannot become a long attribute in the client bundle. */
const TXN = /^txn_[0-9A-Za-z]{8,40}$/;

export function checkoutTransactionId(
  raw: string | string[] | undefined,
): { ok: true; transactionId: string } | { ok: false; reason: "absent" | "malformed" } {
  if (raw === undefined) return { ok: false, reason: "absent" };
  // A repeated `?_ptxn=a&_ptxn=b` is not a transaction. Taking the first would
  // open whichever one a proxy happened to order first.
  if (Array.isArray(raw)) return { ok: false, reason: "malformed" };
  const value = raw.trim();
  if (value === "") return { ok: false, reason: "absent" };
  if (!TXN.test(value)) return { ok: false, reason: "malformed" };
  return { ok: true, transactionId: value };
}
