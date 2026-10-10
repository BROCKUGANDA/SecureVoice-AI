import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-origin";

/**
 * Re-exported, not reimplemented.
 *
 * This file used to carry its own copy of the origin-resolution logic, held in
 * agreement with a copy in sitemap.ts by a surface test. Now that layout.tsx
 * needs the same answer for `metadataBase` there are three consumers — so the
 * logic lives once in src/lib/site-origin.ts and is re-exported here under the
 * name the surface test already imports. That file documents the resolution
 * order and why the trailing slash is stripped.
 */
export { siteOrigin };

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
  "/api/", // every route handler, including the operator-only ones
  "/v1/", // the headless aliases rewritten to /api/* by next.config.ts
  "/inspector", // signature debug tool — operator material
  "/api/auth/", // Better Auth endpoints, already covered by /api/ but explicit
  "/_next/", // build output, never content
] as const;

/**
 * Crawlers that exist to build a SEARCH INDEX, which is how an answer engine
 * finds a page to cite. These are allowed, deliberately.
 *
 * This rule is new, and it reverses part of what used to be here. The previous
 * version was a single `disallow: "/"` for GPTBot, ClaudeBot, PerplexityBot and
 * Google-Extended, on the reasoning that /api/console/* returns the audit chain
 * and the Command Center feed, and that a tamper-evident evidence chain is a
 * poor thing to have in a training corpus.
 *
 * That reasoning was sound but it was aimed at the wrong thing, for two reasons.
 *
 *  1. **It did not protect what it claimed to.** `/api/` is already in `NO_INDEX`
 *     for EVERY crawler in the rule above, so no AI crawler could reach the audit
 *     chain through this site whether or not this rule existed. The blanket deny
 *     bought no protection; it only cost reach.
 *  2. **It blocked exactly the audience this site is written for.** `robots.txt`
 *     is how a crawler is told it may fetch a page. Denying the search index of
 *     an answer engine means "SecureVoice AI is not citable" — the opposite of
 *     what the FAQ, the pricing page and the JSON-LD are for. A product page that
 *     no answer engine is allowed to read cannot win an answer.
 *
 * So: allow the indexers, and let the path rules do the protecting. `OAI-SearchBot`
 * and `ChatGPT-User` are OpenAI's search index and its user-initiated fetch;
 * `PerplexityBot` is Perplexity's index. `ClaudeBot` is included because Anthropic
 * uses it to serve answers; if that ever needs to change, split it here — do NOT
 * re-add a blanket deny.
 */
const SEARCH_CRAWLERS = ["OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "ClaudeBot"] as const;

/**
 * Crawlers whose only job is to build a TRAINING corpus. These still get nothing.
 *
 * This is the distinction the previous single rule blurred. `GPTBot` (OpenAI's
 * training crawler) and `Google-Extended` (which governs Gemini training and
 * Vertex grounding) are not the same agents as the search indexers above, and a
 * site can reasonably be quotable in an answer while declining to be training
 * material. Keep this rule and keep it narrow: it is the one that still expresses
 * the original intent.
 *
 * If the operator wants to be in training corpora too, the change is to delete
 * this rule — not to widen the deny above it.
 */
const TRAINING_CRAWLERS = ["GPTBot", "Google-Extended"] as const;

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
        // Search/answer indexers: permitted, and re-stating the path disallows so
        // the rule stands on its own rather than depending on which rule a
        // particular crawler happens to match. Longest-match-wins means the
        // specific `disallow` entries still beat `allow: "/"`.
        userAgent: [...SEARCH_CRAWLERS],
        allow: "/",
        disallow: [...NO_INDEX],
      },
      {
        // Training-only crawlers. No `allow` — the absence of an allow rule means
        // "nothing is permitted", which is what these need.
        userAgent: [...TRAINING_CRAWLERS],
        disallow: "/",
      },
    ],
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
