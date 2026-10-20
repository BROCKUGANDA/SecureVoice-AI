/**
 * `src/views/Pricing.tsx` does NOT render `PLANS`.
 *
 * It keeps its own `TIERS` array — a second, independent copy of the same three
 * numbers — and the page a customer actually sees is built from that copy, not
 * from `src/lib/commercial.ts`. Every other pricing guard in this repo
 * (`commercial-consistency.test.ts`, `catalog-parity.test.ts`) checks `PLANS`
 * against the Paddle catalog, so all of them pass happily while the live page
 * shows whatever `TIERS` happens to say.
 *
 * That gap is not hypothetical: it is how the Enterprise price stayed visible on
 * the public page after `PLANS` was changed. Nothing failed. That is the whole
 * reason this file exists.
 *
 * Parsed from source rather than imported. `Pricing.tsx` is `"use client"` and
 * pulls in framer-motion, the Paddle browser SDK and the store; importing it to
 * read three numbers would make this test depend on all of that loading
 * successfully. A regex over the file is also more honest about what it is
 * checking — the literal numbers a reader of the source would see.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLANS } from "../../src/lib/commercial.ts";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const PRICING_SRC = read("src/views/Pricing.tsx");

type TierLiteral = {
  id: string;
  usd: number;
  included: number;
  publiclyPriced: boolean;
};

/**
 * Pull the three tier literals out of the source.
 *
 * Scoped to the `TIERS` array so a `usd:` appearing in a comment, a helper or
 * the AED function is not mistaken for a tier. Matches the shape the file
 * actually uses rather than trying to be a general parser.
 */
function parseTiers(src: string): TierLiteral[] {
  const start = src.indexOf("const TIERS: Tier[] = [");
  if (start === -1) throw new Error("TIERS array not found in Pricing.tsx");
  const end = src.indexOf("\n];", start);
  if (end === -1) throw new Error("TIERS array is unterminated in Pricing.tsx");
  const body = src.slice(start, end);

  const out: TierLiteral[] = [];
  // Each tier literal begins with `id: "<id>"`; capture everything up to the
  // next one (or the end) so the flags belong to the tier they follow.
  const idRe = /id:\s*"(pilot|starter|growth|enterprise)"/g;
  const hits = [...body.matchAll(idRe)];
  for (let i = 0; i < hits.length; i++) {
    // `hits[i]` is present by construction and `matchAll` guarantees `index`;
    // the guards below turn that into a hard failure rather than a `!` that
    // would let a restructured array silently parse as fewer tiers.
    const hit = hits[i];
    if (!hit || hit.index === undefined) continue;
    const next = hits[i + 1];
    const chunk = body.slice(hit.index, next?.index ?? body.length);

    const id = hit[1];
    const usd = chunk.match(/usd:\s*(\d+)/);
    const included = chunk.match(/included:\s*(\d+)/);
    if (!id || !usd || !included) throw new Error(`tier ${id ?? i} is missing id/usd/included`);
    out.push({
      id,
      usd: Number(usd[1]),
      included: Number(included[1]),
      publiclyPriced: !/publiclyPriced:\s*false/.test(chunk),
    });
  }
  return out;
}

const TIERS = parseTiers(PRICING_SRC);

