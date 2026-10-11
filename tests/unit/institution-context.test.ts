/**
 * Unit tests for the institution label vocabulary.
 *
 * ## Why this file exists
 *
 * This module is the single source of truth for operator-facing vocabulary: a
 * bank sees "Transaction" / "Freeze Card", an insurer sees "Claim" / "Pause
 * Payout", and a takaful insurer sees "Contribution" instead of "Premium". The
 * signal form, the case list, the runbook and the delivery card all read from
 * here SO THE UI NEVER HARDCODES A BANKING TERM THAT WOULD BE WRONG FOR AN
 * INSURER.
 *
 * The failure mode is therefore not a crash, it is a bank term appearing in
 * front of an insurer — e.g. a takaful operator being asked to confirm a
 * "Premium" when their product is a "Contribution". That is a compliance
 * problem in a jurisdiction where the distinction is regulated, and it is
 * invisible in a diff. These specs pin every branch.
 *
 *   bun test tests/unit/institution-context.test.ts
 */
import { test, expect, describe } from "bun:test";
import {
  getInstitutionLabels,
  defaultProductType,
  type InstitutionLabels,
} from "@/lib/institution-context";

describe("getInstitutionLabels — a bank", () => {
  const l: InstitutionLabels = getInstitutionLabels("bank");

  test("speaks banking vocabulary", () => {
    expect(l.productNoun).toBe("Transaction");
    expect(l.merchantLabel).toBe("Merchant");
    expect(l.actionLabel).toBe("Freeze Card");
    expect(l.amountLabel).toBe("Charge Amount");
    expect(l.accountNoun).toBe("Card");
    expect(l.premiumNoun).toBe("Premium");
    expect(l.institutionNoun).toBe("Bank");
  });

  test("shariah compliance does not change a bank's vocabulary", () => {
    // The flag is meaningful only for an insurer; a bank must be unaffected.
    expect(getInstitutionLabels("bank", true)).toEqual(getInstitutionLabels("bank", false));
  });
});

describe("getInstitutionLabels — an insurer", () => {
  const l = getInstitutionLabels("insurer");

  test("speaks claims vocabulary, not banking vocabulary", () => {
    expect(l.productNoun).toBe("Claim");
    expect(l.actionLabel).toBe("Pause Payout");
    expect(l.amountLabel).toBe("Claim Amount");
    expect(l.statusLabel).toBe("Claim Validated");
    expect(l.fraudLabel).toBe("Claim Flagged");
    expect(l.accountNoun).toBe("Policy");
  });

  test("a conventional insurer still says Premium, not Contribution", () => {
    expect(l.premiumNoun).toBe("Premium");
    expect(l.institutionNoun).toBe("Insurance");
  });
});

describe("getInstitutionLabels — a takaful insurer", () => {
  const l = getInstitutionLabels("insurer", true);

  test("uses Contribution and Takaful, the regulated terms", () => {
    // The distinction that makes this file exist: presenting a takaful
    // contribution as a conventional premium is a mis-description of the
    // product, not a wording preference.
    expect(l.premiumNoun).toBe("Contribution");
    expect(l.institutionNoun).toBe("Takaful");
  });

  test("keeps the rest of the claims vocabulary", () => {
    expect(l.productNoun).toBe("Claim");
    // Takaful uses its own action wording — a disbursement is paused, not a
    // payout — so this is deliberately NOT "Pause Payout".
    expect(l.actionLabel).toBe("Pause Disbursement");
    expect(l.accountNoun).toBe("Policy");
  });

  test("shariahCompliant=false on an insurer is the conventional wording", () => {
    expect(getInstitutionLabels("insurer", false)).toEqual(getInstitutionLabels("insurer"));
  });
});

describe("getInstitutionLabels — defensive inputs", () => {
  test("a missing type resolves to bank rather than throwing", () => {
    // Every tenant had the bank default before the column existed, so an
    // unrecognised value must degrade there and never block a call.
    expect(getInstitutionLabels(undefined)).toEqual(getInstitutionLabels("bank"));
    expect(getInstitutionLabels(null)).toEqual(getInstitutionLabels("bank"));
  });

  test("an unrecognised stored value resolves to bank", () => {
    expect(getInstitutionLabels("credit-union")).toEqual(getInstitutionLabels("bank"));
    expect(getInstitutionLabels("")).toEqual(getInstitutionLabels("bank"));
  });
});

describe("defaultProductType", () => {
  test("a bank's default signal is a card transaction", () => {
    expect(defaultProductType("bank")).toBe("card_transaction");
  });

  test("an insurer's default signal is a claim payout", () => {
    expect(defaultProductType("insurer")).toBe("claim_payout");
  });

  test("a missing type falls back to the bank signal", () => {
    expect(defaultProductType(undefined)).toBe("card_transaction");
  });
});
