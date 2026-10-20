import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLANS, formatMonthly } from "../../src/lib/commercial.ts";

/**
 * The PRICES the site publishes in PROSE must be the prices the catalog charges.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * The rate card moved — $99 / $499 / $2,000 became $2,500 / $9,000 / from
 * $25,000, and the overage moved from $0.15 / $0.12 (below cost on every route)
 * to $4.50 / $3.50 / $2.25. The CARDS changed, because the cards render from
 * the catalog. The PROSE did not: the pricing page's title, description and
 * OpenGraph copy, and the site-wide meta description in `layout.tsx`, all still
 * said "$99/month" and "Starter $99/month or $990/year".
 *
 * And nothing caught it. `tests/unit/tier-parity.test.ts` compares the page's
 * tier literals with the catalog, and the page's tier literals had been
 * updated — so it passed. `tests/unit/commercial-consistency.test.ts` checks
 * the catalog's own internal consistency and never reads the metadata. The one
 * prose check that did exist, "no user-facing string publishes a price the
 * page withholds", only looks for the WITHHELD figure; it cannot notice a
 * STALE one.
 *
 * The gap is not cosmetic. This is the text an answer engine quotes back when
 * a buyer asks what the product costs, and the copy on the marketing pages. A
 * site that prints $2,500 on the card and $99 in its own metadata is not
 * selling a price, it is selling two, and the one in the metadata is the one
 * that wins in a search result.
 *
 * So this file asserts, for every PUBLISHED tier, that its monthly price
 * appears in every prose surface that mentions prices at all — and that the
 * site-wide "from $X/month" is the LOWEST published price, which is what
 * "from" means.
 *
 * The surfaces are read from SOURCE rather than rendered, because a rendered
 * page would need the whole Next.js runtime to answer a question about three
 * strings. The slices are the same ones the withheld-price check uses: a long
 * string literal is something a reader can see; a number in a comment is not.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

/** Long string literals only — a figure in a comment reaches no reader. */
function prose(src: string): string[] {
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  return [...stripped.matchAll(/"([^"\\]{40,})"/g)].map((m) => m[1]!);
}

function sliceBetween(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  if (a === -1 || b === -1) throw new Error(`could not slice ${from} … ${to}`);
  return src.slice(a, b);
}

const PRICING_PAGE = read("src/app/pricing/page.tsx");
const LAYOUT = read("src/app/layout.tsx");
const COMMERCIAL = read("src/lib/commercial.ts");

/** The metadata an answer engine reads, and the page title. */
const PRICING_METADATA = sliceBetween(PRICING_PAGE, "export const metadata", "export default");
const LAYOUT_METADATA = sliceBetween(LAYOUT, "export const metadata", "export const viewport");
const FAQ = sliceBetween(COMMERCIAL, "export const FAQ", "\n];") + "\n]";

/**
 * The two strings the pricing page publishes, SEPARATELY.
 *
 * They are separate surfaces: the `description` is what a search result shows
 * and the `openGraph.description` is what a link preview shows. A check that
 * looked at the metadata block as one blob would pass while ONE of them went
 * stale, which is the same shape of gap this file was written for.
 */
const PRICING_DESCRIPTION = sliceBetween(PRICING_METADATA, "description:", "alternates:");
const PRICING_OG_DESCRIPTION = sliceBetween(PRICING_METADATA, "openGraph:", "};");

const PUBLISHED = PLANS.filter((p) => p.publiclyPriced !== false);
const HIDDEN = PLANS.filter((p) => p.publiclyPriced === false);

/** The monthly price as the copy writes it: `$2,500`. */
const asFigure = (usd: number) => `$${usd.toLocaleString("en-US")}`;

