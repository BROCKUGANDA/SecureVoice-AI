import type { MetadataRoute } from "next";

/**
 * Crawler policy.
 *
 * The single most important thing to know before editing this file: **there is
 * no `/console` URL in this application.**
 *
 * `src/app/page.tsx` renders every view — marketing, docs, security, legal, and
 * the authenticated Command Center — from a single client-side `view` state.
 * There is no `usePathname`, no `router.push` and no `history.pushState`
 * anywhere in the tree, so the console is not a route that a crawler could be
 * pointed at even if we wanted to. What we CAN do is make sure no crawler is
 * ever handed a URL that resolves to it, and that the machine-readable rules
 * match what `src/proxy.ts` puts in `X-Robots-Tag`.
 *
 * That leaves two HTML routes in the tree, `/` and `/inspector`, and
 * `/inspector` is a webhook signature-verification debug tool. So "marketing
 * and docs indexable" is one URL, and everything else is either an API route or
 * the inspector.
 *
 * Kept in step with `INDEXABLE_PATHS` in src/proxy.ts and with
 * `INDEXABLE_PATHS` in src/app/sitemap.ts; tests/surface/surface.test.ts fails
 * if these three disagree.
 */

/**
 * Denied for every crawler.
 *
 * Note this is the robots.txt half of the defence and is NOT the primary one —
 * `/api/*` responses already carry `X-Robots-Tag: noindex, nofollow` from
 * src/proxy.ts, which is what actually binds a compliant crawler. robots.txt is
 * a crawl-budget hint; the header is an instruction attached to the response.
 * Both are set because they fail independently: robots.txt cannot be scoped by
 * session, and a crawler that honours headers but ignores robots.txt still gets
 * nothing.
 */
export const NO_INDEX = [
  "/api/",     // every route handler, including the operator-only ones
  "/v1/",      // the headless aliases rewritten to /api/* by next.config.ts
  "/inspector",// signature debug tool — operator material
  "/__clerk/", // Clerk's internal proxy paths
  "/_next/",   // build output, never content
] as const;

/**
 * Trainers and AI crawlers get nothing at all.
 *
 * Preserved from the previous public/robots.txt verbatim. The reasoning is not
 * "we dislike AI" — it is that /api/console/* returns the audit chain and the
 * Command Center feed, and training corpora are a poor place for a tamper-
 * evident evidence chain that a pilot bank will later ask us to attest to.
 */
const AI_CRAWLERS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"] as const;

/**
 * Absolute origin for the sitemap URL.
 *
 * `robots.txt` and `sitemap.xml` must be absolute, and this build has no
 * `metadataBase` (src/app/layout.tsx does not set one). So the origin is
 * derived here instead.
 *
 * Resolution order, and the reason it is not simply `SITE_ADDRESS`:
 *   1. `NEXT_PUBLIC_SITE_URL` — the correct answer. Not currently present in
 *      .env.example; see docs/SURFACE.md, this is the one-line config gap that
 *      makes the emitted sitemap correct in production.
 *   2. `SITE_ADDRESS` — the bare hostname Caddy issues TLS for, so it must be
 *      promoted to an https:// origin.
 *   3. `http://localhost:3000` — the dev fallback, so a local build emits a
 *      parseable file instead of throwing.
 */
export function siteOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const host = process.env.SITE_ADDRESS?.trim();
  if (!host || host === "localhost") return "http://localhost:3000";
  return `https://${host}`;
}

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        // Marketing + docs (all of `/`) are allowed; the API and the inspector
        // are not. `allow: "/"` plus specific `disallow` entries is the standard
        // longest-match-wins form.
        userAgent: "*",
        allow: "/",
        disallow: [...NO_INDEX],
      },
      {
        // Deny-all for AI crawlers. No `allow` — the absence of an allow rule
        // means "nothing is permitted", which is what these need.
        userAgent: [...AI_CRAWLERS],
        disallow: "/",
      },
    ],
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}