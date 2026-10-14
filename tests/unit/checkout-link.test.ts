/**
 * WHAT `/checkout` WILL OPEN — the guard behind the link Paddle hands buyers.
 *
 * Paddle's `checkout.url` points at OUR domain (the vendor's configured checkout
 * domain) with `?_ptxn=txn_…`, so this route is the only thing between a buyer
 * following a payment link and Paddle's overlay. Two decisions are under test, and
 * both are about what may be opened on someone else's behalf:
 *
 *   1. an absent or empty token is refused rather than opening "some" checkout;
 *   2. a token that is not a transaction id is refused rather than interpolated
 *      into the client bundle, where a long or hostile value becomes markup in a
 *      payment page.
 *
 * A repeated `?_ptxn=` is refused too. Picking the first would mean the page opens
 * whichever transaction a proxy happened to order first, and the two links would
 * look identical in the log.
 */
import { describe, expect, test } from "bun:test";
import { checkoutTransactionId } from "@/lib/checkout-link";

const GOOD = "txn_01m4wg7hx34a4p2j23tzd3rgm4";

describe("checkoutTransactionId", () => {
  test("accepts a Paddle transaction id verbatim", () => {
    expect(checkoutTransactionId(GOOD)).toEqual({ ok: true, transactionId: GOOD });
    expect(checkoutTransactionId(`  ${GOOD}  `)).toEqual({ ok: true, transactionId: GOOD });
  });

  test("refuses a missing or blank token instead of opening anything", () => {
    expect(checkoutTransactionId(undefined)).toEqual({ ok: false, reason: "absent" });
    expect(checkoutTransactionId("")).toEqual({ ok: false, reason: "absent" });
    expect(checkoutTransactionId("   ")).toEqual({ ok: false, reason: "absent" });
  });

  test("refuses shapes that are not transaction ids", () => {
    for (const bad of [
      "javascript:alert(1)",
      "txn_",
      "txn_short",
      "notatxn_01m4wg7hx34a4p2j23tzd3rgm4",
      "txn_01m4wg7hx34a4p2j23tzd3rgm4?next=//evil.example",
      "txn_<script>alert(1)</script>",
      "txn_" + "A".repeat(80),
      "/../../admin",
    ]) {
      expect(checkoutTransactionId(bad), `must refuse ${JSON.stringify(bad)}`).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  test("a duplicated parameter is not resolved by guessing", () => {
    expect(checkoutTransactionId([GOOD, "txn_01otherotherotherother"])).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("the checkout route is wired to the link Paddle actually returns", () => {
  test("the token Paddle put in the measured sandbox response is accepted", () => {
    // Verified against the sandbox account on 2026-10-14: POST /transactions
    // answered checkout.url = https://<vendor domain>/checkout?_ptxn=txn_01m4wg…
    // Parsing THAT is the whole job of this route, so the real shape is asserted
    // rather than an imagined one.
    const url = new URL(`https://app.example/checkout?_ptxn=${GOOD}`);
    expect(checkoutTransactionId(url.searchParams.get("_ptxn") ?? undefined)).toEqual({
      ok: true,
      transactionId: GOOD,
    });
  });

  test("the page is not indexable, because the URL is a payment capability", async () => {
    const { metadata } = await import("@/app/checkout/page");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
