/**
 * Browser-safe configuration. NEXT_PUBLIC_* vars are inlined by the Next.js
 * compiler at build time; everything server-side goes through src/lib/config.ts.
 */
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "otemaach@gmail.com";
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
