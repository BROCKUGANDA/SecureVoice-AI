import { env } from "@/lib/config";

/**
 * The one place that decides what this site's canonical origin is.
 *
 * It used to be duplicated — `siteOrigin()` was written out in full in both
 * `src/app/robots.ts` and `src/app/sitemap.ts` — and `tests/surface/surface.test.ts`
 * carried a test (`robots and sitemap derive the same origin`) whose only job was
 * to catch the two copies drifting apart. That is the shape a bug takes when
 * three consumers need the same answer: the first two get their own copies, and
 * the third (`layout.tsx`, which needs it for `metadataBase`) would have been a
 * third. That test would have been extended rather than the duplication fixed.
 *
 * Both route files still export it under the name the test imports
 * (`siteOrigin`), so nothing downstream had to move.
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_SITE_URL` — the correct answer, and the one to set in
 *      production. It is a NEXT_PUBLIC_ var so the client bundle can read it too.
 *   2. `SITE_DOMAIN` — the bare hostname, promoted to an https:// origin.
 *   3. `SITE_ADDRESS` — the deployment's canonical hostname, promoted to https.
 *      This is the one that quietly publishes a `*.sslip.io` stand-in; see
 *      `siteOriginIsPlaceholder` below. (Caddy does not read this variable —
 *      its site list is literal, see `Caddyfile` / `sites.d/`.)
 *   4. `env.appBaseUrl` — the dev fallback (`http://localhost:3000`), so a local
 *      build emits a parseable file instead of throwing.
 *
 * The trailing-slash strip matters because `metadataBase` concatenates: a base
 * ending in `/` plus a path starting with `/` yields `https://host//path`, which
 * is a valid URL that resolves somewhere else entirely.
 */
/**
 * Hosts that can serve a deployment but must never be its published identity.
 *
 * `57.130.80.158.sslip.io` is the classic one: a wildcard DNS service that maps an
 * IP to a name, so Caddy can issue a certificate before the real domain exists. It
 * is perfect for TLS and terrible as a canonical origin — and the failure is
 * invisible. Every `<link rel="canonical">`, every `<loc>` in the sitemap, and the
 * `Sitemap:` line in robots.txt then name a DIFFERENT domain from the one the
 * browser is on, and a crawler that is told the real page lives elsewhere does
 * exactly that: it indexes the other one, or neither. A site can be crawlable,
 * correct, and permanently unrankable at the same time.
 *
 * Dynamic-DNS and raw-IP forms are enumerated rather than pattern-guessed, because
 * the list is short and a false negative here costs months of invisibility.
 */
const PLACEHOLDER_HOSTS =
  /(^|\.)(sslip\.io|nip\.io|travellin\.com|dedyn\.io|vcap\.me|cloudfront\.net|ngrok\.(io|app)|loca\.lt|trycloudflare\.com)$/i;

/** The host part of an origin, or null when the value is not an origin. */
function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the published origin is a stand-in (dynamic DNS, a bare IP, or
 * loopback) rather than a domain this product owns.
 *
 * Nothing in the app changes behaviour on this — it is deliberately a diagnostic,
 * not a switch. Silently falling back to the request's own `Host` would fix the
 * canonical and open the mirror-image hole: whoever forges the header decides which
 * domain the site says is canonical, which is an SEO hijack through the front door.
 */
export function siteOriginIsPlaceholder(): boolean {
  const host = hostOf(siteOrigin());
  if (!host) return true;
  return (
    host === "localhost" ||
    host.endsWith(".local") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) === true ||
    PLACEHOLDER_HOSTS.test(host)
  );
}

export function siteOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  // `SITE_DOMAIN` is the bare-hostname spelling of the same answer, for an operator
  // who already sets `SITE_ADDRESS` for the app and does not want to compose an
  // `https://` string into a second variable.
  const domain = process.env.SITE_DOMAIN?.trim();
  if (domain) return `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

  const host = process.env.SITE_ADDRESS?.trim();
  if (!host || host === "localhost") return env.appBaseUrl.replace(/\/+$/, "");
  return `https://${host}`;
}

/**
 * True only for an absolute http(s) URL on this deployment's own origin.
 *
 * Anywhere a caller-supplied URL is handed to something that redirects a real
 * person — Paddle's `settings.return_url` after a completed payment, an auth
 * magic link — an unvalidated `z.string().url()` is an open redirect: the
 * attacker supplies the destination, and the victim arrives there from a
 * trusted domain, with a payment or a session already behind them.
 *
 * `javascript:` and `data:` satisfy `URL` parsing, so the scheme is checked
 * rather than assumed.
 */
export function isSameOriginAsSite(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return url.origin === siteOrigin();
}
