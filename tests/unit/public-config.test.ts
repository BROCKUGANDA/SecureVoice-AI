/**
 * Unit tests for the public contact addresses.
 *
 * ## Why this file exists
 *
 * These four constants are the ONLY contact details on the public surface, and
 * they have shipped wrong before in a way no test would have caught:
 *
 *   - `team@securevoice.ai` — the lookalike domain, which resolves to an
 *     UNRELATED THIRD PARTY. A customer writing to "support" was writing to a
 *     stranger, and a bank sending a DPA to that address was sending it to a
 *     competitor.
 *   - `otemaach@gmail.com` — a personal address published in structured data.
 *   - `api.securevoice.ae` — an origin that does not resolve at all (NXDOMAIN),
 *     so every API example on the docs page was a dead link.
 *
 * The assertion that matters is therefore not "the constants exist" but "every
 * address is on the domain this platform actually controls". A typo in the
 * local part is cosmetic; a typo in the DOMAIN sends a bank's data elsewhere.
 *
 *   bun test tests/unit/public-config.test.ts
 */
import { test, expect, describe } from "bun:test";
import { SUPPORT_EMAIL, LEGAL_EMAIL, FOUNDER_EMAIL, API_BASE_URL } from "@/lib/public-config";

/** The domain the platform actually sends from and controls. */
const OWNED = "securevoiceai.me";

/** Every published address must be on it. */
const ADDRESSES: Array<[string, string]> = [
  ["SUPPORT_EMAIL", SUPPORT_EMAIL],
  ["LEGAL_EMAIL", LEGAL_EMAIL],
  ["FOUNDER_EMAIL", FOUNDER_EMAIL],
];

describe("published contact addresses", () => {
  test.each(ADDRESSES)("%s is on the owned domain", (_name, address) => {
    expect(address).toMatch(new RegExp(`@${OWNED.replace(".", "\\.")}$`));
  });

  test.each(ADDRESSES)("%s is not on the lookalike domain", (_name, address) => {
    // securevoice.ai is an unrelated third party. Writing to it looks correct
    // and lands with a stranger.
    expect(address.endsWith("@securevoice.ai")).toBe(false);
  });

  test.each(ADDRESSES)("%s is not a personal mailbox", (_name, address) => {
    expect(address).not.toMatch(/@(gmail|yahoo|outlook|hotmail|proton)/i);
  });

  test.each(ADDRESSES)("%s is a single well-formed address", (_name, address) => {
    expect(address).toMatch(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i);
    // Exactly one @, and no list — a "to" with two addresses silently mails
    // both, and one of them may not be intended.
    expect(address.split("@")).toHaveLength(2);
  });

  test("each address is distinct, so no mailbox is asked to be three roles", () => {
    const all = ADDRESSES.map(([, a]) => a);
    expect(new Set(all).size).toBe(all.length);
  });

  test("the three documented roles are all present", () => {
    expect(SUPPORT_EMAIL.startsWith("support@")).toBe(true);
    expect(LEGAL_EMAIL.startsWith("legal@")).toBe(true);
    expect(FOUNDER_EMAIL.startsWith("founder@")).toBe(true);
  });
});

describe("API_BASE_URL", () => {
  test("is an https origin on the owned domain", () => {
    expect(API_BASE_URL.startsWith("https://")).toBe(true);
    expect(new URL(API_BASE_URL).hostname).toBe(OWNED);
  });

  test("is not the .ae origin that does not resolve", () => {
    // The previous default made every API example on the docs page a dead link.
    expect(API_BASE_URL).not.toContain(".ae");
  });

  test("carries no trailing slash, so a path joins cleanly", () => {
    expect(API_BASE_URL.endsWith("/")).toBe(false);
  });
});
