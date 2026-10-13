/**
 * UNIT — the tokenized case-destination resolve path (pii_vault → dial).
 *
 * The schema comment on Case.customerPhoneToken promises that raw phone values
 * are sealed in the org-scoped vault and the case row carries only the token.
 * The dial worker resolves the destination through this helper, so the contract
 * under test is exactly the one a fraud call depends on:
 *
 *   1. a tokenized row resolves to the plaintext FOR THE STORING ORG ONLY;
 *   2. a foreign org's token never resolves — the legacy raw column (if any)
 *      is the only thing that can still answer, and only for its own row;
 *   3. rows created before tokenization resolve from the legacy raw column;
 *   4. nothing anywhere resolves to null, which the dial path treats as "no
 *      destination" and fails closed — a secret rotation must never dial a
 *      stale or wrong number.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { db } from "@/lib/db";
import { resolveCasePhone, storePii } from "@/lib/compliance/pii-vault";

// The vault refuses to seal without the keying secret — byokKey throws rather
// than encrypt under a guessable key — so a suite that wants to prove the
// round-trip brings its own fixed test key, the same way the pii-vault suite
// does. Never a real credential.
process.env.AUTH_SECRET = "case-phone-token-suite-key-0123456789abcdef0123456789abcdef";

const mintedTokens: string[] = [];

afterAll(async () => {
  for (const token of mintedTokens) {
    await db.$executeRaw`DELETE FROM "pii_vault" WHERE "token" = ${token}`;
  }
});

describe("resolveCasePhone", () => {
  test("resolves a tokenized row through the vault, scoped to the storing org", async () => {
    const orgId = `org-${randomUUID()}`;
    const phone = "+971501234567";
    const token = await storePii({ orgId, type: "phone", plaintext: phone });
    mintedTokens.push(token);

    const resolved = await resolveCasePhone({ customerPhoneToken: token, phone: null }, orgId);
    expect(resolved).toBe(phone);
  });

  test("another org's token does not resolve — the row's own legacy column answers", async () => {
    const ownerOrg = `org-${randomUUID()}`;
    const token = await storePii({
      orgId: ownerOrg,
      type: "phone",
      plaintext: "+971509999999",
    });
    mintedTokens.push(token);

    const legacy = "+971501111111";
    const resolved = await resolveCasePhone(
      { customerPhoneToken: token, phone: legacy },
      `org-${randomUUID()}`,
    );
    expect(resolved).toBe(legacy);
  });

  test("a legacy row without a token resolves from the raw column", async () => {
    const legacy = "+971502222222";
    expect(await resolveCasePhone({ customerPhoneToken: null, phone: legacy }, null)).toBe(legacy);
  });

  test("a token with no org context cannot resolve and there is nothing to fall back to", async () => {
    const orgId = `org-${randomUUID()}`;
    const token = await storePii({ orgId, type: "phone", plaintext: "+971503333333" });
    mintedTokens.push(token);

    expect(await resolveCasePhone({ customerPhoneToken: token, phone: null }, null)).toBeNull();
  });

  test("nothing anywhere resolves to null — the dial path fails closed", async () => {
    expect(await resolveCasePhone(null, null)).toBeNull();
    expect(await resolveCasePhone({ customerPhoneToken: null, phone: null }, "org-x")).toBeNull();
  });
});
