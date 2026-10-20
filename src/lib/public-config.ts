/**
 * Browser-safe configuration. NEXT_PUBLIC_* vars are inlined by the Next.js
 * compiler at build time; everything server-side goes through src/lib/config.ts.
 */

/**
 * Contact addresses across the public surface.
 *
 * These are Namecheap Private Email mailboxes on `securevoiceai.me` (the domain
 * the platform actually sends from), NOT a personal address and NOT the
 * `securevoice.ai` lookalike, which resolves to an unrelated third party.
 *
 *   support@  — product, billing, security and privacy questions; the reply-to
 *               on every transactional email, so a bounce reaches a monitored box
 *   legal@    — DPAs, PDPL/GDPR requests, terms and law-enforcement contact
 *   founder@  — direct line published on the deck and the pitch material
 *
 * Override any of them with NEXT_PUBLIC_*_EMAIL at build time.
 */
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@securevoiceai.me";
export const LEGAL_EMAIL = process.env.NEXT_PUBLIC_LEGAL_EMAIL ?? "legal@securevoiceai.me";
export const FOUNDER_EMAIL = process.env.NEXT_PUBLIC_FOUNDER_EMAIL ?? "founder@securevoiceai.me";

/**
 * Fallback origin for server-rendered API examples.
 *
 * This used to default to `https://api.securevoice.ae`, which does not resolve:
 * `securevoice.ae` and `api.securevoice.ae` are both NXDOMAIN. It survived
 * because the only consumer, src/views/Docs.tsx, prefers
 * `window.location.origin` in the browser, so nobody saw it until the page was
 * server-rendered and the generated curl commands pointed at a host that cannot
 * be dialled.
 *
 * A second dead default sat beside it in several files: `https://securevoice.ai`,
 * which now 301-redirects to an unrelated third-party product. A bank copying a
 * curl line out of the docs would have called that stranger's endpoint.
 *
 * The deployment origin is the one BETTER_AUTH_URL is set to. Keep these in step:
 * if the public hostname moves, change it in .env AND here.
 *
 * This is a literal, not `process.env.BETTER_AUTH_URL`: only NEXT_PUBLIC_* is
 * inlined into the client bundle, so a server-only var read here would be
 * `undefined` in the browser rather than falling through to this default.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE ?? "https://securevoiceai.me";

/**
 * How often the console's Pilot panel refreshes, in milliseconds.
 *
 * It is a build-time value because it reaches a client component, and
 * `NEXT_PUBLIC_*` is the only thing the compiler inlines into the browser
 * bundle. The default is fifteen seconds: long enough that the panel is not a
 * chatty request generator against the status route, short enough that an
 * operator watching a live pilot sees the counters move.
 *
 * A malformed value takes the default rather than becoming `NaN` — a panel
 * that polls every NaN milliseconds is worse than one that polls every
 * fifteen seconds.
 */
export const PILOT_POLL_INTERVAL_MS = (() => {
  const raw = Number(process.env.NEXT_PUBLIC_PILOT_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 1_000 && raw <= 600_000 ? raw : 15_000;
})();
