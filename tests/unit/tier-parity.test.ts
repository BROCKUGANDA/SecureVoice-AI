import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLANS } from "../../src/lib/commercial.ts";

/**
 * `src/views/Pricing.tsx` renders `PLANS`. It does NOT keep a copy of it.
 *
 * ── What this file used to be, and why it is now something else ─────────────
 *
 * The pricing page used to carry its own `TIERS` array — a hand-written
 * second copy of the prices, the volumes and the overage — and this file
 * existed to keep the two in step. It caught real drift, but it could only
 * catch it AFTER the drift: the page and the catalog were two documents that
 * had to agree, and when the rate card moved ($99 / $499 / $2,000 became
 * $2,500 / $9,000 / from $25,000) the card's copy was updated while the
 * page's METADATA was not, and the parity test passed — because it compared
 * the card's literals with the catalog, and the card's literals were right.
 *
 * The page now renders `PLANS` directly. There is no second copy, so there is
 * nothing to keep in step, and the test's job changes from "keep two things
 * equal" to "make sure the second copy does not come back".
 *
 * The copy that is NOT in the catalog — the page title, the meta description,
 * the OpenGraph copy, the FAQ — is checked by `tests/unit/pricing-prose.test.ts`.
 * Between the two, every price the site can show is checked against one
 * source.
 *
 * Parsed from source rather than imported. `Pricing.tsx` is `"use client"` and
 * pulls in framer-motion, the Paddle browser SDK and the store; importing it
 * to read a number would make this test depend on all of that loading
 * successfully. A regex over the file is also more honest about what it is
 * checking — the literal numbers a reader of the source would see.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const PRICING_SRC = read("src/views/Pricing.tsx");
const COMMERCIAL_SRC = read("src/lib/commercial.ts");

describe("the pricing page has ONE rate card", () => {
  test("it imports the catalog rather than restating it", () => {
    expect(PRICING_SRC).toMatch(/import\s*\{[^}]*\bPLANS\b[^}]*\}\s*from\s*"@\/lib\/commercial"/);
  });

  test("it carries no hand-written tier literals", () => {
    // A `usd:` literal in this file is a second copy of a price, and a second
    // copy of a price is the exact defect this file used to exist to police.
    // The only `usd` in the file is the AED peg constant, which is a RATE and
    // not a price.
    expect(PRICING_SRC).not.toMatch(/^\s*usd:\s*\d+/m);
    expect(PRICING_SRC).not.toMatch(/^\s*included:\s*\d+/m);
    expect(PRICING_SRC).not.toMatch(/type Tier\s*=/);
  });

  test("the card renders the catalog's own fields", () => {
    // If the card ever goes back to reading its own numbers, one of these
    // disappears and the card silently starts quoting something the catalog
    // does not sell.
    for (const field of ["monthlyUsd", "includedPerMonth", "publiclyPriced", "oneOff"]) {
      expect(PRICING_SRC, `the card no longer renders ${field}`).toContain(field);
    }
    // And the overage line is FORMATTED from the catalog's rate, so the
    // wording and the number cannot drift.
    expect(PRICING_SRC).toContain("formatOveragePhrase");
  });

  test("the card's bullets are the catalog's bullets", () => {
    expect(PRICING_SRC).toContain("tier.includes");
    expect(PRICING_SRC).toContain("tier.includesAr");
  });
});

describe("a price the page withholds is withheld everywhere", () => {
  const hidden = PLANS.filter((p) => p.publiclyPriced === false && p.monthlyUsd !== null);

  test("there is a tier exercising the hidden-price path", () => {
    expect(hidden.length, "no tier exercises the hidden-price path").toBeGreaterThan(0);
  });

  test("no user-facing string publishes a withheld price", () => {
    // The failure this was written after: the Enterprise price came off the
    // card but stayed in the page's meta description, in the OpenGraph copy and
    // in the Arabic FAQ. None of those are the pricing card, so none of them
    // would be noticed by looking at the page — and the meta description is
    // exactly what a search engine or an answer engine quotes back.
    //
    // Scoped to PROSE rather than the whole file: `monthlyUsd: 25000` and the
    // comments explaining the decision both legitimately contain the figure.
    // Only long string literals are read, because only those reach a reader.
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

    const sliceBetween = (src: string, from: string, to: string): string => {
      const a = src.indexOf(from);
      const b = src.indexOf(to, a + from.length);
      if (a === -1 || b === -1) throw new Error(`could not slice ${from} … ${to}`);
      return src.slice(a, b);
    };

    const surfaces: Array<[string, string]> = [
      [
        "src/app/pricing/page.tsx metadata",
        sliceBetween(read("src/app/pricing/page.tsx"), "export const metadata", "export default"),
      ],
      [
        "src/lib/commercial.ts FAQ",
        sliceBetween(COMMERCIAL_SRC, "export const FAQ", "\n];") + "\n]",
      ],
    ];

    for (const plan of hidden) {
      const figures = [plan.monthlyUsd!, plan.yearlyUsd!]
        .filter((n): n is number => typeof n === "number")
        .flatMap((n) => [String(n), n.toLocaleString("en-US")]);
      for (const [name, raw] of surfaces) {
        for (const m of stripComments(raw).matchAll(/"([^"\\]{40,})"/g)) {
          const s = m[1]!;
          for (const fig of figures) {
            expect(
              s.includes(fig),
              `${name} publishes the hidden ${plan.name} price (${fig}) in prose: ${s.slice(0, 90)}…`,
            ).toBe(false);
          }
        }
      }
    }
  });
});
