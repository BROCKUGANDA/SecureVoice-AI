/**
 * Ambient declarations for module specifiers that exist at runtime but not on
 * disk — the cache-busting `?query` suffixes this suite uses to force a module
 * to re-evaluate under a different `process.env`.
 *
 * `moduleResolution: "bundler"` resolves `../../next.config` to
 * `next.config.ts` and then rejects the `?csp-production` suffix, because for
 * TypeScript that is a different specifier with no file behind it. For Bun it is
 * the same module: the query part is ignored at resolution time and only makes
 * the import cache miss, which is exactly the behaviour the CSP test depends on
 * (see `tests/surface/surface.test.ts`).
 *
 * Without this the test typechecked only by accident of a loose import, and the
 * shape of the imported value was `any` — so a change to `headers()`'s return
 * type would be invisible here.
 */
declare module "*/next.config?csp-production" {
  const config: {
    headers?: () => Promise<{ headers: { key: string; value: string }[] }[]>;
  };
  export default config;
}