describe("Pricing.tsx tiers vs commercial.ts plans", () => {
  test("the parser found exactly the four published tiers", () => {
    // A guard on the guard. If the array is renamed or restructured, `parseTiers`
    // returns fewer tiers and every assertion below silently compares a subset —
    // which would make this file pass while checking almost nothing.
    expect(TIERS.map((t) => t.id).sort()).toEqual(["enterprise", "growth", "pilot", "starter"]);
  });

  test("every tier in the view has a matching plan, and vice versa", () => {
    expect(TIERS.map((t) => t.id).sort()).toEqual(PLANS.map((p) => p.id).sort());
  });

  test.each(TIERS.map((t) => [t.id, t] as const))(
    "%s: the page and the catalog agree on price and volume",
    (_id, tier) => {
      const plan = PLANS.find((p) => p.id === tier.id)!;
      // Narrowed explicitly rather than with `as number`: a null here is a real
      // failure — it would mean the page prints a number for a tier the catalog
      // no longer prices — and it deserves to be reported as one.
      expect(plan.monthlyUsd, `${tier.id} has no catalog price`).not.toBeNull();
      expect(plan.includedPerMonth, `${tier.id} has no volume`).not.toBeNull();
      // The number the page PRINTS. It must equal the number Paddle charges —
      // that is the guarantee a buyer is owed, and it holds whether or not the
      // tier publishes the figure.
      expect(tier.usd, `${tier.id} price`).toBe(plan.monthlyUsd!);
      expect(tier.included, `${tier.id} included volume`).toBe(plan.includedPerMonth!);
    },
  );

  test("whether a tier prints its price is the same decision in both files", () => {
    // The failure this exists to catch: PLANS says "not published" and TIERS
    // still prints the number (or the reverse), so the page contradicts either
    // the structured data or the sales conversation.
    for (const tier of TIERS) {
      const plan = PLANS.find((p) => p.id === tier.id)!;
      expect(tier.publiclyPriced, `${tier.id} price visibility`).toBe(plan.publiclyPriced);
    }
  });

  test("the page cannot print a number the plan withholds", () => {
    // Belt and braces on the real risk: a view that hardcodes `${tier.usd}` in
    // some second place would print $2,000 next to "Custom". The render is
    // conditional, so the only unguarded form would be a new one.
    const guarded = /publiclyPriced\s*===\s*false/.test(PRICING_SRC);
    expect(guarded, "Pricing.tsx has no publiclyPriced guard").toBe(true);
    // And the contact-sales tier really is the one that is hidden.
    const enterprise = TIERS.find((t) => t.id === "enterprise");
    expect(enterprise?.publiclyPriced).toBe(false);
  });

  test("no user-facing string publishes a price the page withholds", () => {
    // The failure this was written after: the Enterprise price came off the
    // card but stayed in the page's meta description, in the OpenGraph copy and
    // in the Arabic FAQ. None of those are the pricing card, so none of them
    // would be noticed by looking at the page — and the meta description is
    // exactly what a search engine or an answer engine quotes back.
    //
    // Scoped to PROSE rather than the whole file: `monthlyUsd: 2000` and the
    // comments explaining the decision both legitimately contain the figure.
    // Only long string literals are read, because only those reach a reader.
    const hidden = PLANS.filter((p) => p.publiclyPriced === false && p.monthlyUsd !== null);
    expect(hidden.length, "no tier exercises the hidden-price path").toBeGreaterThan(0);

    // Scoped to the actual user-facing constants rather than whole files.
    // Whole-file scanning is unreliable here: the first version matched
    // property names inside the `Plan` type, because any unbalanced quote
    // anywhere in a file makes a naive "..." regex span arbitrary code between
    // two unrelated quotes. Slicing to the constant cannot do that.
    const sliceBetween = (src: string, from: string, to: string): string => {
      const a = src.indexOf(from);
      const b = src.indexOf(to, a + from.length);
      if (a === -1 || b === -1) throw new Error(`could not slice ${from} … ${to}`);
      return src.slice(a, b);
    };

    const pricingPage = read("src/app/pricing/page.tsx");
    const commercialSrc = read("src/lib/commercial.ts");
    const surfaces: Array<[string, string]> = [
      [
        "src/app/pricing/page.tsx metadata",
        sliceBetween(pricingPage, "export const metadata", "export default"),
      ],
      [
        "src/lib/commercial.ts FAQ",
        sliceBetween(commercialSrc, "export const FAQ", "\n];") + "\n]",
      ],
    ];

    // Strip comments before reading string literals — comments are not read by
    // any visitor, and they legitimately discuss the hidden figure.
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

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

/*
 * NOT TESTED HERE, deliberately: "does any Arabic string contain an English
 * word?"
 *
 * A version of that check was written and immediately caught a real bug in this
 * file — an Arabic feature bullet reading "تسعير volumes مخصص", where the noun
 * "volumes" had been left in English. That is fixed.
 *
 * But the same check then failed on "استخدام مفتاح ElevenLabs الخاص بك", which
 * is correct Arabic: ElevenLabs is a product name and is not translated. Any
 * allowlist distinguishing those two cases is either a fixed list that every new
 * brand name breaks, or a language model in the test runner. Both are worse than
 * the bug they were aimed at: the first trains people to delete failing tests,
 * the second puts a non-determinism into a gate that everything else here
 * depends on being exact.
 *
 * The regression it was watching for is better caught by a human reading the
 * Arabic, or by native review, than by a regex.
 */