describe("the prices the site publishes in prose are the prices the catalog charges", () => {
  test("every published tier's monthly price is in the pricing page description", () => {
    const strings = prose(PRICING_DESCRIPTION);
    for (const plan of PUBLISHED) {
      const figure = asFigure(plan.monthlyUsd!);
      expect(
        strings.some((s) => s.includes(figure)),
        `the pricing page description never mentions ${plan.name} at ${figure}`,
      ).toBe(true);
    }
  });

  test("every published tier's monthly price is in the pricing page OpenGraph copy", () => {
    const strings = prose(PRICING_OG_DESCRIPTION);
    for (const plan of PUBLISHED) {
      const figure = asFigure(plan.monthlyUsd!);
      expect(
        strings.some((s) => s.includes(figure)),
        `the pricing page OpenGraph copy never mentions ${plan.name} at ${figure}`,
      ).toBe(true);
    }
  });

  test("the site-wide meta description carries the lowest published price", () => {
    // "Plans from $X/month" is a claim about the ENTRY price. If the lowest
    // published tier moves and this does not, the site's own front door quotes
    // a price nobody can buy.
    const lowest = Math.min(...PUBLISHED.map((p) => p.monthlyUsd!));
    const strings = prose(LAYOUT_METADATA);
    expect(
      strings.some((s) => s.includes(`from ${asFigure(lowest)}/month`)),
      `the site description does not say "from ${asFigure(lowest)}/month"`,
    ).toBe(true);
    // And it must not still be quoting a price that is no longer on the card.
    const stale = ["$99/month", "$499/month", "$2,000/month"];
    for (const s of strings) {
      for (const old of stale) {
        expect(
          s.includes(old),
          `the site description still quotes ${old}: ${s.slice(0, 90)}…`,
        ).toBe(false);
      }
    }
  });

  test("the FAQ states the published prices the cards print", () => {
    const strings = prose(FAQ);
    for (const plan of PUBLISHED) {
      const figure = asFigure(plan.monthlyUsd!);
      expect(
        strings.some((s) => s.includes(figure)),
        `the FAQ never mentions ${plan.name} at ${figure}`,
      ).toBe(true);
    }
  });

  test("no prose surface quotes a price that is not on the card", () => {
    // The inverse of the withheld-price check: this one looks for a figure
    // that appears in NO published plan. It is the check that would have
    // caught "$99/month" on the day the rate card moved.
    const publishedFigures = new Set(
      PUBLISHED.flatMap((p) => [
        asFigure(p.monthlyUsd!),
        p.yearlyUsd === null ? null : asFigure(p.yearlyUsd),
      ]).filter((f): f is string => f !== null),
    );
    // The figures the PREVIOUS rate card published. A stale one in the copy is
    // a price nobody can buy, and it is the thing this file exists for.
    const retired = ["$99", "$499", "$2,000", "$990", "$4,990", "$20,000"];
    for (const [name, raw] of [
      ["src/app/pricing/page.tsx", PRICING_DESCRIPTION],
      ["src/app/pricing/page.tsx (OpenGraph)", PRICING_OG_DESCRIPTION],
      ["src/app/layout.tsx", LAYOUT_METADATA],
      ["src/lib/commercial.ts (FAQ)", FAQ],
    ] as const) {
      for (const s of prose(raw)) {
        for (const old of retired) {
          expect(
            s.includes(old),
            `${name} still quotes the retired price ${old}: ${s.slice(0, 90)}…`,
          ).toBe(false);
        }
      }
    }
    // And the published figures themselves are all figures a plan carries.
    for (const s of prose(PRICING_DESCRIPTION)) {
      for (const m of s.matchAll(/\$[\d,]+/g)) {
        const figure = m[0]!;
        if (publishedFigures.has(figure)) continue;
        // A price that is neither a published plan's figure nor a retired one
        // is a THIRD number, and nothing knows where it came from.
        throw new Error(
          `${name} publishes ${figure}, which is not a price any plan carries: ${s.slice(0, 90)}…`,
        );
      }
    }
  });

  test("the withheld Enterprise price is still withheld everywhere", () => {
    // The existing check, restated here so the two live side by side: a price
    // the page hides must not appear in the copy either.
    const figures = HIDDEN.flatMap((p) =>
      [p.monthlyUsd, p.yearlyUsd]
        .filter((n): n is number => typeof n === "number")
        .flatMap((n) => [String(n), n.toLocaleString("en-US")]),
    );
    for (const [name, raw] of [
      ["src/app/pricing/page.tsx", PRICING_DESCRIPTION],
      ["src/app/pricing/page.tsx (OpenGraph)", PRICING_OG_DESCRIPTION],
      ["src/app/layout.tsx", LAYOUT_METADATA],
      ["src/lib/commercial.ts (FAQ)", FAQ],
    ] as const) {
      for (const s of prose(raw)) {
        for (const fig of figures) {
          expect(s.includes(fig), `${name} publishes the withheld price ${fig}`).toBe(false);
        }
      }
    }
  });

  test("the catalog and the formatter agree on what a plan costs", () => {
    // The last link in the chain: the figure the copy is checked against is
    // the figure the plan formats to.
    for (const plan of PUBLISHED) {
      expect(formatMonthly(plan, "en")).toBe(asFigure(plan.monthlyUsd!));
    }
  });
});
