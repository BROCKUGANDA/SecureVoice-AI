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
 *   2. `SITE_ADDRESS` — the bare hostname Caddy issues TLS for, promoted to an
 *      https:// origin.
 *   3. `env.appBaseUrl` — the dev fallback (`http://localhost:3000`), so a local
 *      build emits a parseable file instead of throwing.
 *
 * The trailing-slash strip matters because `metadataBase` concatenates: a base
 * ending in `/` plus a path starting with `/` yields `https://host//path`, which
 * is a valid URL that resolves somewhere else entirely.
 */
export function siteOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const host = process.env.SITE_ADDRESS?.trim();
  if (!host || host === "localhost") return env.appBaseUrl.replace(/\/+$/, "");
  return `https://${host}`;
}
