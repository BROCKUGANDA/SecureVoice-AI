/**
 * The release version, for anything that renders or reports it.
 *
 * ## Where the number comes from
 *
 * `package.json` `version`, read at BUILD time by `next.config.ts` and inlined as
 * `NEXT_PUBLIC_APP_VERSION`. Nothing in the UI types a version string, so the
 * displayed number cannot drift from the artifact that was actually built: bump
 * package.json — `bun run version:bump 0.4.0`, or the release workflow, which
 * already treats the TAG as the authority — and the next build re-injects it
 * everywhere it is shown.
 *
 * That is the "update the version after every major upgrade" requirement
 * satisfied by construction. A hand-edited footer string is the version that is
 * wrong six weeks later, on the page a judge or a bank is looking at.
 *
 * ## Why there is a fallback rather than a throw
 *
 * `"0.0.0-dev"` appears only when the value is genuinely absent — a raw `bun test`
 * of a module imported outside a Next build, or a tool that bypasses the config.
 * A missing cosmetic string must not fail a build or a request; a WRONG one is
 * worse than an obviously-placeholder one, which is why the fallback is loud.
 */
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0-dev";

/**
 * True when the value is the build-time placeholder rather than a real release
 * number. Callers that want to hide the version instead of printing "0.0.0-dev"
 * in front of a customer can branch on this.
 */
export const APP_VERSION_IS_PLACEHOLDER: boolean = APP_VERSION === "0.0.0-dev";

/**
 * Display form: `v0.2.1`. Kept in one place so every surface renders it alike.
 *
 * Takes the value as an argument rather than reading the module constant so a
 * caller — and a test — can render an arbitrary version without depending on
 * what the build happened to inject. The UI passes APP_VERSION.
 */
export function versionLabel(version: string = APP_VERSION): string {
  return version.startsWith("v") ? version : `v${version}`;
}

/** Release version, for the status page and the health probe. */
export function deployedVersion(): string {
  // A promoted blue/green image tag wins: `docker-compose.bluegreen.yml` sets
  // SECUREVOICE_RELEASE to the tag being served, so a rollback can prove WHICH
  // build is answering rather than trusting the tag written in a compose file.
  // This variable was previously set by compose and read by nothing.
  const release = process.env.SECUREVOICE_RELEASE?.trim();
  if (release) {
    const tag = release.includes(":") ? release.slice(release.lastIndexOf(":") + 1) : release;
    const cleaned = tag.replace(/^v/, "").trim();
    if (cleaned) return cleaned;
  }
  // Otherwise the build-time value from package.json. NOTE: deliberately NOT
  // `process.env.npm_package_version` — that variable is set by NPM when it runs
  // a script, and this deployment runs under BUN (`bun server.js` in the
  // container), so it is always undefined in production. Reading it meant the
  // status page fell through to a hardcoded literal and reported the same
  // version forever, no matter how many releases shipped.
  return APP_VERSION;
}

