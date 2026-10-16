import "server-only";
/**
 * The version this process is actually serving, as opposed to the one it was built
 * as.
 *
 * ── Why this is a separate module ────────────────────────────────────────────
 * `src/lib/version.ts` is imported by `src/components/shell/Footer.tsx`, a
 * `"use client"` component, so it sits in the client import graph and must contain
 * nothing but the build-time `NEXT_PUBLIC_APP_VERSION` the Next compiler inlines.
 *
 * It used to also hold `deployedVersion()`, which reads `SECUREVOICE_RELEASE` — a
 * server-only variable. That worked only because `deployedVersion()` happened not
 * to be called from any client-reachable module, so the bundler dropped it. "It is
 * tree-shaken" is not a boundary: the day someone imports `deployedVersion()` from
 * a component, the read becomes live and a non-public variable is in the browser
 * bundle, with nothing failing. `tests/surface/server-client-boundary.test.ts` is
 * the gate that makes the distinction checkable rather than remembered.
 *
 * So the server-only read lives here, where the `server-only` marker actually
 * means something, and the client-safe constant stays where the UI needs it.
 */

/**
 * Release version, for the status page and the health probe.
 *
 * A promoted blue/green image tag wins: `docker-compose.bluegreen.yml` sets
 * SECUREVOICE_RELEASE to the tag being served, so a rollback can prove WHICH build
 * is answering rather than trusting the tag written in a compose file.
 *
 * Otherwise the build-time value from package.json. NOTE: deliberately NOT
 * `process.env.npm_package_version` — that variable is set by NPM when it runs a
 * script, and this deployment runs under BUN (`bun server.js` in the container), so
 * it is always undefined in production. Reading it meant the status page fell
 * through to a hardcoded literal and reported the same version forever, no matter
 * how many releases shipped.
 */
export function deployedVersion(fallback: string): string {
  const release = process.env.SECUREVOICE_RELEASE?.trim();
  if (release) {
    const tag = release.includes(":") ? release.slice(release.lastIndexOf(":") + 1) : release;
    const cleaned = tag.replace(/^v/, "").trim();
    if (cleaned) return cleaned;
  }
  return fallback;
}
