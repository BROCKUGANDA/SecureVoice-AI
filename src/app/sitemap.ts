import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-origin";

/**
 * Re-exported, not reimplemented — see src/app/site-origin.ts. The surface test
 * imports `siteOrigin` from here, so the name is preserved.
 */
export { siteOrigin };

/**
 * Sitemap.
 *
 * A sitemap is an ASSERTION that these URLs are the public product. Everything
 * on it is a promise to a crawler that the page is meant to be read, so the
 * list is deliberately tiny and deliberately an allowlist.
 *
 * Why one entry and not thirteen: this is a single-page application.
 * `src/app/page.tsx` renders every view — home, product, use cases, docs,
 * security, privacy, terms, and the authenticated demo/dashboard/console — from
 * one client-side `view` state with no URL routing at all. The marketing, docs
 * and legal views are not separate URLs; they are panels inside `/`. So there is
 * exactly one indexable document in the tree.
 *
 * A sitemap listing `/console`, `/docs`, `/security` or `/pricing` would be
 * inventing URLs that return 404, and listing `/api/*` would be advertising the
 * API surface to every crawler on the internet. Both are the failure this file
 * exists to prevent, so tests/surface/surface.test.ts asserts the ABSENCE of
 * each of them rather than the presence of the ones we want.
 *
 * Kept in step with `INDEXABLE_PATHS` in src/proxy.ts and with `NO_INDEX` in
 * src/app/robots.ts; the test fails if the three disagree.
 */

/**
 * Paths that may appear in the sitemap. The source of truth for what is
 * indexable; `src/proxy.ts` enforces the same list in `X-Robots-Tag`.
 *
 * `/` plus the four standalone public routes. The marketing views still render
 * inside `/` (this is a single-page app with no URL routing for its panels), but
 * privacy, terms, refund and pricing are ALSO real routes at their own URLs:
 *
 *   - A crawler reads HTML. The in-app panels are behind a click, so without a
 *     route the text a Terms-and-Conditions audit looks for is not in the served
 *     document at all.
 *   - An answer engine will not cite a URL it cannot fetch.
 *   - "Accessible via navigation" only means something if the navigation points
 *     at a real, shareable address.
 *
 * Each of those routes renders the SAME view component the panel does, so the two
 * cannot drift apart in content — only the URL differs.
 */
export const INDEXABLE_PATHS = ["/", "/pricing", "/terms", "/privacy", "/refund"] as const;

/**
 * Paths that must never be listed, asserted negatively by the test so that a
 * future edit which adds one of them fails loudly instead of quietly shipping.
 */
export const MUST_NOT_LIST = [
  "/console",
  "/dashboard",
  "/settings",
  "/deck",
  "/api",
  "/v1",
  "/inspector",
  "/auth",
  "/demo",
] as const;

/**
 * `lastModified` is pinned to the build time rather than `new Date()`.
 *
 * A metadata route is a Route Handler that is CACHED BY DEFAULT, so
 * `new Date()` would be evaluated once and then frozen for the life of the
 * deployment — it looks dynamic in the source and is not. Pinning it to the
 * build timestamp makes the static-cache behaviour explicit: the value changes
 * exactly when the content can have changed, and a `Date.now()` in the file
 * would have looked like it was doing something it is not.
 */
const BUILD_TIME = new Date();

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  // `/` is the product page and is the canonical destination for everything a
  // visitor might be shown; the four legal/commercial routes exist because a
  // document that is only reachable by clicking is not reachable by a crawler.
  // Priorities: the root is 1.0, and pricing is 0.9 because it is the page a
  // commercial query lands on. The legal documents sit at 0.5 — real content,
  // but not something to outrank the product for.
  const PRIORITY: Record<string, number> = {
    "/": 1.0,
    "/pricing": 0.9,
    "/terms": 0.5,
    "/privacy": 0.5,
    "/refund": 0.5,
  };

  return INDEXABLE_PATHS.map((path) => ({
    url: `${origin}${path}`,
    lastModified: BUILD_TIME,
    changeFrequency: "weekly" as const,
    priority: PRIORITY[path] ?? 0.5,
  }));
}
