/**
 * UNIT — wallet-empty detection for the console fire response.
 *
 * The property under test: the dialog fires on a genuine wallet-empty REFUSAL
 * and stays closed on a SUCCESS that merely emptied the wallet. That
 * distinction is the whole feature — telling an operator to top up after a call
 * that succeeded is the false alarm this file exists to prevent.
 */
import { describe, expect, test } from "bun:test";
import { walletEmptyNotice } from "@/lib/credits-wallet";

describe("walletEmptyNotice", () => {
  test("the 402 body — an error with credits: 0 — is a wallet-empty refusal", () => {
    expect(
      walletEmptyNotice({
        error: "Insufficient credits — your wallet is empty. Contact your administrator to top up.",
        credits: 0,
      }),
    ).toBe(true);
  });

  test("a refusal carrying the vendor text but no credits field still reads as empty", () => {
    expect(walletEmptyNotice({ error: "Insufficient credits" })).toBe(true);
    expect(walletEmptyNotice({ error: "out of credits" })).toBe(true);
  });

  test("a SUCCESS that claimed the last credit does NOT raise the dialog", () => {
    // creditsRemaining: 0 with a caseRef and no error: the call went through.
    expect(walletEmptyNotice({ caseRef: "SV-8642", creditsRemaining: 0 })).toBe(false);
  });

  test("a delivery failure is not a wallet problem", () => {
    expect(walletEmptyNotice({ error: "delivery_failed: carrier rejected", credits: 4 })).toBe(
      false,
    );
    expect(walletEmptyNotice({ error: "Network error — the signal never left." })).toBe(false);
  });

  test("null / undefined / empty bodies are never a wallet problem", () => {
    expect(walletEmptyNotice(null)).toBe(false);
    expect(walletEmptyNotice(undefined)).toBe(false);
    expect(walletEmptyNotice({})).toBe(false);
  });
});
