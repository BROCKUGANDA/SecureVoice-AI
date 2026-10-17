/**
 * A production database connection must be encrypted.
 *
 * `DATABASE_URL` is passed to the pool verbatim, so a URL without an SSL mode
 * sends every case row, transcript and phone number across the network in
 * plaintext — while everything above it (Caddy, HSTS, CSP) makes the deployment
 * LOOK TLS-protected. The one place a plaintext hop is defensible is a private
 * network the operator controls, so that case is allowed only by explicit
 * opt-in rather than by silence.
 *
 * Pure: no I/O, no server imports. The env is injectable so the gate's own
 * test can drive every branch without touching process.env.
 */
export function assertTransportIsEncrypted(
  url: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!url) return; // the pool's own error is more specific than ours
  if (env.NODE_ENV !== "production") return;
  if (env.DB_ALLOW_PLAINTEXT_PRIVATE_NETWORK === "true") return;

  const mode = /[?&]sslmode=([^&]+)/.exec(url)?.[1]?.toLowerCase();
  const encrypted = mode === "require" || mode === "verify-ca" || mode === "verify-full";
  if (!encrypted) {
    throw new Error(
      "DATABASE_URL must set sslmode=require (or verify-ca/verify-full) in production. " +
        "Case rows, transcripts and phone numbers would otherwise cross the network in " +
        "plaintext. On a private network you control, set " +
        "DB_ALLOW_PLAINTEXT_PRIVATE_NETWORK=true to acknowledge that explicitly.",
    );
  }
}

/**
 * If the URL names a trust anchor, the anchor has to be in the image.
 *
 * WHY THIS EXISTS SEPARATELY. `verify-full` is the strongest mode this repo
 * allows, and it is only strongest when the named CA file is actually readable.
 * Measured on production 2026-10-17: the `worker` Dockerfile stage copied `src/`,
 * `prisma/`, `scripts/` and `node_modules` but never `supabase-ca.crt`, while
 * every worker's `DATABASE_URL` ends in `sslrootcert=supabase-ca.crt`. The dial
 * worker then failed *every query* with `ENOENT: no such file or directory, open
 * 'supabase-ca.crt'` — 57,053 times in its container's lifetime, once per poll
 * tick, at error level, while `/api/health` reported `ok: true` because the web
 * tier's image did have the file. A second image, built six days earlier and
 * therefore accidentally carrying the anchor, was the only worker that worked.
 *
 * The failure shape is the point: an unverified TLS mode is not a degraded
 * connection, it is no connection at all, and a long-running process that
 * retries it once a second is indistinguishable from a healthy one from outside.
 * So this refuses at boot, naming the file.
 *
 * `exists` is injected to keep the function pure and testable — the same reason
 * `env` is a parameter above.
 */
export function assertTrustAnchorPresent(url: string, exists: (path: string) => boolean): void {
  if (!url) return;
  const anchor = /[?&]sslrootcert=([^&]+)/.exec(url)?.[1];
  if (!anchor) return;
  if (!exists(anchor)) {
    throw new Error(
      `DATABASE_URL demands sslrootcert=${anchor} but that file is not present in this ` +
        `image/working directory. TLS verification cannot succeed without it, so every ` +
        `query would fail with ENOENT while the process keeps running. Build the image ` +
        `with the certificate copied in (see scripts/copy-standalone.mjs for the app tier ` +
        `and the Dockerfile's worker stage for the rest), or set sslmode=require only if ` +
        `the chain is verified some other way.`,
    );
  }
}
