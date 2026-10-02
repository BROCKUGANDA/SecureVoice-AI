import type { MetadataRoute } from "next";

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
 * `/` only. Adding a genuinely public page (a real `/blog`, a real `/pricing`
 * page) means adding it here and to `INDEXABLE_PATHS` — and creating the route
 * itself, which does not currently exist for any of the marketing views.
 */
export const INDEXABLE_PATHS = ["/"] as const;

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
 * Absolute origin. Same resolution order and the same reasoning as in
 * src/app/robots.ts: `NEXT_PUBLIC_SITE_URL` first (not yet in .env.example —
 * see docs/SURFACE.md), then the TLS hostname `SITE_ADDRESS` promoted to
 * https, then a local fallback so a dev build still emits valid XML.
 */
export function siteOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const host = process.env.SITE_ADDRESS?.trim();
  if (!host || host === "localhost") return "http://localhost:3000";
  return `https://${host}`;
}

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
  return INDEXABLE_PATHS.map((path) => ({
    url: `${origin}${path}`,
    lastModified: BUILD_TIME,
    changeFrequency: "weekly" as const,
    // 1.0 for the one canonical entry: this IS the product page, not one page
    // among many. Do not lower it to make room — there is nothing else here.
    priority: 1.0,
  }));
}